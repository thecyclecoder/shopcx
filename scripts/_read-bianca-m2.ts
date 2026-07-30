import { loadEnv } from "./_bootstrap";
loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const s:any = await getSpec(WS, "bianca-cold-test-recent-purchaser-exclusion");
  if (!s){ console.log("NOT FOUND"); return; }
  console.log("owner=",s.owner,"parent_kind=",s.parent_kind,"parent_ref=",s.parent_ref);
  console.log("milestone_id=",s.milestone_id,"auto_build=",s.auto_build,"deferred=",s.deferred);
  console.log("blocked_by=",JSON.stringify(s.blocked_by));
  console.log("intended_status=",s.intended_status,"status=",s.status);
  console.log("\nWHY:",s.why);
  console.log("\nWHAT:",s.what);
  console.log("\nSUMMARY:",s.summary);
  console.log("\nPHASES:");
  for (const p of s.phases||[]) console.log(`  [${p.position}] ${p.title} (${p.status})\n     why: ${(p.why||"").slice(0,200)}\n     what: ${(p.what||"").slice(0,300)}\n     verify: ${(p.verification||"").slice(0,200)}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
