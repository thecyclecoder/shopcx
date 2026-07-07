import "./_bootstrap";
import { getSpec } from "../src/lib/specs-table";
async function main(){
  const s:any=await getSpec("fdc11e10-b89f-4989-8b73-ed6526c4d906","orchestrator-handler-alias-catalog-for-no-handler-misses");
  console.log("title:", s.title);
  console.log("owner:", s.owner, "milestone_id:", s.milestone_id, "blocked_by:", JSON.stringify(s.blocked_by));
  console.log("parent:", s.parent);
  console.log("why:", s.why);
  console.log("what:", s.what);
  console.log("summary:", s.summary);
  console.log("\n--- PHASES ---");
  for(const p of s.phases||[]){
    console.log(`\n## ${p.title}`);
    console.log("why:", p.why); console.log("what:", p.what);
    console.log("body:", p.body);
    console.log("verification:", p.verification);
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
