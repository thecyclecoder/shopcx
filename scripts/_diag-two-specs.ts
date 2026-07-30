import { loadEnv } from "./_bootstrap"; loadEnv();
import { investigateSpec } from "../src/lib/spec-investigation";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  for(const slug of ["media-buyer-digest-consolidate-product-names-suppress-noop","competitor-sdk-chokepoint-and-per-product-cleanup"]){
    console.log(`\n${"=".repeat(90)}\n### ${slug}`);
    try{
      const r:any = await investigateSpec(WS, slug);
      console.log(JSON.stringify(r, null, 1).slice(0, 3500));
    }catch(e){ console.log("investigateSpec err:", String(e).slice(0,300)); }
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
