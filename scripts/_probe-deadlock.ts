import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { listSpecs } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const all=await listSpecs(WS);
  for (const goal of ["bianca","dahlia"]){
    const specs=(all as any[]).filter(s=>String(s.slug).startsWith(goal+"-"));
    console.log(`\n=== ${goal} members ===`);
    for(const s of specs){
      const ph=(s.phases||[]).map((p:any)=>p.status);
      const roll= ph.every((x:string)=>x==="shipped")?"SHIPPED": ph.some((x:string)=>x.includes("progress"))?"in_progress":"planned";
      // eligibility signals
      console.log(`  ${roll.padEnd(11)} valePassed=${!!s.vale_review_passed_at} auto=${s.auto_build} blk=${(s.blocked_by||[]).length} ${s.slug}`);
    }
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
