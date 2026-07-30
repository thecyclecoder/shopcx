import { loadEnv } from "./_bootstrap"; loadEnv();
import { searchAds } from "../src/lib/adlibrary";
(async()=>{
  const variants=[
    { label:"current (kw='Obvi collagen', daysBack=30)", p:{ keyword:"Obvi collagen", daysBack:30, pageSize:30 } },
    { label:"kw='obvi collagen', daysBack=30", p:{ keyword:"obvi collagen", daysBack:30, pageSize:30 } },
    { label:"kw='obvi collagen', daysBack=365", p:{ keyword:"obvi collagen", daysBack:365, pageSize:50 } },
    { label:"kw='obvi collagen', daysBack=1000", p:{ keyword:"obvi collagen", daysBack:1000, pageSize:50 } },
    { label:"kw='obvi', daysBack=365", p:{ keyword:"obvi", daysBack:365, pageSize:50 } },
  ];
  for(const v of variants){
    try{ const ads=await searchAds(v.p as any); console.log(`${v.label}: ${ads.length} ads (${ads.filter((a:any)=>a.media_type==="static").length}s/${ads.filter((a:any)=>a.media_type==="video").length}v)`); }
    catch(e:any){ console.log(`${v.label}: ERROR ${e.message}`); }
    await new Promise(r=>setTimeout(r,7000)); // stay under 10/min
  }
})().then(()=>process.exit(0));
