import nacl from "tweetnacl";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function verifyDiscordRequest(rawBody, signature, timestamp, publicKey) {
  if (!signature || !timestamp || !publicKey) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.concat([Buffer.from(timestamp), rawBody]),
      Buffer.from(signature, "hex"),
      Buffer.from(publicKey, "hex")
    );
  } catch {
    return false;
  }
}

function button(label, custom_id, style = 1) {
  return { type: 2, style, label, custom_id };
}

function row(...components) {
  return { type: 1, components };
}

function mainMenu() {
  return {
    embeds: [{
      title: "🎒 Pokémon Inventory Assistant",
      description: "Choose what you want to browse. These buttons use the latest successful TCG Stadium monitor scan.",
      color: 0x3B82F6,
      footer: { text: "TCG Stadium • English sealed products" }
    }],
    components: [
      row(button("Inventory", "view:inventory"), button("In Stock", "view:stock"), button("Lowest Prices", "view:deals")),
      row(button("Booster Boxes", "view:boxes"), button("ETBs", "view:etbs"), button("Price Drops", "view:drops"))
    ]
  };
}

async function getState() {
  const url = process.env.STATE_JSON_URL || "https://raw.githubusercontent.com/lf1425/tcgstadium-pokemon-monitor/main/state.json";
  const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error("Could not load the latest monitor data.");
  return response.json();
}

function matchesCategory(item, view) {
  const title = (item.title || "").toLowerCase();
  if (view === "stock") return item.available === true;
  if (view === "boxes") return /booster box|booster-box/.test(title);
  if (view === "etbs") return /elite trainer box|\betb\b/.test(title);
  return true;
}

function money(value) {
  return typeof value === "number" ? "$" + value.toFixed(2) : "Price unavailable";
}

function listView(products, view, page = 0) {
  let filtered = products.filter(p => matchesCategory(p, view));
  if (view === "deals") filtered.sort((a,b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  else filtered.sort((a,b) => (a.title || "").localeCompare(b.title || ""));
  const pageSize = 5;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const names = {
    inventory: "All Tracked Products",
    stock: "Currently In Stock",
    deals: "Lowest Listed Prices",
    boxes: "Booster Boxes",
    etbs: "Elite Trainer Boxes",
    drops: "Price Drops"
  };
  if (view === "drops") {
    return {
      embeds: [{
        title: "📉 Price Drops",
        description: "The monitor sends price-drop alerts when it detects a change, but its current state file does not retain price history. This view cannot reliably list past drops yet.",
        color: 0xE67E22
      }],
      components: [row(button("⬅ Back to Menu", "nav:home"))]
    };
  }
  const description = slice.length
    ? slice.map((p, i) => {
        const index = page * pageSize + i;
        const status = p.available === true ? "🟢 In stock" : p.available === false ? "🔴 Sold out" : "⚪ Unknown";
        return `**${index + 1}. ${p.title}**\n${money(p.price)} • ${status}`;
      }).join("\n\n")
    : "No matching products are currently recorded.";
  const components = slice.map((p, i) => button(String(page * pageSize + i + 1), `item:${p.handle}`, 2));
  const rows = [];
  for (let i = 0; i < components.length; i += 5) rows.push(row(...components.slice(i, i + 5)));
  const nav = [];
  if (page > 0) nav.push(button("⬅ Previous", `page:${view}:${page - 1}`));
  nav.push(button("Main Menu", "nav:home"));
  if (page < pages - 1) nav.push(button("Next ➡", `page:${view}:${page + 1}`));
  rows.push(row(...nav));
  return {
    embeds: [{
      title: `📦 ${names[view] || "Products"}`,
      description: view === "deals"
        ? description + "\n\n*Sorted by lowest listed price—not verified against MSRP or market value.*"
        : description,
      color: 0x3B82F6,
      footer: { text: `Page ${page + 1} of ${pages} • ${filtered.length} products` }
    }],
    components: rows
  };
}

async function render(customId) {
  if (customId === "nav:home") return mainMenu();
  const state = await getState();
  const products = Object.entries(state.products || {}).map(([handle, item]) => ({ handle, ...item }));
  if (customId.startsWith("item:")) {
    const handle = customId.slice(5);
    const item = products.find(p => p.handle === handle);
    if (!item) return { content: "That product is no longer in the latest monitor data.", components: [row(button("Main Menu", "nav:home"))] };
    return {
      embeds: [{
        title: item.title,
        url: item.url,
        description: `**Price:** ${money(item.price)}\n**Availability:** ${item.available === true ? "🟢 In stock" : item.available === false ? "🔴 Sold out" : "⚪ Unknown"}`,
        color: item.available === true ? 0x2ECC71 : 0xE67E22
      }],
      components: [row({ type: 2, style: 5, label: "View Product", url: item.url }, button("⬅ Back", "view:inventory"))]
    };
  }
  if (customId.startsWith("page:")) {
    const [, view, page] = customId.split(":");
    return listView(products, view, Number(page) || 0);
  }
  if (customId.startsWith("view:")) return listView(products, customId.slice(5), 0);
  return mainMenu();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  const rawBody = await readRawBody(req);
  const valid = verifyDiscordRequest(
    rawBody,
    req.headers["x-signature-ed25519"],
    req.headers["x-signature-timestamp"],
    process.env.DISCORD_PUBLIC_KEY
  );
  if (!valid) return res.status(401).send("Invalid request signature");

  let interaction;
  try { interaction = JSON.parse(rawBody.toString("utf8")); }
  catch { return res.status(400).send("Invalid JSON"); }

  if (interaction.type === 1) return res.status(200).json({ type: 1 });
  if (interaction.type === 3) {
    try {
      const payload = await render(interaction.data?.custom_id || "");
      return res.status(200).json({ type: 7, data: payload });
    } catch (error) {
      return res.status(200).json({
        type: 4,
        data: { content: "I couldn't load the monitor data just now. Please try Refresh in a moment.", flags: 64 }
      });
    }
  }
  return res.status(200).json({ type: 4, data: { content: "Unsupported interaction.", flags: 64 } });
}
