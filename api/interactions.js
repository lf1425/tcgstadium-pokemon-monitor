import nacl from "tweetnacl";
export const config = { api: { bodyParser: false } };
async function raw(req){const chunks=[];for await(const c of req)chunks.push(Buffer.from(c));return Buffer.concat(chunks);}
const b=(label,custom_id,style=1)=>({type:2,style,label,custom_id});
const r=(...components)=>({type:1,components});
const home=()=>({embeds:[{title:"🎒 Pokémon Inventory Assistant",description:"Choose a category to browse the latest successful TCG Stadium scan.",color:0x3B82F6,footer:{text:"TCG Stadium • English sealed products"}}],components:[r(b("Inventory","view:inventory"),b("In Stock","view:stock"),b("Lowest Prices","view:deals")),r(b("Booster Boxes","view:boxes"),b("ETBs","view:etbs"),b("Price Drops","view:drops"))]});
async function state(){const u=process.env.STATE_JSON_URL||"https://raw.githubusercontent.com/lf1425/tcgstadium-pokemon-monitor/main/state.json";const x=await fetch(u,{headers:{"cache-control":"no-cache"}});if(!x.ok)throw Error("state unavailable");return x.json();}
const money=v=>typeof v==="number"?"$"+v.toFixed(2):"Price unavailable";
function listing(items,view,page=0){let a=items.filter(p=>view!=="stock"||p.available===true).filter(p=>view!=="boxes"||/booster box|booster-box/i.test(p.title||"")).filter(p=>view!=="etbs"||/elite trainer box|\betb\b/i.test(p.title||""));if(view==="deals")a.sort((x,y)=>(x.price??Infinity)-(y.price??Infinity));else a.sort((x,y)=>(x.title||"").localeCompare(y.title||""));const size=5,pages=Math.max(1,Math.ceil(a.length/size));page=Math.max(0,Math.min(page,pages-1));const part=a.slice(page*size,(page+1)*size);if(view==="drops")return{embeds:[{title:"📉 Price Drops",description:"Price-drop alerts are sent automatically, but the current state file does not retain price history, so past drops cannot be listed here yet.",color:0xE67E22}],components:[r(b("⬅ Main Menu","nav:home"))]};const desc=part.length?part.map((p,i)=>"**"+(page*size+i+1)+". "+p.title+"**\n"+money(p.price)+" • "+(p.available===true?"🟢 In stock":p.available===false?"🔴 Sold out":"⚪ Unknown")).join("\n\n"):"No matching products are currently recorded.";const rows=[];for(let i=0;i<part.length;i+=5)rows.push(r(...part.slice(i,i+5).map((p,j)=>b(String(page*size+i+j+1),"item:"+p.handle,2))));const nav=[];if(page>0)nav.push(b("⬅ Previous","page:"+view+":"+(page-1)));nav.push(b("Main Menu","nav:home"));if(page<pages-1)nav.push(b("Next ➡","page:"+view+":"+(page+1)));rows.push(r(...nav));const titles={inventory:"All Tracked Products",stock:"Currently In Stock",deals:"Lowest Listed Prices",boxes:"Booster Boxes",etbs:"Elite Trainer Boxes"};return{embeds:[{title:"📦 "+(titles[view]||"Products"),description:desc+(view==="deals"?"\n\n*Sorted by listed price—not verified against MSRP or market value.*":""),color:0x3B82F6,footer:{text:"Page "+(page+1)+" of "+pages+" • "+a.length+" products"}}],components:rows};}
async function render(id){if(id==="nav:home")return home();const s=await state();const items=Object.entries(s.products||{}).map(([handle,p])=>({handle,...p}));if(id.startsWith("item:")){const p=items.find(x=>x.handle===id.slice(5));if(!p)return{content:"That product is no longer in the monitor data.",components:[r(b("Main Menu","nav:home"))]};return{embeds:[{title:p.title,url:p.url,description:"**Price:** "+money(p.price)+"\n**Availability:** "+(p.available===true?"🟢 In stock":p.available===false?"🔴 Sold out":"⚪ Unknown"),color:p.available===true?0x2ECC71:0xE67E22}],components:[r({type:2,style:5,label:"View Product",url:p.url},b("⬅ Back to Inventory","view:inventory"))]};}if(id.startsWith("page:")){const[,v,n]=id.split(":");return listing(items,v,Number(n)||0);}if(id.startsWith("view:"))return listing(items,id.slice(5),0);return home();}
export default async function handler(req,res){
  if(req.method!=="POST") return res.status(405).send("Method not allowed");
  console.log("Discord interaction POST received");
  const body=await raw(req);
  const timestamp=req.headers["x-signature-timestamp"]||"";
  const signature=req.headers["x-signature-ed25519"]||"";
  const publicKey=process.env.DISCORD_PUBLIC_KEY||"";
  console.log("Discord signature check inputs", {bodyBytes:body.length,hasTimestamp:!!timestamp,signatureLength:signature.length,publicKeyLength:publicKey.length});
  let ok=false;
  try {
    ok=!!timestamp && signature.length===128 && publicKey.length===64 &&
      nacl.sign.detached.verify(Buffer.concat([Buffer.from(timestamp),body]),Buffer.from(signature,"hex"),Buffer.from(publicKey,"hex"));
  } catch(error) {
    console.error("Discord signature verification threw:",error);
  }
  if(!ok) {
    console.error("Discord signature verification failed");
    return res.status(401).send("Invalid signature");
  }let interaction;try{interaction=JSON.parse(body.toString("utf8"));}catch{return res.status(400).send("Invalid JSON");}if(interaction.type===1)return res.status(200).json({type:1});if(interaction.type===3){
  // Acknowledge the component immediately so Discord's 3-second deadline is met.
  res.status(200).json({type:6});
  try {
    const payload=await render(interaction.data?.custom_id||"");
    const editUrl="https://discord.com/api/v10/webhooks/"+interaction.application_id+"/"+interaction.token+"/messages/@original";
    const edited=await fetch(editUrl,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    if(!edited.ok) console.error("Discord message update failed:",edited.status,await edited.text());
  } catch(error) {
    console.error("Button interaction failed:",error);
    const editUrl="https://discord.com/api/v10/webhooks/"+interaction.application_id+"/"+interaction.token+"/messages/@original";
    await fetch(editUrl,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:"I couldn't load the monitor data. Please try again.",components:[{type:1,components:[{type:2,style:1,label:"Main Menu",custom_id:"nav:home"}]}]})}).catch(()=>{});
  }
  return;
}return res.status(200).json({type:4,data:{content:"Unsupported interaction.",flags:64}});}
