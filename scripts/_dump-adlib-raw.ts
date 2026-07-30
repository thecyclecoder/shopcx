import { loadEnv } from "./_bootstrap"; loadEnv();
import { searchAds } from "../src/lib/adlibrary";
(async()=>{
  const ads=await searchAds({ keyword:"Obvi collagen", daysBack:90, pageSize:10 } as any);
  console.log("returned:", ads.length, "ads (daysBack=90)");
  const raw:any=(ads[0] as any)?.raw;
  if(!raw){ console.log("no raw"); return; }
  // print all keys + any day/duration/time-related fields
  console.log("\nall keys:", Object.keys(raw).join(", "));
  console.log("\nday/time-related fields on top ad:");
  for(const k of Object.keys(raw)){
    if(/day|days|active|duration|time|first|last|start|created|run/i.test(k)) console.log(`  ${k}: ${JSON.stringify(raw[k])}`);
  }
  // show the field values that look like a longevity count for the first 3 ads
  console.log("\ntop 3 ads — days_count vs candidate day fields:");
  for(const a of ads.slice(0,3)){ const r:any=(a as any).raw; console.log(`  days_count=${r.days_count} days=${r.days} active_days=${r.active_days} first_seen=${r.first_seen} last_seen=${r.last_seen}`); }
})().then(()=>process.exit(0));
