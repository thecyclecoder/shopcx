import { loadEnv } from "./_bootstrap"; loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", V="v20.0", CREATIVE="1651599292996360";
(async()=>{
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");
  const res=await fetch(`https://graph.facebook.com/${V}/${CREATIVE}?fields=id,name,asset_feed_spec,object_story_spec,effective_object_story_id&access_token=${token}`);
  const j:any=await res.json();
  if(!res.ok){ console.error(JSON.stringify(j.error)); process.exit(1); }
  const afs=j.asset_feed_spec||{};
  console.log("creative:", j.id, "| name:", j.name);
  console.log("images:", (afs.images||[]).length, "| titles:", (afs.titles||[]).length, "| bodies:", (afs.bodies||[]).length);
  console.log("titles:", JSON.stringify((afs.titles||[]).map((t:any)=>t.text)));
  console.log("bodies:", (afs.bodies||[]).map((b:any)=>b.text.slice(0,40)+"…"));
  console.log("optimization_type:", afs.optimization_type, "| ad_formats:", JSON.stringify(afs.ad_formats));
  console.log("link (object_story_spec.link_data.link):", j.object_story_spec?.link_data?.link);
})().then(()=>process.exit(0));
