import { loadEnv } from "./_bootstrap"; loadEnv();
import { listSpecs } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const specs:any[]=await listSpecs(WS).catch(()=>[]);
  const hits=specs.filter(s=>/remedy|cancel.?flow|outcome.?check|remedy.?outcome/i.test(s.slug+" "+(s.title||"")));
  for(const s of hits) console.log(`  ${s.slug} — status=${s.status??"(derived)"}`);
  console.log(hits.length?"":"  (no matching specs)");
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,150));process.exit(1);});
