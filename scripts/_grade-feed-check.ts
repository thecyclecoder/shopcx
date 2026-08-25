/** Does the grade cron (the wiring template) actually produce rows? READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();
  console.log("feed tables:");
  for (const t of ["media_buyer_action_grades", "media_buyer_shadow_reviews", "media_buyer_sensor_trust"]) {
    const { count, error } = await a.from(t).select("id", { count: "exact", head: true }).eq("workspace_id", WS);
    console.log(`  ${t.padEnd(34)} ${error ? "ERROR " + error.message : count}`);
  }
  const { count: gj } = await a.from("agent_jobs").select("id", { count: "exact", head: true })
    .eq("workspace_id", WS).eq("kind", "media-buyer-grade");
  console.log(`  agent_jobs kind=media-buyer-grade   ${gj ?? 0}`);

  const { data: newest } = await a.from("media_buyer_action_grades")
    .select("created_at,grade,action_kind").eq("workspace_id", WS)
    .order("created_at", { ascending: false }).limit(5);
  console.log("\nnewest grades:");
  if (!(newest ?? []).length) console.log("  none");
  for (const g of newest ?? []) console.log(`  ${String(g.created_at).slice(0, 16)} ${g.action_kind} → ${g.grade}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
