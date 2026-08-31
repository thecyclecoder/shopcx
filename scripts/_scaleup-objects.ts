/** What object_id/level did the Aug-24 scale_up actions record? READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const { data, error } = await admin.from("iteration_actions")
    .select("created_at,level,object_id,action_type,label,status,before_budget_cents,after_budget_cents,rationale")
    .eq("workspace_id", WS).gte("created_at", "2026-08-18T00:00:00Z")
    .in("action_type", ["scale_up", "scale_down"]).order("created_at");
  if (error) throw new Error(error.message);

  console.log(`scale actions since Aug 18: ${(data ?? []).length}\n`);
  for (const a of data ?? []) {
    console.log(`${String(a.created_at).slice(0, 16)}  ${a.action_type}  level=${a.level}  object_id=${a.object_id}`);
    console.log(`   budget ${a.before_budget_cents != null ? "$" + (Number(a.before_budget_cents) / 100).toFixed(0) : "—"} → ${a.after_budget_cents != null ? "$" + (Number(a.after_budget_cents) / 100).toFixed(0) : "—"}  [${a.status}]`);
    console.log(`   ${a.rationale}\n`);
  }

  // Is each object_id an ad, an adset, or a campaign?
  const ids = [...new Set((data ?? []).map((a) => String(a.object_id)))];
  const { data: asets } = await admin.from("meta_adsets").select("meta_adset_id,meta_campaign_id")
    .eq("workspace_id", WS).in("meta_adset_id", ids);
  console.log("object_id resolution:");
  for (const id of ids) {
    const asRow = (asets ?? []).find((x) => String(x.meta_adset_id) === id);
    console.log(`  ${id}  ${asRow ? `= ADSET in campaign ${asRow.meta_campaign_id}` : "= not an adset row (ad-grain or unsynced)"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
