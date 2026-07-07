import "./_bootstrap";
import { getSpec } from "../src/lib/specs-table";
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const M3="081440b3-6631-4727-8dd0-ee61fbe9cf18";
const SPINE="ticket-resolution-events-writeahead-ledger-and-decision-schema-extension";

function phasesFrom(s:any){return (s.phases||[]).map((p:any)=>({
  title:p.title, why:p.why, what:p.what, body:p.body, verification:p.verification, status:"planned" as const,
}));}

async function reauthor(slug:string, mutate:(input:any)=>any, label:string){
  const s:any=await getSpec(WS,slug);
  if(!s){console.log(`${slug}: NOT FOUND`);return;}
  const input:any={
    title:s.title, why:s.why, what:s.what, summary:s.summary, owner:s.owner,
    parent:s.parent, blocked_by:s.blocked_by||[], phases:phasesFrom(s),
  };
  mutate(input);
  const ok=await authorSpecRowStructured(WS,slug,input,"planned",{intendedStatusSetBy:"ceo",milestoneId:M3});
  console.log(`${label}: ${ok?"re-authored ✓":"FAILED"}`);
}

async function main(){
  // Pia's alias spec — fix bare-goal parent → M3-anchored
  await reauthor("orchestrator-handler-alias-catalog-for-no-handler-misses",(i)=>{
    i.parent='[[../goals/guaranteed-ticket-handling#081440b3-right-cost-routing]] — M3 "Right-cost routing" milestone: DB-driven action-alias catalog that closes the executor\'s no-handler misses.';
  },"alias-spec parent→M3");
  // My model-picker spec — add the missing Blocked-by (Phase 3 depends on the spine)
  await reauthor("model-picker-routes-on-state-not-tags-ltv-stops-buying-opus",(i)=>{
    i.blocked_by=[SPINE];
  },"model-picker +Blocked-by spine");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
