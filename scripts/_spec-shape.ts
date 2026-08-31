/** Read a recent well-formed spec's phase shape (verification / why / what). READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();
  const { data: spec } = await a.from("specs")
    .select("id,slug,title,why,what,priority,owner,parent,parent_kind,parent_ref,auto_build,status")
    .eq("workspace_id", WS).eq("slug", "ready-to-test-bin-excludes-draft-campaigns").maybeSingle();
  console.log("SPEC ROW:");
  for (const [k, v] of Object.entries(spec ?? {})) console.log(`  ${k.padEnd(14)} ${String(v).slice(0, 220)}`);

  const { data: phases } = await a.from("spec_phases")
    .select("position,title,status,why,what,verification,body").eq("spec_id", String(spec?.id)).order("position");
  for (const p of phases ?? []) {
    console.log(`\n--- PHASE ${p.position}: ${p.title} [${p.status}] ---`);
    console.log(`  why:  ${String(p.why ?? "").slice(0, 200)}`);
    console.log(`  what: ${String(p.what ?? "").slice(0, 200)}`);
    console.log(`  verification:\n${String(p.verification ?? "").slice(0, 700)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
