import { loadEnv } from "./_bootstrap";
loadEnv();
import { getGoal } from "../src/lib/goals-table";
async function main() {
  const g = await getGoal("fdc11e10-b89f-4989-8b73-ed6526c4d906", "mario-pipeline-plumbing");
  if (!g) { console.log("NOT FOUND"); return; }
  console.log(`GOAL  ${g.slug}  status=${g.status}  owner=${g.owner}  is_parent=${g.is_parent}`);
  console.log(`why? ${g.why ? "set" : "MISSING"}  outcome? ${g.outcome ? "set" : "MISSING"}  metric? ${g.success_metric ? "set" : "MISSING"}`);
  console.log(`milestones (${g.milestones.length}):`);
  for (const m of g.milestones) console.log(`  ${m.position}. ${m.title}  [why:${m.why?"y":"n"} what:${m.what?"y":"n"} body:${m.body?"y":"n"}]`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
