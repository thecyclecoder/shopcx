import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { queueRoadmapBuild } from "@/lib/roadmap-actions";
import { execSync } from "child_process";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", OWNER="496c3592-d105-4bf3-a3bb-1d2922405fb9";
const SLUG="max-qc-grades-the-creative-per-format-not-just-a-binary-render-ok";
const TERMINAL=["completed","failed","cancelled","needs_input","needs_attention"];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function p2OnMain(){try{execSync("git fetch origin main -q",{cwd:process.cwd()});
  return execSync(`git log origin/main -S "creative_gate_pass" --oneline -1 -- src/lib/ads/creative-qa.ts scripts/builder-worker.ts`,{cwd:process.cwd()}).toString().split("\n").length>1;}catch{return false;}}
async function main(){const a=createAdminClient();
  // 1) wait for c75def0f (the redundant P1 rebuild) to terminate
  for(let i=0;i<40;i++){
    const {data}=await a.from("agent_jobs").select("status").ilike("id","c75def0f%").maybeSingle();
    const st=(data as any)?.status;
    if(!st || TERMINAL.includes(st)){console.log(`[${new Date().toISOString().slice(11,19)}] c75def0f terminal (${st??"gone"}) — queueing P2`);break;}
    if(i%4===0)console.log(`[${new Date().toISOString().slice(11,19)}] waiting c75def0f=${st}`);
    await sleep(90000);
  }
  // 2) queue P2 (P1 is stamped shipped, so this targets the next planned phase)
  const r=await queueRoadmapBuild(WS,OWNER,{slug:SLUG,chainPhases:true});
  console.log(`P2 queue: ok=${r.ok} job=${(r as any).job?.id?.slice(0,8)} status=${(r as any).job?.status} active=${(r as any).alreadyActive}`);
  // 3) watch P2 land or stall (~60 min)
  for(let i=0;i<40;i++){
    await sleep(90000);
    const {data:j}=await a.from("agent_jobs").select("id,status,error").eq("workspace_id",WS).ilike("spec_slug","max-qc-grades%").order("created_at",{ascending:false}).limit(1);
    const x=(j as any)?.[0];
    if(x && ["needs_attention","failed"].includes(x.status)){console.log(`\n════════ D-P2 STALLED (${x.status}): ${(x.error||"").slice(0,110)} ════════`);return;}
    if(x && x.status==="completed"){console.log(`\n════════ D-P2 build completed (job ${x.id.slice(0,8)}) — check merge ════════`);return;}
  }
  console.log("\n════════ D-P2 watch timed out ════════");
}
main().catch(e=>{console.error("threw:",e instanceof Error?e.message:String(e));});
