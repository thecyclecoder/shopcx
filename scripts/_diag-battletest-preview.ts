import { loadEnv } from "./_bootstrap"; loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", V="v20.0";
const ACCT="2352876514967984", CREATIVE="1651599292996360", AD="120252469523460184";
const HASHES=["06fb3d88d4d43eed","be587df7396b382e","8f4f60a924b684a1","120039bdedb14001","2e874f6a7f36ef1b"];
(async()=>{
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");
  // 1. Are the hashes valid images on the account?
  const r1=await fetch(`https://graph.facebook.com/${V}/act_${ACCT}/adimages?fields=hash,name,width,height,status,permalink_url&access_token=${token}`);
  const j1:any=await r1.json();
  const imgs=(j1.data||[]);
  console.log("=== account has", imgs.length, "adimages; battle-test hashes present? ===");
  for(const h of HASHES){ const f=imgs.find((i:any)=>i.hash?.startsWith(h)); console.log(" ", h, f?`OK ${f.width}x${f.height} status=${f.status}`:"NOT FOUND"); }
  // 2. Full asset_feed_spec.images (full hashes) + does link_data carry an image?
  const r2=await fetch(`https://graph.facebook.com/${V}/${CREATIVE}?fields=asset_feed_spec,object_story_spec&access_token=${token}`);
  const j2:any=await r2.json();
  console.log("\n=== creative asset_feed_spec.images ===");
  console.log(JSON.stringify((j2.asset_feed_spec?.images||[]), null, 1));
  console.log("object_story_spec.link_data:", JSON.stringify(j2.object_story_spec?.link_data));
  // 3. Real rendered preview
  const r3=await fetch(`https://graph.facebook.com/${V}/${AD}/previews?ad_format=MOBILE_FEED_STANDARD&access_token=${token}`);
  const j3:any=await r3.json();
  if(j3.error){ console.log("\n=== preview ERROR ===", JSON.stringify(j3.error).slice(0,300)); }
  else { const body=j3.data?.[0]?.body||""; const hasImg=/<img|background-image|scontent|fbcdn/i.test(body);
    console.log("\n=== preview renders media? ===", hasImg, "| body len", body.length); }
})().then(()=>process.exit(0));
