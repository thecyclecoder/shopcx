import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { triggerAdGeneration } from "@/lib/ads/ad-creative-trigger";
import { execSync } from "child_process";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", GURU="f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const ts=()=>new Date().toISOString().slice(11,19);
const TERM=["completed","failed","cancelled","needs_input","needs_attention"];
async function main(){const a=createAdminClient();
  for(let attempt=1;attempt<=5;attempt++){
    const sinceUtc=new Date(Date.now()-30000).toISOString().replace("T"," ").slice(0,19);
    const r=await triggerAdGeneration(a,{workspaceId:WS,productId:GURU,temperature:"cold",reason:`ceo-qc-capture-${attempt}`});
    console.log(`[${ts()}] attempt ${attempt}: job ${r.jobId.slice(0,8)}`);
    let status="queued",reason="";
    for(let i=0;i<50;i++){await sleep(60000);
      const {data}=await a.from("agent_jobs").select("status,log_tail").eq("id",r.jobId).maybeSingle() as any;
      status=(data as any)?.status??status;
      const lt=(data as any)?.log_tail||""; const mm=lt.match(/"reason":"([^"]+)"/); if(mm)reason=mm[1];
      if(TERM.includes(status))break;}
    await sleep(4000);
    let out="";
    try{out=execSync(`ssh -o ConnectTimeout=15 root@claude-server "journalctl -u shopcx-builder --since '${sinceUtc}' --no-pager 2>/dev/null | grep -A9 copy_qc_parse_miss_raw | head -40"`,{cwd:process.cwd()}).toString();}catch{}
    console.log(`[${ts()}] job ${r.jobId.slice(0,8)} status=${status} reason=${reason.slice(0,50)} — captured=${out.trim()?"YES":"no (didn't reach copy-QC)"}`);
    if(out.trim()){
      console.log("\n════════ MAX'S RAW COPY-QC OUTPUT ════════");
      console.log(out);
      console.log("════════ END ════════");
      return;
    }
  }
  console.log("\n════ 5 attempts, none reached copy-QC to capture the parse miss ════");
}
main().then(()=>process.exit(0)).catch(e=>{console.error("gate threw:",e.message);process.exit(1);});
