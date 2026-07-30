import { loadEnv } from "./_bootstrap"; loadEnv();
import { listSpecs } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const specs:any[]=await listSpecs(WS).catch(()=>[]);
  const hits=specs.filter(s=>/fraud|order_ids|shopify.?order.?id/i.test(s.slug+" "+(s.title||"")));
  for(const s of hits) console.log(`  ${s.slug} — ${s.status??"(derived)"}`);
  console.log(hits.length?"":"  (none)");
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,120));process.exit(1);});
