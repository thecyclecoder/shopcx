/**
 * The REAL fraud surface: fraud_cases + the /dashboard/fraud queue, worked daily.
 *
 * My earlier probe looked for fraud_signals / fraud_decisions / order_fraud_reviews, found none,
 * and wrongly concluded fraud had no working surface. It does. So the question becomes the same one
 * chargebacks answered: is the `fraud_alert` NOTIFICATION a duplicate pointer at a case that has
 * already been resolved on its own surface?
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();

  const { data: one, error } = await a.from("fraud_cases").select("*").eq("workspace_id", WS).limit(1).maybeSingle();
  if (error) throw new Error(`fraud_cases: ${error.message}`);
  console.log(`fraud_cases columns: ${Object.keys(one ?? {}).join(", ")}`);

  const rows: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error: e } = await a.from("fraud_cases").select("*").eq("workspace_id", WS).range(off, off + 999);
    if (e) throw new Error(e.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  console.log(`\nfraud_cases rows: ${rows.length}`);

  const statusCol = Object.keys(one ?? {}).find((k) => /^status$/i.test(k)) ?? "status";
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[String(r[statusCol])] = (byStatus[String(r[statusCol])] ?? 0) + 1;
  console.log(`by ${statusCol}: ${JSON.stringify(byStatus)}`);

  // Is the queue actually being worked? Look at the action log.
  const { count: actions } = await a.from("fraud_action_log").select("id", { count: "exact", head: true }).eq("workspace_id", WS);
  const { data: recentActions } = await a.from("fraud_action_log")
    .select("*").eq("workspace_id", WS).order("created_at", { ascending: false }).limit(5);
  console.log(`\nfraud_action_log: ${actions} row(s)`);
  for (const r of recentActions ?? []) {
    const keys = Object.keys(r).filter((k) => !/^(id|workspace_id)$/.test(k));
    console.log(`  ${keys.map((k) => `${k}=${String(r[k]).slice(0, 40)}`).join(" · ").slice(0, 190)}`);
  }

  // ── the link: does a fraud_alert notification point at a case? ────────────
  const { data: notifs } = await a.from("dashboard_notifications")
    .select("id,title,metadata,created_at").eq("workspace_id", WS)
    .eq("type", "fraud_alert").eq("dismissed", false).order("created_at", { ascending: false }).limit(2000);
  console.log(`\nopen fraud_alert notifications: ${(notifs ?? []).length}`);
  const mdKeys = new Set<string>();
  const entityTypes: Record<string, number> = {};
  for (const n of notifs ?? []) {
    const md = (n.metadata ?? {}) as Record<string, unknown>;
    Object.keys(md).forEach((k) => mdKeys.add(k));
    entityTypes[String(md.entity_type ?? "—")] = (entityTypes[String(md.entity_type ?? "—")] ?? 0) + 1;
  }
  console.log(`  metadata keys: ${[...mdKeys].join(", ")}`);
  console.log(`  entity_type: ${JSON.stringify(entityTypes)}`);

  // Can we resolve entity_id → a case, and is that case closed?
  const ids = [...new Set((notifs ?? []).map((n) => String((n.metadata as Record<string, unknown>)?.entity_id ?? "")).filter(Boolean))];
  console.log(`  distinct entity_id: ${ids.length}`);
  for (const tbl of ["fraud_cases", "orders"]) {
    const { data: hit } = await a.from(tbl).select("id").eq("workspace_id", WS).in("id", ids.slice(0, 200));
    console.log(`    resolve against ${tbl}: ${(hit ?? []).length}/${Math.min(200, ids.length)} matched`);
  }

  // How many notifications per case/order — the granularity question.
  const perEntity: Record<string, number> = {};
  for (const n of notifs ?? []) {
    const k = String((n.metadata as Record<string, unknown>)?.entity_id ?? "—");
    perEntity[k] = (perEntity[k] ?? 0) + 1;
  }
  const multi = Object.entries(perEntity).filter(([, v]) => v > 1).sort((x, y) => y[1] - x[1]);
  console.log(`\n  entities with >1 alert: ${multi.length}`);
  for (const [k, v] of multi.slice(0, 6)) console.log(`    ${k.slice(0, 40)} → ${v} alerts`);
  const total = (notifs ?? []).length;
  const distinct = Object.keys(perEntity).length;
  console.log(`  ⇒ ${total} alerts across ${distinct} entities (${(total / Math.max(1, distinct)).toFixed(1)} per entity)`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
