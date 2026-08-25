/** Current active iteration policy decision-tree thresholds. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const { data, error } = await admin.from("iteration_policies")
    .select("*").eq("workspace_id", WS).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) { console.log("no policy"); return; }
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === "" || k === "id" || k === "workspace_id") continue;
    console.log(`  ${k.padEnd(42)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
