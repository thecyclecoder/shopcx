import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const db=createAdminClient();
  const {data:sol}=await db.from("specs").select("slug,status,vale_pass,blocked_by,auto_build").ilike("slug","sol-%").order("slug");
  console.log("=== Sol goal specs — status + latest job ===");
  for(const s of sol||[]){
    const slug=(s as any).slug;
    const full=await getSpec(WS,slug);
    const ph=(full?.phases||[]).map((p:any)=>p.status[0]).join("");
    const {data:jobs}=await db.from("agent_jobs").select("kind,status,created_at").eq("spec_slug",slug).order("created_at",{ascending:false}).limit(1);
    const j=(jobs||[])[0];
    console.log(`  ${slug.replace('sol-','').slice(0,44).padEnd(44)} phases[${ph}] vale=${(s as any).vale_pass} auto_build=${(s as any).auto_build} | latest job: ${j?`${(j as any).kind}=${(j as any).status} @${(j as any).created_at?.slice(11,19)}`:'(none)'}`);
  }
  // any in-flight sol build jobs
  const {data:live}=await db.from("agent_jobs").select("spec_slug,kind,status").ilike("spec_slug","sol-%").in("status",["queued","building","claimed","needs_approval","needs_input","failed"]).order("created_at",{ascending:false}).limit(15);
  console.log("\n=== active/blocked sol build jobs ===");
  for(const j of live||[]) console.log(`  [${(j as any).status}] ${(j as any).kind} ${(j as any).spec_slug?.replace('sol-','')}`);
  if(!(live||[]).length) console.log("  (none active)");
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
