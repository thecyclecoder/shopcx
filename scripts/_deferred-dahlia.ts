import { loadEnv } from "./_bootstrap"; loadEnv();
import { listSpecs } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const specs = await listSpecs(WS, {});
  const dahlia = (specs||[]).filter((s:any)=>
    /dahlia|ad-creative|creative|competitor|research|amazing|angle|copy|bianca|vision/i.test(`${s.slug} ${s.title||""}`)
  );
  console.log("Dahlia/ad-related specs:");
  for(const s of dahlia){
    const status = s.status ?? `derived:${s.derived_status||"?"}`;
    console.log(`  [${status}]${s.deferred?" DEFERRED":""}${s.auto_build===false?" auto_build=off":""} ${s.slug}`);
  }
})();
