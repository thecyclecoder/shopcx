import { loadEnv, createAdminClient } from "./_bootstrap";
loadEnv();
import { getSpec } from "../src/lib/specs-table";
import { authorSpecRowStructured } from "../src/lib/author-spec";
import { answerRoadmapBuild } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OWNER="496c3592-d105-4bf3-a3bb-1d2922405fb9";
const SLUG="refund-idempotency-guard-in-commerce-refund-facade";
async function main(){
  // 1) DEFER the spec (deps live on the goal branch, not main — rebuild after atomic merge)
  const s:any=await getSpec(WS,SLUG);
  const ok=await authorSpecRowStructured(WS,SLUG,{
    title:s.title, why:s.why, what:s.what,
    summary:`⏸️ DEFERRED — depends on the guaranteed-ticket-handling goal's code (order_refunds + hashRefundRequestKey + guarded handlers from refund-integrity #1244; commerce/refund.issueRefund from commerce-sdk #1245), which is on the GOAL BRANCH and reaches main only at the atomic goal→main merge. Authored standalone-off-main prematurely. Re-activate (intended_status→planned) and rebuild AFTER the goal ships to main.\n\n${s.summary}`,
    owner:s.owner, parent:s.parent, blocked_by:s.blocked_by||[],
    phases:(s.phases||[]).map((p:any)=>({title:p.title,why:p.why,what:p.what,body:p.body,verification:p.verification,status:"planned"})),
  },"deferred",{intendedStatusSetBy:"ceo",parentKind:"mandate",parentRef:"retention#billing-integrity"});
  console.log("deferred spec:", ok?"ok":"FAIL");
  // 2) answer the parked build so it exits without authoring duplicates
  const a=createAdminClient();
  const {data:job}=await a.from("agent_jobs").select("id,status").eq("spec_slug",SLUG).eq("kind","build").eq("status","needs_input").order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(job){
    const r=await answerRoadmapBuild(WS,OWNER,{jobId:job.id,answers:[
      {id:"missing-scaffolding",answer:"Do NOT author issueRefund / hashRefundRequestKey / order_refunds from scratch — they already exist on the guaranteed-ticket-handling GOAL BRANCH (order_refunds + hashRefundRequestKey + guarded handlers from refund-integrity #1244; commerce/refund.issueRefund from commerce-sdk #1245) and reach main only via the pending atomic goal→main promotion. This spec was authored standalone-off-main prematurely and is now DEFERRED until the goal ships to main. Make NO changes and exit — create no migration, table, or code."},
      {id:"guarded-claim-wrong",answer:"Correct — on main those guards/handlers don't exist; they're on the goal branch (#1244/#1245). The spec describes the post-atomic-merge state. Nothing to build until the goal ships to main. Deferring — make no changes and exit."},
    ]});
    console.log("answered build job:", r.ok?"ok (will resume + exit)":"FAIL "+((r as any).error));
  } else console.log("no needs_input build job found (already cleared)");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
