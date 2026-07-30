import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { listAds, traceAdOrigin } from "@/lib/ads/ads-read-sdk";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", GURU="f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb", JOB="80cf676c";
const START="2026-07-19T16:46:00Z";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const TERM=["completed","failed","cancelled","needs_input","needs_attention"];
async function m(){const a=createAdminClient();
  let status="building";
  for(let i=0;i<60;i++){
    await sleep(60000);
    const {data}=await a.from("agent_jobs").select("status").eq("workspace_id",WS).eq("kind","ad-creative-copy-author").gte("created_at",START).order("created_at",{ascending:false}).limit(1) as any;
    status=(data as any)?.[0]?.status??status;
    if(TERM.includes(status))break;
  }
  console.log(`\n════════ GURU FOCUS BOX SESSION (${JOB}) — status=${status} ════════`);
  const ads=await listAds(a,{workspaceId:WS,productId:GURU,since:START,limit:3});
  if(!ads.length){console.log("no new Guru Focus campaign produced — check the job log.");console.log("════════ END ════════");return;}
  for(const s of ads){
    const t=await traceAdOrigin(a,{workspaceId:WS,campaignId:s.id});
    if(!t)continue;
    console.log(`\nAD ${s.id.slice(0,8)} "${(s.name||"").slice(0,46)}" temp=${s.audienceTemperature}`);
    console.log(`  path=${t.executionPath} maxGraded=${t.maxGraded}(${t.ad.maxCopyVerdict?.persuasion_score??"-"}/10) treatments=${t.usedPersuasionTreatments}`);
    console.log(`  angle.source=${t.ad.angle?.source} badge=${t.exploreExploit.badgeMode} true=${t.exploreExploit.trueIntent} mislabeled=${t.exploreExploit.mislabeledExploit}`);
    console.log(`  competitor imitated: ${t.ad.angle?.provenance?.competitor_advertiser||"(own-brand)"}`);
    console.log(`  postable(≥9)=${t.ad.postable}`);
    console.log(`  → ${t.summary}`);
  }
  console.log("════════ END ════════");
}
m().then(()=>process.exit(0)).catch(e=>{console.error("watcher threw:",e.message);process.exit(1);});
