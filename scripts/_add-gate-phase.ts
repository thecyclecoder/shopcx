import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec, upsertSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="dahlia-researches-from-winners-flow-ad-library";
(async()=>{
  const s:any=await getSpec(WS,SLUG);
  const phases=(s.phases||[]).map((p:any)=>({position:p.position,title:p.title,status:p.status,body:p.body,why:p.why,what:p.what,verification:p.verification}));
  phases.push({ position:3, title:"Phase 3 — ready-to-bin quality gate (min grade + revise loop, tunable)", status:"planned",
    body:"An ad enters Bianca's ready-to-test bin ONLY when Max's QA composite ≥ a threshold (default 7/10). Below threshold → REVISE loop: Max's per-axis reasons feed back to Dahlia to regenerate (bounded retries, e.g. 3) before the ad is skipped/escalated. The threshold is a TUNABLE setpoint (iteration_policies-style), so it ratchets up as Dahlia improves — high standards without starving the bin during the ramp.",
    why:"Reject-only at 7/10 with a grader that starts at 5-6 (as ticket-QA did, 5→8) would leave the bin EMPTY and Bianca with nothing to test. Revise-to-pass fills the bin with genuinely good creative; a tunable threshold lets the bar rise as quality climbs. Supervisable-autonomy: the bin is the leash — nothing ships until it clears Max's objective bar.",
    what:"Add a ready-to-bin gate: on Max's QA composite < threshold, run a bounded revise loop (feed the per-axis reasons to Dahlia → regenerate → re-QA); only a ≥threshold creative flips to ready-to-test. Store the threshold as a setpoint (default 7) tunable per workspace; record each attempt + final grade on the ledger.",
    verification:"vitest: a creative graded < threshold triggers a revise (not a bin insert) and a ≥threshold one flips ready-to-test; the threshold reads from the setpoint (not hardcoded); bounded retries cap the loop; `npx tsc --noEmit` clean." });
  const res=await upsertSpec(WS,{ slug:SLUG, title:s.title, summary:s.summary, owner:s.owner, parent:s.parent, parent_kind:"mandate", parent_ref:"growth#ad-creative-dahlia-under-max-beside-bianca", priority:s.priority, deferred:true, intended_status:"planned", intended_status_set_by:"ceo:dylan", auto_build:false, milestone_id:null, why:s.why, what:s.what }, phases as any);
  console.log("spec now has phases:", JSON.stringify(res.phase_ids));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
