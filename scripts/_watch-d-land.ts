import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { execSync } from "child_process";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", SLUG="max-qc-grades-the-creative-per-format-not-just-a-binary-render-ok";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function p1OnMain(){try{execSync("git fetch origin main -q",{cwd:process.cwd()});
  return execSync(`git log origin/main -S "parsePerFormatCreative" --oneline -1`,{cwd:process.cwd()}).toString().trim().length>0;}catch{return false;}}
async function main(){const a=createAdminClient();
  for(let i=0;i<80;i++){
    if(p1OnMain()){console.log("\n════════ D PHASE 1 MERGED TO MAIN — Max now grades the creative per-format (catches the free-tote + box-scale) ════════");return;}
    const {data:j}=await a.from("agent_jobs").select("id,status,error").eq("workspace_id",WS).ilike("spec_slug","max-qc-grades%").order("created_at",{ascending:false}).limit(2);
    const parked=((j??[]) as any[]).find(x=>["needs_attention","failed"].includes(x.status));
    if(parked && i>2){console.log(`\n════════ D RE-PARKED (${parked.status}) — ${(parked.error||"").slice(0,120)} ════════`);return;}
    if(i%4===0){const st=((j??[]) as any[]).map(x=>x.status).join(",");console.log(`[${new Date().toISOString().slice(11,19)}] D jobs: ${st||"-"} (P1 on main: no)`);}
    await sleep(90000);
  }
  console.log("\n════════ D watch timed out — check manually ════════");
}
main().catch(e=>{console.error("threw:",e instanceof Error?e.message:String(e));});
