import { loadEnv } from "./_bootstrap"; loadEnv();
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
const PAGE="2431731276838642"; // Obvi
(async()=>{
  console.log("POST /api/winners/advertiser/"+PAGE+" (streaming NDJSON, ~60-120s)…");
  const res=await fetch(`${BASE}/api/winners/advertiser/${PAGE}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${KEY}`},body:JSON.stringify({country:"US",top_enrich:40,max_pages:8})});
  if(!res.ok){ console.log("HTTP",res.status, (await res.text()).slice(0,200)); return; }
  const text=await res.text();
  const lines=text.trim().split("\n").filter(Boolean);
  const stages:Record<string,number>={}; const scores:any[]=[]; let summary:any=null;
  for(const l of lines){ try{ const o=JSON.parse(l); const st=o._stage; stages[st]=(stages[st]||0)+1; if(st==="score")scores.push(o); if(st==="summary")summary=o.summary; }catch{} }
  console.log("stages:", JSON.stringify(stages));
  console.log("summary:", JSON.stringify(summary));
  console.log(`\n=== ${scores.length} scored winners. Tiers:`, JSON.stringify(scores.reduce((m:any,s:any)=>{const t=s.score?.tier||"?";m[t]=(m[t]||0)+1;return m;},{})));
  const s0=scores[0];
  if(s0){ console.log("\n--- sample winner shape ---");
    console.log("score keys:", Object.keys(s0.score||{}).join(","));
    console.log("ad keys:", Object.keys(s0.ad||{}).join(","));
    console.log("tier:", s0.score?.tier, "composite:", s0.score?.composite, "variants:", s0.score?.variant_count);
    console.log("tags:", JSON.stringify(s0.score?.tags)?.slice(0,300));
    console.log("ad sample:", JSON.stringify({advertiser:s0.ad?.advertiser_name||s0.ad?.advertiser, media:s0.ad?.media_type, days:s0.ad?.days_count, img:!!(s0.ad?.preview_img_url||s0.ad?.image_url)}));
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
