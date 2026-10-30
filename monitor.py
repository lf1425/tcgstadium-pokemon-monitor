#!/usr/bin/env python3
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state.json"
COLLECTION = "https://tcg-stadium.com/collections/english-sealed-products"
WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
HEADERS = {"User-Agent": "PersonalTCGProductMonitor/1.0 (+GitHub Actions)"}
EASTERN = ZoneInfo("America/New_York")
HEARTBEAT_HOURS = (0, 8, 12, 16, 20)


def get_products():
    products = []
    try:
        response = requests.get(
            COLLECTION + "/products.json?limit=250",
            headers=HEADERS,
            timeout=25,
        )
        if response.ok:
            products = response.json().get("products", [])
    except Exception as exc:
        print("Shopify JSON endpoint unavailable:", exc)

    if not products:
        response = requests.get(COLLECTION, headers=HEADERS, timeout=25)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        seen = set()
        for link in soup.select('a[href*="/products/"]'):
            match = re.search(r"/products/([^/?#]+)", link.get("href", ""))
            if not match or match.group(1) in seen:
                continue
            handle = match.group(1)
            seen.add(handle)
            title = link.get_text(" ", strip=True) or handle.replace("-", " ").title()
            nearby_text = link.parent.get_text(" ", strip=True)
            price_match = re.search(r"\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)", nearby_text)
            products.append({
                "handle": handle,
                "title": title,
                "variants": [{
                    "price": price_match.group(1).replace(",", "") if price_match else None
                }],
            })

    result = {}
    for product in products:
        handle = product.get("handle") or str(product.get("id", ""))
        if not handle:
            continue
        variants = product.get("variants", [])
        prices, stock_values = [], []
        for variant in variants:
            try:
                if variant.get("price") is not None:
                    prices.append(float(variant["price"]))
            except (ValueError, TypeError):
                pass
            if variant.get("available") is not None:
                stock_values.append(bool(variant["available"]))
        result[handle] = {
            "title": product.get("title") or handle,
            "price": min(prices) if prices else None,
            "available": any(stock_values) if stock_values else None,
            "url": urljoin("https://tcg-stadium.com/", "products/" + handle),
        }

    if not result:
        raise RuntimeError(
            "No products found. The store layout or product endpoint may have changed."
        )
    return result


def format_price(value):
    return f"${value:,.2f}" if value is not None else "Unavailable"


def send_message(content):
    if not WEBHOOK:
        raise RuntimeError("Missing DISCORD_WEBHOOK_URL repository secret.")
    response = requests.post(WEBHOOK, json={"content": content}, timeout=20)
    response.raise_for_status()


def send_alert(title, description, item, color):
    if not WEBHOOK:
        raise RuntimeError("Missing DISCORD_WEBHOOK_URL repository secret.")

    stock = (
        "In stock" if item["available"] is True
        else "Sold out" if item["available"] is False
        else "Unknown"
    )
    embed = {
        "title": title[:256],
        "url": item["url"],
        "description": description[:4000],
        "color": color,
        "fields": [
            {"name": "Price", "value": format_price(item["price"]), "inline": True},
            {"name": "Availability", "value": stock, "inline": True},
        ],
        "footer": {"text": "TCGStadium English Sealed Products Monitor"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    response = requests.post(WEBHOOK, json={"embeds": [embed]}, timeout=20)
    response.raise_for_status()


def send_heartbeat_if_due(state):
    now = datetime.now(EASTERN)
    slot = now.strftime("%Y-%m-%d %H:00")

    # The first successful scan after this feature is installed sends a
    # one-time test message. It also marks the current checkpoint as covered,
    # if the test happens during one of the regular heartbeat hours.
    if not state.get("heartbeat_test_sent"):
        send_message(
            "⚡ **Pokémon Trainer Check-In — Test Successful!**\n"
            "Your TCGStadium monitor completed a scan and is online. "
            "No new Pokémon caught yet unless a separate product alert just arrived. "
            "Next trainer check-in: 8 AM, noon, 4 PM, 8 PM, or midnight Eastern."
        )
        state["heartbeat_test_sent"] = True
        if now.hour in HEARTBEAT_HOURS:
            state["last_heartbeat_slot"] = slot
        print("Sent one-time heartbeat test message.")
        return

    if now.hour in HEARTBEAT_HOURS and state.get("last_heartbeat_slot") != slot:
        send_message(
            "⚡ **Pokémon Trainer Check-In!**\n"
            "No new Pokémon caught yet! Your TCGStadium monitor just completed "
            "a successful scan. Keep those Poké Balls ready!"
        )
        state["last_heartbeat_slot"] = slot
        print(f"Sent scheduled heartbeat for {slot} Eastern.")


def main():
    current = get_products()
    try:
        old_state = json.loads(STATE.read_text()) if STATE.exists() else {}
    except (OSError, json.JSONDecodeError):
        old_state = {}

    previous = old_state.get("products", {})
    if not old_state.get("initialized"):
        new_state = {
            "initialized": True,
            "products": current,
            **{
                key: value for key, value in old_state.items()
                if key.startswith("heartbeat_") or key == "last_heartbeat_slot"
            },
        }
        STATE.write_text(json.dumps(new_state, indent=2))
        send_message(
            "✅ TCGStadium monitor is online. "
            f"Baseline saved for {len(current)} English sealed products."
        )
        send_heartbeat_if_due(new_state)
        STATE.write_text(json.dumps(new_state, indent=2))
        print(f"Initial baseline saved for {len(current)} products.")
        return

    events = []
    for handle, item in current.items():
        old = previous.get(handle)
        if old is None:
            events.append((
                "🆕 New Pokémon sealed product",
                f"**{item['title']}** is newly listed.",
                item,
                0x2ECC71,
            ))
            continue

        if old.get("available") is False and item["available"] is True:
            events.append((
                "🔥 Pokémon product restocked",
                f"**{item['title']}** changed from sold out to available.",
                item,
                0xE67E22,
            ))

        old_price, new_price = old.get("price"), item.get("price")
        if old_price is not None and new_price is not None:
            if abs(float(old_price) - float(new_price)) >= 0.01:
                title = (
                    "📉 Pokémon product price drop"
                    if new_price < old_price
                    else "💹 Pokémon product price increase"
                )
                events.append((
                    title,
                    f"**{item['title']}**: {format_price(old_price)} → {format_price(new_price)}",
                    item,
                    0x3498DB,
                ))

    new_state = {
        "initialized": True,
        "products": current,
        **{
            key: value for key, value in old_state.items()
            if key.startswith("heartbeat_") or key == "last_heartbeat_slot"
        },
    }

    # Product changes are still processed exactly as before.
    for event in events:
        send_alert(*event)

    # Heartbeats only follow a successful product scan.
    send_heartbeat_if_due(new_state)

    # Persist product state and heartbeat schedule together.
    STATE.write_text(json.dumps(new_state, indent=2))
    print(f"Scanned {len(current)} products; sent {len(events)} product alert(s).")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("MONITOR ERROR:", exc, file=sys.stderr)
        raise
