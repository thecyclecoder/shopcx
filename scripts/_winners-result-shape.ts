import { loadEnv } from "./_bootstrap"; loadEnv();
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
(async()=>{
  const res=await fetch(`${BASE}/api/winners/advertiser/2431731276838642`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${KEY}`},body:JSON.stringify({country:"US"})});
  const j:any=await res.json();
  const r0=(j.results||[])[0];
  if(!r0){ console.log("no results"); return; }
  console.log("result keys:", Object.keys(r0).join(","));
  console.log("score:", JSON.stringify(r0.score));
  console.log("\nad keys:", Object.keys(r0.ad||{}).join(","));
  console.log("\nad enrichment fields:", JSON.stringify({advertiser:r0.ad?.advertiser_name, days:r0.ad?.days_count, media:r0.ad?.media_type, hook:r0.ad?.hook, angle:r0.ad?.angle, concept:r0.ad?.concept, summary:(r0.ad?.summary||"").slice(0,120), img:r0.ad?.preview_img_url?.slice(0,60)}));
})().then(()=>process.exit(0));
