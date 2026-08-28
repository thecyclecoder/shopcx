/** Shape check before building the sweep: what links a chargeback_alert to its dispute? READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();

  const { data: cb } = await a.from("dashboard_notifications")
    .select("id,title,body,metadata,created_at,read,dismissed").eq("workspace_id", WS)
    .eq("type", "chargeback_alert").order("created_at", { ascending: false }).limit(4);
  console.log("=== chargeback_alert notifications ===");
  for (const n of cb ?? []) {
    console.log(`  [${String(n.created_at).slice(0, 10)}] ${String(n.title).slice(0, 70)}`);
    console.log(`     metadata: ${JSON.stringify(n.metadata)}`);
  }

  const { data: ev } = await a.from("chargeback_events")
    .select("*").eq("workspace_id", WS).order("created_at", { ascending: false }).limit(4);
  console.log("\n=== chargeback_events ===");
  for (const e of ev ?? []) {
    console.log(`  ${String(e.created_at).slice(0, 10)} dispute=${e.shopify_dispute_id} order=${e.shopify_order_id} status=${e.status} finalized=${e.finalized_on ?? "—"} due=${e.evidence_due_by ?? "—"} amount=$${Number(e.amount_cents ?? 0) / 100}`);
  }
  const statuses = [...new Set((ev ?? []).map((e) => String(e.status)))];
  const { data: allEv } = await a.from("chargeback_events").select("status,finalized_on").eq("workspace_id", WS);
  const byStatus: Record<string, number> = {};
  for (const e of allEv ?? []) byStatus[String(e.status)] = (byStatus[String(e.status)] ?? 0) + 1;
  console.log(`\n  all statuses in the ledger: ${JSON.stringify(byStatus)}`);
  console.log(`  finalized rows: ${(allEv ?? []).filter((e) => e.finalized_on).length} / ${(allEv ?? []).length}`);

  const { data: ds } = await a.from("dashboard_notifications")
    .select("id,title,metadata,created_at").eq("workspace_id", WS)
    .eq("type", "agent_daily_summary").order("created_at", { ascending: false }).limit(3);
  console.log("\n=== agent_daily_summary ===");
  for (const n of ds ?? []) {
    console.log(`  [${String(n.created_at).slice(0, 10)}] ${String(n.title).slice(0, 60)} · meta ${JSON.stringify(n.metadata).slice(0, 120)}`);
  }

  // Column shape for the writer.
  const { data: one } = await a.from("dashboard_notifications").select("*").eq("workspace_id", WS).limit(1).maybeSingle();
  console.log(`\ndashboard_notifications columns: ${Object.keys(one ?? {}).join(", ")}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
