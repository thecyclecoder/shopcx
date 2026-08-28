/**
 * Are the never-dismissed notification types DUPLICATE LOGS, or an UNWORKED QUEUE?
 *
 * The recommendation turns entirely on this. If fraud/chargeback alerts are already handled on a
 * real surface, the notification is a redundant log line and should expire. If they are NOT handled
 * anywhere, then 609 fraud alerts and 136 chargebacks are unworked business risk, and auto-expiring
 * them would hide a real problem rather than fix a cosmetic one.
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function count(a: ReturnType<typeof createAdminClient>, t: string, f?: (q: never) => never) {
  const { count: n, error } = await a.from(t).select("id", { count: "exact", head: true }).eq("workspace_id", WS);
  return error ? `— (${error.message.slice(0, 40)})` : String(n ?? 0);
}

async function main() {
  const a = createAdminClient();

  // ── chargebacks: is there a real working surface? ─────────────────────────
  console.log("=== CHARGEBACKS ===");
  console.log(`  chargeback_alert notifications (open):  136`);
  for (const t of ["chargeback_events", "chargeback_subscription_actions"]) {
    console.log(`  ${t.padEnd(38)} ${await count(a, t)} row(s)`);
  }
  const { data: ce, error: cee } = await a.from("chargeback_events")
    .select("*").eq("workspace_id", WS).order("created_at", { ascending: false }).limit(3);
  if (!cee && (ce ?? []).length) {
    console.log(`  columns: ${Object.keys(ce![0]).join(", ").slice(0, 200)}`);
    for (const r of ce ?? []) {
      const st = Object.entries(r).filter(([k]) => /status|state|outcome|resolved|disput/i.test(k));
      console.log(`    ${String(r.created_at).slice(0, 10)} ${st.map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
  }

  // ── fraud: is a decision recorded anywhere? ───────────────────────────────
  console.log("\n=== FRAUD ===");
  console.log(`  fraud_alert notifications (open):       609`);
  for (const t of ["fraud_signals", "fraud_decisions", "order_fraud_reviews", "orders"]) {
    const { count: n, error } = await a.from(t).select("id", { count: "exact", head: true }).eq("workspace_id", WS);
    console.log(`  ${t.padEnd(38)} ${error ? "no such table" : n}`);
  }
  // Do the fraud notifications carry an order we can check the disposition of?
  const { data: fa } = await a.from("dashboard_notifications")
    .select("title,metadata,created_at").eq("workspace_id", WS).eq("type", "fraud_alert")
    .eq("dismissed", false).order("created_at", { ascending: false }).limit(3);
  for (const f of fa ?? []) {
    const md = (f.metadata ?? {}) as Record<string, unknown>;
    console.log(`    [${String(f.created_at).slice(0, 10)}] ${String(f.title).slice(0, 70)}`);
    console.log(`        metadata keys: ${Object.keys(md).join(", ").slice(0, 160)}`);
  }

  // ── are these ALSO going to Slack / elsewhere? ────────────────────────────
  console.log("\n=== IS THERE ANOTHER DELIVERY PATH? ===");
  const { data: rules, error: re } = await a.from("slack_notification_rules")
    .select("*").eq("workspace_id", WS);
  if (re) console.log(`  slack_notification_rules: ${re.message}`);
  else {
    console.log(`  slack_notification_rules: ${(rules ?? []).length} rule(s)`);
    for (const r of rules ?? []) {
      const keys = Object.keys(r).filter((k) => !/^(id|workspace_id|created_at|updated_at)$/.test(k));
      console.log(`    ${keys.map((k) => `${k}=${String(r[k]).slice(0, 40)}`).join(" · ").slice(0, 200)}`);
    }
  }

  // ── read state: are they even being LOOKED at? ────────────────────────────
  console.log("\n=== ARE THEY READ? (read flag on open rows) ===");
  for (const t of ["fraud_alert", "chargeback_alert", "agent_daily_summary", "system"]) {
    const { count: openN } = await a.from("dashboard_notifications")
      .select("id", { count: "exact", head: true }).eq("workspace_id", WS).eq("type", t).eq("dismissed", false);
    const { count: readN } = await a.from("dashboard_notifications")
      .select("id", { count: "exact", head: true }).eq("workspace_id", WS).eq("type", t).eq("dismissed", false).eq("read", true);
    console.log(`  ${t.padEnd(22)} ${String(openN ?? 0).padStart(5)} open · ${String(readN ?? 0).padStart(5)} read (${openN ? (100 * (readN ?? 0) / openN).toFixed(0) : "—"}%)`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
