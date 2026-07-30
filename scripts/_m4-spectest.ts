import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){const admin=createAdminClient();
 const { data }=await admin.from("spec_test_runs").select("run_at,agent_verdict,spec_branch,preview_url,summary").eq("workspace_id",WS).eq("spec_slug","mario-reactive-box-agent").order("run_at",{ascending:false}).limit(3);
 for(const r of (data??[]) as any[]){console.log(`[${r.agent_verdict}] ${r.run_at} branch=${r.spec_branch??"-"}`);console.log(`  ${String(r.summary??"").slice(0,400)}`);}
 // latest updated_at on the spec to gauge staleness
 const { data:s }=await admin.from("specs").select("updated_at").eq("workspace_id",WS).eq("slug","mario-reactive-box-agent").single();
 console.log("\nspec.updated_at:", (s as any)?.updated_at, "(now-ish:", new Date().toISOString(),")");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
