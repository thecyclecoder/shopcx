import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { triggerAdGeneration } from "@/lib/ads/ad-creative-trigger";
import { listAds, traceAdOrigin } from "@/lib/ads/ads-read-sdk";
import { execSync } from "child_process";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", GURU="f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb";
const FIX_GREP="authority + mechanism competitor angles are COLD-eligible";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const ts=()=>new Date().toISOString().slice(11,19);
const TERM=["completed","failed","cancelled","needs_input","needs_attention"];
function fixOnBox(boxSha:string){try{execSync("git fetch origin main -q",{cwd:process.cwd()});
  const sha=execSync(`git log origin/main --grep="${FIX_GREP}" --oneline -1`,{cwd:process.cwd()}).toString().trim().split(" ")[0];
  if(!sha)return false; execSync(`git merge-base --is-ancestor ${sha} ${boxSha}`,{cwd:process.cwd(),stdio:"ignore"}); return true;}catch{return false;}}
async function main(){const a=createAdminClient();
  let landed=false;
  for(let i=0;i<40;i++){
    const {data:hb}=await a.from("worker_heartbeats").select("running_sha").order("updated_at",{ascending:false}).limit(1) as any;
    const boxSha=(((hb as any)?.[0]?.running_sha)??"").replace(/[^0-9a-f]/gi,"").slice(0,40);
    if(boxSha&&fixOnBox(boxSha)){console.log(`[${ts()}] authority-fix live on box (${boxSha.slice(0,9)}) — triggering Guru Focus cold via SDK`);landed=true;break;}
    if(i%3===0)console.log(`[${ts()}] waiting for authority-fix on box…`);
    await sleep(90000);
  }
  if(!landed){console.log("\n════ ABORT — authority-fix never landed on box ════");return;}
  const enqAt=new Date().toISOString();
  const r=await triggerAdGeneration(a,{workspaceId:WS,productId:GURU,temperature:"cold",reason:"ceo-guru-focus-post-authority-fix"});
  console.log(`[${ts()}] triggered: job ${r.jobId.slice(0,8)} temp=${r.temperature}`);
  let status="queued";
  for(let i=0;i<50;i++){await sleep(60000);
    const {data}=await a.from("agent_jobs").select("status").eq("id",r.jobId).maybeSingle() as any;
    status=(data as any)?.status??status; if(TERM.includes(status))break;}
  console.log(`\n════ GURU FOCUS (post-fix) job ${r.jobId.slice(0,8)} status=${status} ════`);
  const ads=await listAds(a,{workspaceId:WS,productId:GURU,since:enqAt,limit:3});
  if(!ads.length){console.log("no campaign produced — check job log.");console.log("════ END ════");return;}
  for(const s of ads){const t=await traceAdOrigin(a,{workspaceId:WS,campaignId:s.id}); if(!t)continue;
    console.log(`\nAD ${s.id.slice(0,8)} "${(s.name||"").slice(0,44)}" temp=${s.audienceTemperature}`);
    console.log(`  path=${t.executionPath} maxGraded=${t.maxGraded}(${t.ad.maxCopyVerdict?.persuasion_score??"-"}/10) treatments=${t.usedPersuasionTreatments}`);
    console.log(`  angle.source=${t.ad.angle?.source} badge=${t.exploreExploit.badgeMode} COMPETITOR IMITATED=${t.ad.angle?.provenance?.competitor_advertiser||"(own-brand — still not imitating!)"}`);
    console.log(`  postable(≥9)=${t.ad.postable}`);
  }
  console.log("════ END ════");
}
main().then(()=>process.exit(0)).catch(e=>{console.error("gate threw:",e.message);process.exit(1);});
