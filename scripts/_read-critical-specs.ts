import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS=["parallel-build-serialized-merge-goal-members","goal-serializer-deadlock","pipeline"]; // guesses; also list by id
import { listSpecs } from "../src/lib/specs-table";
(async()=>{
  const all:any=await listSpecs(WS,{}).catch(()=>null);
  const arr=Array.isArray(all)?all:(all?.specs||[]);
  const crit=arr.filter((s:any)=>s.priority==="critical"||/pipeline|serializ|admission|dispatch|goal-member|deadlock|resilien|redrive|stall/i.test(s.slug));
  console.log("=== critical / pipeline-related specs ===");
  for(const s of crit) console.log(`  [${s.priority||"-"}] ${s.derived_status||s.status||"?"} ${s.slug}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
