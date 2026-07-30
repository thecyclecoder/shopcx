import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { triggerAdGeneration } from "@/lib/ads/ad-creative-trigger";
import { execSync } from "child_process";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", GURU="f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb";
const FIX_GREP="log Max's raw copy-QC output on a parse miss";
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
    if(boxSha&&fixOnBox(boxSha)){console.log(`[${ts()}] diagnostic live on box (${boxSha.slice(0,9)}) — triggering Guru Focus cold`);landed=true;break;}
    if(i%3===0)console.log(`[${ts()}] waiting for diagnostic on box…`);
    await sleep(90000);
  }
  if(!landed){console.log("\n════ ABORT — diagnostic never landed on box ════");return;}
  const sinceUtc=new Date(Date.now()-60000).toISOString().replace("T"," ").slice(0,19);
  const r=await triggerAdGeneration(a,{workspaceId:WS,productId:GURU,temperature:"cold",reason:"ceo-qc-capture"});
  console.log(`[${ts()}] triggered job ${r.jobId.slice(0,8)}`);
  let status="queued";
  for(let i=0;i<50;i++){await sleep(60000);
    const {data}=await a.from("agent_jobs").select("status").eq("id",r.jobId).maybeSingle() as any;
    status=(data as any)?.status??status; if(TERM.includes(status))break;}
  console.log(`[${ts()}] job ${r.jobId.slice(0,8)} status=${status} — pulling Max's raw output from the box journal`);
  await sleep(5000);
  try{
    const out=execSync(`ssh -o ConnectTimeout=15 root@claude-server "journalctl -u shopcx-builder --since '${sinceUtc}' --no-pager 2>/dev/null | grep -A8 copy_qc_parse_miss_raw | head -60"`,{cwd:process.cwd()}).toString();
    console.log("\n════════ MAX'S RAW COPY-QC OUTPUT (parse miss) ════════");
    console.log(out||"(no copy_qc_parse_miss_raw line found in window — maybe it graded OK this time?)");
    console.log("════════ END ════════");
  }catch(e:any){console.log("journal fetch failed:",e.message?.slice(0,200));}
}
main().then(()=>process.exit(0)).catch(e=>{console.error("gate threw:",e.message);process.exit(1);});
