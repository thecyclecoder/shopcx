import { createAdminClient } from "@/lib/supabase/admin";
import { listAds, getAd, traceAdOrigin } from "@/lib/ads/ads-read-sdk";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", GURU="f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const TERM=["completed","failed","cancelled","needs_input","needs_attention"];
async function m(){const a=createAdminClient();
  let status="queued",reason="",enqAt="2026-07-19T20:00:00Z";
  for(let i=0;i<55;i++){await sleep(60000);
    const {data}=await a.from("agent_jobs").select("status,log_tail,created_at").eq("id","f81cdea8-0000".slice(0,0)||"").maybeSingle() as any;
    const {data:j}=await a.from("agent_jobs").select("status,log_tail,created_at").eq("workspace_id",WS).eq("kind","ad-creative-copy-author").ilike("instructions","%ceo-verify-post-migration%").order("created_at",{ascending:false}).limit(1) as any;
    const job=(j as any)?.[0]; if(!job)continue; enqAt=job.created_at;
    status=job.status; const lt=job.log_tail||""; const mm=lt.match(/"reason":"([^"]+)"/); if(mm)reason=mm[1];
    if(TERM.includes(status))break;}
  console.log(`\n════ GURU VERIFY (post-migration) status=${status} ════`);
  const ads=await listAds(a,{workspaceId:WS,productId:GURU,since:enqAt,limit:2});
  if(!ads.length){console.log(`no campaign. reason=${reason.slice(0,110)}`);console.log("════ END ════");return;}
  for(const s of ads){const A=await getAd(a,{workspaceId:WS,campaignId:s.id}); const t=await traceAdOrigin(a,{workspaceId:WS,campaignId:s.id});
    console.log(`AD ${s.id.slice(0,8)} "${(A?.name||"").slice(0,40)}"`);
    console.log(`  COMPETITOR IMITATED: ${A?.angle?.provenance?.competitor_advertiser||"⚠ OWN-BRAND (shelf still empty?)"}`);
    console.log(`  path=${t?.executionPath} maxGraded=${A?.maxGraded} score=${A?.maxCopyVerdict?.persuasion_score??"-"}/10 hard_gate=${A?.maxCopyVerdict?.hard_gate_pass} postable=${A?.postable}`);
    if(!A?.postable)console.log(`  reason: ${reason.slice(0,140)}`);}
  console.log("════ END ════");
}
m().then(()=>process.exit(0)).catch(e=>{console.error("watch threw:",e.message);process.exit(1);});
