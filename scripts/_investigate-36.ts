import { loadEnv } from "./_bootstrap"; loadEnv();
import { whyIsSpecNotBuilding, investigateSpec } from "../src/lib/spec-investigation";
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const slug="media-buyer-digest-consolidate-product-names-suppress-noop";
  const s:any=await getSpec(WS,slug).catch(()=>null);
  console.log("=== spec:", slug, "===");
  console.log("status:", s?.status??"(derived)", "| phases:", (s?.phases||[]).map((p:any)=>`${p.title?.slice(0,24)}=${p.status}`).join(" | "));
  try{
    const why:any=await whyIsSpecNotBuilding(WS, slug);
    console.log("\n=== whyIsSpecNotBuilding ===");
    console.log(typeof why==="string"?why:JSON.stringify(why,null,2).slice(0,1500));
  }catch(e){ console.log("whyIsSpecNotBuilding err:", String(e).slice(0,150)); }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,250));process.exit(1);});
