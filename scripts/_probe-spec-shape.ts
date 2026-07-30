import { loadEnv } from "./_bootstrap";
loadEnv();
import { getSpec, listSpecs } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  for (const slug of ["growth-acquisition-roas-spine"]) {
    const s:any = await getSpec(WS, slug);
    if (!s){ console.log(`${slug}: NOT FOUND`); continue; }
    console.log(`${slug}: owner=${s.owner} parent_kind=${s.parent_kind} parent_ref=${s.parent_ref}\n  parent=${s.parent}\n  milestone_id=${s.milestone_id}`);
  }
  // find growth-owned specs to see parent conventions
  const specs = await listSpecs(WS, { owner: "growth" } as any);
  console.log(`\ngrowth-owned specs: ${specs.length}`);
  for (const s of specs.slice(0,12) as any[]) console.log(`  [${s.parent_kind ?? "?"}] ${s.parent_ref ?? "-"}  ${s.slug}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
