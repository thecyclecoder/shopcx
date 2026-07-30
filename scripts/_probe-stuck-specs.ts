import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS = ["director-sms-cockpit-per-director","claim-rpc-kill-switch-enforcement","dahlia-audience-temperature-marking-and-cold-offer-gate"];
async function main(){
  const admin = createAdminClient();
  for (const slug of SLUGS){
    const s:any = await getSpec(WS, slug);
    console.log(`\n=== ${slug} ===`);
    if (!s){ console.log("  NOT FOUND in specs"); }
    else {
      console.log(`  stored status=${s.status}  intended=${s.intended_status}  deferred=${s.deferred}  auto_build=${s.auto_build}`);
      console.log(`  merged_pr=${s.merged_pr}  last_merge_sha=${s.last_merge_sha}  updated=${s.updated_at}`);
      console.log(`  phases: ${(s.phases||[]).map((p:any)=>`${p.title?.slice(0,24)}=${p.status}`).join(" | ")}`);
    }
    // agent_jobs referencing this slug
    const { data: jobs } = await admin.from("agent_jobs")
      .select("id,kind,status,updated_at,created_at").eq("workspace_id", WS).eq("spec_slug", slug)
      .order("updated_at",{ascending:false}).limit(6);
    console.log(`  agent_jobs (${jobs?.length??0}):`);
    for (const j of jobs||[]) console.log(`     [${j.status}] kind=${j.kind} updated=${j.updated_at}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
