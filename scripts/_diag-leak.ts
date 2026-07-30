import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS=["platform-director-agent","approval-routing-engine","directors-board-gamified","goal-readers-from-db-retire-parsegoal","noop-goal-test-a"];
(async()=>{
  for(const slug of SLUGS){
    const s:any=await getSpec(WS, slug).catch(e=>({err:e.message}));
    if(!s||s.err){ console.log(slug, "→", s?.err||"NULL"); continue; }
    const ph=(s.phases||[]).map((p:any)=>`${p.position}:${p.status}${p.kind==='fix'?'(fix)':''}`);
    const allShipped = (s.phases||[]).length>0 && (s.phases||[]).every((p:any)=>p.status==="shipped");
    console.log(`${slug}\n   rawStatus=${s.status} allPhasesShipped=${allShipped} phases=[${ph.join(", ")}]`);
  }
})().then(()=>process.exit(0));
