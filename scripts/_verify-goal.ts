import "./_bootstrap";
import { getGoal } from "../src/lib/goals-table";
async function main(){
  const g=await getGoal("fdc11e10-b89f-4989-8b73-ed6526c4d906","guaranteed-ticket-handling");
  if(!g){console.log("NOT FOUND");return;}
  console.log(`slug=${g.slug}  owner=${g.owner}  status=${g.status}  is_parent=${(g as any).is_parent}`);
  console.log(`title: ${g.title}`);
  console.log(`milestones (${g.milestones.length}):`);
  for(const m of g.milestones) console.log(`  ${m.position}. ${m.title}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
