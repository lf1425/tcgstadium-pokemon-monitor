export default async function handler(req,res){
  if(req.method!=="POST")return res.status(405).send("Method not allowed");
  const auth=req.headers.authorization||"";
  if(!process.env.SETUP_SECRET||auth!=="Bearer "+process.env.SETUP_SECRET)return res.status(401).send("Unauthorized");
  const token=process.env.DISCORD_BOT_TOKEN,channel=process.env.DISCORD_CHANNEL_ID;
  if(!token||!channel)return res.status(500).json({error:"Missing bot configuration"});
  const button=(label,custom_id)=>({type:2,style:1,label,custom_id});
  const row=(...components)=>({type:1,components});
  const response=await fetch("https://discord.com/api/v10/channels/"+channel+"/messages",{method:"POST",headers:{Authorization:"Bot "+token,"Content-Type":"application/json"},body:JSON.stringify({embeds:[{title:"🎒 Pokémon Inventory Assistant",description:"Choose a category to browse the latest successful TCG Stadium scan.",color:0x3B82F6,footer:{text:"TCG Stadium • English sealed products"}}],components:[row(button("Inventory","view:inventory"),button("In Stock","view:stock"),button("Lowest Prices","view:deals")),row(button("Booster Boxes","view:boxes"),button("ETBs","view:etbs"),button("Price Drops","view:drops"))]})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)return res.status(response.status).json({error:data.message||"Discord API request failed"});
  return res.status(200).json({ok:true,message:"Menu posted. Pin the new message in Discord.",message_id:data.id});
}