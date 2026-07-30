import { loadEnv } from "./_bootstrap"; loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", V="v20.0";
const ACCT="2352876514967984", CREATIVE="2784992095220990", AD="120252469954990184";
(async()=>{
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");
  // 1. real render fields on the creative
  const c:any=await (await fetch(`https://graph.facebook.com/${V}/${CREATIVE}?fields=id,image_url,thumbnail_url,object_story_id,effective_object_story_id,image_hash,object_type&access_token=${token}`)).json();
  console.log("=== creative render fields ===");
  console.log(JSON.stringify(c,null,1).slice(0,800));
  // 2. proper preview — dump first 1200 chars of the iframe body so we can SEE it
  const pv:any=await (await fetch(`https://graph.facebook.com/${V}/${AD}/previews?ad_format=MOBILE_FEED_STANDARD&access_token=${token}`)).json();
  console.log("\n=== preview (MOBILE_FEED_STANDARD) ===");
  console.log("error:", JSON.stringify(pv.error||"none"));
  console.log("body:", (pv.data?.[0]?.body||"").slice(0,1200));
})().then(()=>process.exit(0));
