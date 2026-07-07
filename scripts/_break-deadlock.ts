import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const JOB="b1459c8c-c4b1-42ad-9cb3-0d0d5cd8aca9"; // playbook-compiler queued build
  // safety: only delete if still queued (not actively building)
  const {data:j}=await a.from("agent_jobs").select("status,spec_slug").eq("id",JOB).maybeSingle();
  if(!j){console.log("job already gone");return;}
  if(j.status!=="queued"){console.log(`NOT deleting — status is ${j.status} (not queued/safe)`);return;}
  const {error}=await a.from("agent_jobs").delete().eq("id",JOB).eq("status","queued");
  console.log(error?`delete FAILED: ${error.message}`:`✅ deleted playbook-compiler queued job — model-picker (earliest) is now sole candidate; serializer should build it`);
  // confirm model-picker still present + playbook gone
  const {data:after}=await a.from("agent_jobs").select("spec_slug,status").eq("kind","build").in("spec_slug",["model-picker-routes-on-state-not-tags-ltv-stops-buying-opus","playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks"]).in("status",["queued","claimed","building"]);
  console.log("remaining active build jobs:", (after||[]).map(x=>`${x.spec_slug.slice(0,20)}:${x.status}`).join(" · ")||"(none)");
}
main().catch(e=>{console.error(e.message);process.exit(1);});
