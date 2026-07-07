import { createAdminClient } from "./_bootstrap";
const SLUGS=["orchestrator-handler-alias-catalog-for-no-handler-misses","model-picker-routes-on-state-not-tags-ltv-stops-buying-opus"];
async function main(){const a=createAdminClient();
  // spec-review jobs for these slugs
  const {data:jobs}=await a.from("agent_jobs").select("id,kind,status,spec_slug,session_note,log_tail,error,updated_at")
    .eq("kind","spec-review").in("spec_slug",SLUGS).order("updated_at",{ascending:false});
  console.log(`spec-review jobs: ${(jobs||[]).length}`);
  for(const j of jobs||[]){
    console.log(`\n──── ${j.spec_slug}  [${j.status}]`);
    if(j.session_note) console.log("  session_note:", j.session_note);
    if(j.error) console.log("  error:", j.error);
    if(j.log_tail) console.log("  log_tail:", String(j.log_tail).slice(-1200));
  }
  // any notification / coaching thread carrying the diagnosis
  const {data:notes}=await a.from("dashboard_notifications").select("title,body,metadata")
    .or(SLUGS.map(s=>`metadata->>spec_slug.eq.${s}`).join(","))
    .order("created_at",{ascending:false}).limit(10);
  console.log(`\nnotifications referencing these slugs: ${(notes||[]).length}`);
  for(const n of notes||[]) console.log(`  [${(n.metadata as any)?.kind}] ${n.title} :: ${(n.body||'').slice(0,200)}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
