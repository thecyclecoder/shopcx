import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { triggerAdGeneration } from "@/lib/ads/ad-creative-trigger";
import { listAds, getAd, traceAdOrigin } from "@/lib/ads/ads-read-sdk";
import { execSync } from "child_process";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", GURU="f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb";
const FIX_GREP="imitation render drops mismatched benefits";
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
    if(boxSha&&fixOnBox(boxSha)){console.log(`[${ts()}] debrand fix live on box (${boxSha.slice(0,9)})`);landed=true;break;}
    if(i%3===0)console.log(`[${ts()}] waiting for debrand fix on box…`);
    await sleep(90000);
  }
  if(!landed){console.log("\n════ ABORT — debrand fix never landed ════");return;}
  const attempts:string[]=[];
  for(let attempt=1;attempt<=4;attempt++){
    const enqAt=new Date().toISOString();
    const r=await triggerAdGeneration(a,{workspaceId:WS,productId:GURU,temperature:"cold",reason:`ceo-e2e-${attempt}`});
    console.log(`[${ts()}] attempt ${attempt}: job ${r.jobId.slice(0,8)}`);
    let status="queued",reason="";
    for(let i=0;i<55;i++){await sleep(60000);
      const {data}=await a.from("agent_jobs").select("status,log_tail").eq("id",r.jobId).maybeSingle() as any;
      status=(data as any)?.status??status;
      const lt=(data as any)?.log_tail||""; const mm=lt.match(/"reason":"([^"]+)"/); if(mm)reason=mm[1];
      if(TERM.includes(status))break;}
    const ads=await listAds(a,{workspaceId:WS,productId:GURU,since:enqAt,limit:2});
    const produced=ads[0];
    if(produced){
      const A=await getAd(a,{workspaceId:WS,campaignId:produced.id});
      const t=await traceAdOrigin(a,{workspaceId:WS,campaignId:produced.id});
      const comp=A?.angle?.provenance?.competitor_advertiser||"own-brand";
      const gate=A?.maxCopyVerdict?.hard_gate_pass;
      console.log(`  → produced ${produced.id.slice(0,8)} "${(A?.name||"").slice(0,38)}" competitor=${comp}`);
      console.log(`    maxGraded=${A?.maxGraded} score=${A?.maxCopyVerdict?.persuasion_score??"-"}/10 hard_gate_pass=${gate} postable=${A?.postable} path=${t?.executionPath}`);
      if(A?.postable){
        console.log(`\n════════ ✅ FULLY-CLEAN POSTABLE AD — attempt ${attempt} ════════`);
        console.log(`  ${produced.id.slice(0,8)} imitates ${comp}, Max ${A.maxCopyVerdict?.persuasion_score}/10 hard_gate=${gate}, postable=TRUE`);
        console.log(`  headline: ${A.angle?.metaHeadline}`);
        console.log("════════ END ════════"); return;
      }
      attempts.push(`#${attempt} ${produced.id.slice(0,8)} imit=${comp} score=${A?.maxCopyVerdict?.persuasion_score??"-"} gate=${gate} — ${reason.slice(0,80)}`);
    } else {
      attempts.push(`#${attempt} no campaign — ${reason.slice(0,90)}`);
      console.log(`  → no campaign. reason=${reason.slice(0,90)}`);
    }
  }
  console.log(`\n════════ 4 attempts, none postable — outcomes ════════`);
  for(const x of attempts)console.log("  "+x);
  console.log("════════ END ════════");
}
main().then(()=>process.exit(0)).catch(e=>{console.error("gate threw:",e.message);process.exit(1);});
