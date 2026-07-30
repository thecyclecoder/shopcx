/**
 * Pipeline watchdog — ONE heal pass (founder-directed 2026-07-16, "watch the pipeline, get everything
 * built, don't let anything sit forever, keep Dahlia off; you're authorized to approve migrations/forks").
 * Safe + capped + logged. Run on a loop in the background while the founder is away.
 *
 * Does, per pass:
 *  1. KEEP DAHLIA OFF — cancel any queued/claimed/building kind='ad-creative' job (manual E2E later).
 *  2. Clear Mario terminal-spec floods (belt until the age-ceiling fix #1917 deploys).
 *  3. Auto-approve BUILD-blocking migrations / design-forks (CEO-authorized).
 *  4. Enqueue starved goal heads + starved standalone watch-list specs (unblocked, no build job).
 *  5. Redrive needs_attention builds (capped at 2 redrives/spec — hot-file reconcile conflicts).
 * Every mutation is logged with a reason. Read-mostly; only queues/cancels/approves.
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
import { enqueueBuildIfDue, evaluateGoalMemberBuildDispatch } from "../src/lib/agent-jobs";
import { goalBranchState } from "../src/lib/specs-table";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ACTIVE=["queued","claimed","building","needs_input","needs_approval","queued_resume","blocked_on_usage"];
const REDRIVE_CAP=2;
const WATCHLIST=[
  "dahlia-produces-3-placement-multi-copy-creative-pack",
  "bianca-publishes-3-placement-multi-copy-via-placement-customization",
  "goal-serializer-one-decision-point-and-serial-claim-no-queued-deadlock",
  "reap-needs-attention-jobs-for-archived-specs",
];
const ts=()=>new Date().toISOString().replace("T"," ").slice(0,19);
const log=(m:string)=>console.log(`[${ts()}] ${m}`);

async function isTerminal(slug:string):Promise<boolean>{
  const s:any=await getSpec(WS, slug).catch(()=>null);
  if(!s) return false;
  if(s.status==="folded"||s.status==="deferred") return true;
  return (s.phases||[]).length>0 && (s.phases||[]).every((p:any)=>p.status==="shipped");
}

async function main(){
  const admin=createAdminClient();
  let acted=0;

  // owner user id for approval attribution
  const { data:mem }=await admin.from("workspace_members").select("user_id").eq("workspace_id",WS).limit(1).maybeSingle();
  const ownerUser=(mem as any)?.user_id ?? null;

  // 1. KEEP DAHLIA OFF
  const { data:dahliaJobs }=await admin.from("agent_jobs").select("id,status").eq("workspace_id",WS)
    .eq("kind","ad-creative").in("status",ACTIVE);
  for(const j of dahliaJobs||[]){
    await admin.from("agent_jobs").update({status:"cancelled", error:"keep-dahlia-off (ceo:dylan 2026-07-16): Dahlia held OFF for the manual E2E test; ad-creative jobs cancelled.", questions:[], pending_actions:[], updated_at:new Date().toISOString()}).eq("id",j.id);
    log(`DAHLIA-OFF: cancelled ad-creative job ${j.id}`); acted++;
  }

  // 2. Mario terminal-spec flood clear (belt)
  const { data:marioQ }=await admin.from("agent_jobs").select("id,spec_slug").eq("workspace_id",WS).eq("kind","mario").eq("status","queued");
  let marioCleared=0;
  for(const j of marioQ||[]){
    if(j.spec_slug && await isTerminal(j.spec_slug)){
      await admin.from("agent_jobs").update({status:"cancelled", error:"watchdog: mario flood on terminal spec (folded/shipped) — cleared.", questions:[], pending_actions:[], updated_at:new Date().toISOString()}).eq("id",j.id);
      marioCleared++; acted++;
    }
  }
  if(marioCleared) log(`MARIO: cleared ${marioCleared} flood jobs on terminal specs`);

  // 3. Auto-approve BUILD-blocking migrations / design-forks
  if(ownerUser){
    const { data:blocked }=await admin.from("agent_jobs").select("id,spec_slug,pending_actions").eq("workspace_id",WS).eq("kind","build").eq("status","needs_approval");
    for(const j of blocked||[]){
      const actions=(j.pending_actions as any[])||[];
      for(const a of actions){
        if(a.status!=="pending") continue;
        if(["apply_migration","design_fork","design_decision"].includes(a.type)){
          try{
            await approveRoadmapAction(WS, ownerUser, {jobId:j.id, actionId:a.id, decision:"approve", notes:"CEO-authorized (Dylan 2026-07-16): auto-approve build-blocking migration/design-fork so the build never sits."});
            log(`APPROVE: ${a.type} on ${j.spec_slug} (job ${j.id.slice(0,8)} action ${a.id})`); acted++;
          }catch(e:any){ log(`APPROVE-FAIL ${j.spec_slug} ${a.id}: ${e.message.slice(0,80)}`); }
        }
      }
    }
  }

  // 4. Enqueue starved goal heads
  const { data:goals }=await admin.from("goals").select("slug").eq("workspace_id",WS).in("status",["greenlit","in_progress"]);
  for(const g of goals||[]){
    let st:any=null; try{ st=await goalBranchState(WS, g.slug); }catch{ continue; }
    for(const m of st?.specs||[]){
      const disp:any=await evaluateGoalMemberBuildDispatch(WS, m.slug).catch(()=>({ok:false}));
      if(!disp.ok) continue;
      // dispatch says this member may build — ensure it has an active build job
      const { data:bj }=await admin.from("agent_jobs").select("id").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",m.slug).in("status",ACTIVE).limit(1);
      if((bj||[]).length) continue;
      if(await isTerminal(m.slug)) continue;
      const r=await enqueueBuildIfDue(WS, m.slug, {createdBy:null}).catch((e:any)=>({enqueued:false,reason:e.message}));
      if((r as any).enqueued){ log(`ENQUEUE (goal ${g.slug} head): ${m.slug}`); acted++; }
    }
  }

  // 5. Watch-list standalone specs (enqueue if unblocked + no job + not terminal)
  for(const slug of WATCHLIST){
    if(await isTerminal(slug)) continue;
    const { data:bj }=await admin.from("agent_jobs").select("id").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",slug).in("status",ACTIVE).limit(1);
    if((bj||[]).length) continue;
    const r=await enqueueBuildIfDue(WS, slug, {createdBy:null}).catch((e:any)=>({enqueued:false,reason:e.message}));
    if((r as any).enqueued){ log(`ENQUEUE (watchlist): ${slug}`); acted++; }
  }

  // 6. Redrive needs_attention builds (capped, hot-file reconcile conflicts)
  const { data:na }=await admin.from("agent_jobs").select("id,spec_slug,error").eq("workspace_id",WS).eq("kind","build").eq("status","needs_attention");
  for(const j of na||[]){
    if(!j.spec_slug || await isTerminal(j.spec_slug)) continue;
    // count prior watchdog redrives (cancelled jobs carrying our marker)
    const { data:prior }=await admin.from("agent_jobs").select("id").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",j.spec_slug).eq("status","cancelled").ilike("error","%watchdog-redrive%");
    if((prior||[]).length>=REDRIVE_CAP){ continue; } // give up — leave for human
    await admin.from("agent_jobs").update({status:"cancelled", error:"watchdog-redrive: needs_attention build superseded by a fresh build off current main.", questions:[], pending_actions:[], updated_at:new Date().toISOString()}).eq("id",j.id);
    const r=await enqueueBuildIfDue(WS, j.spec_slug, {createdBy:null}).catch((e:any)=>({enqueued:false,reason:e.message}));
    if((r as any).enqueued){ log(`REDRIVE (${(prior||[]).length+1}/${REDRIVE_CAP}): ${j.spec_slug}`); acted++; }
  }

  log(`heal pass done — ${acted} action(s)`);
}
main().then(()=>process.exit(0)).catch(e=>{ log(`HEAL-ERROR: ${e.message}`); process.exit(1); });
