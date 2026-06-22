/**
 * Read-only audit: internal subscriptions whose next_billing_date is in the
 * past but which haven't been charged for that cycle.
 *
 * The hourly scheduler advances next_billing_date ONLY on a successful charge,
 * and on a decline it fires dunning (which legitimately holds the date in the
 * past until recovery). So an active internal sub with next_billing_date < now()
 * AND no active dunning cycle is an anomaly — a renewal the scheduler missed.
 *
 *   npx tsx scripts/audit-internal-sub-overdue.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

const WS = process.env.AGENT_TODO_WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();

  // Active internal subs whose renewal date has already passed.
  const { data: overdue, error } = await admin
    .from("subscriptions")
    .select("id, customer_id, shopify_contract_id, next_billing_date, last_payment_status, billing_interval, pause_resume_at, items")
    .eq("workspace_id", WS)
    .eq("is_internal", true)
    .eq("status", "active")
    .lt("next_billing_date", nowIso)
    .order("next_billing_date", { ascending: true });

  if (error) { console.error("query error:", error.message); process.exit(1); }

  console.log(`Now: ${nowIso}`);
  console.log(`Active internal subs with next_billing_date in the past: ${(overdue || []).length}\n`);

  if (!overdue || overdue.length === 0) {
    console.log("✅ No overdue internal subs. Scheduler is current.");
    return;
  }

  const ACTIVE_DUNNING = new Set(["retrying", "active"]);
  let anomalies = 0;

  for (const s of overdue) {
    const hoursLate = (now.getTime() - new Date(s.next_billing_date).getTime()) / 3.6e6;

    // Is there an active dunning cycle holding this date intentionally?
    const { data: cycles } = await admin
      .from("dunning_cycles")
      .select("id, status, next_retry_at, created_at")
      .eq("subscription_id", s.id)
      .order("created_at", { ascending: false })
      .limit(1);
    const cycle = cycles?.[0];
    const inDunning = cycle && ACTIVE_DUNNING.has(cycle.status);

    // Most recent renewal transaction, for context.
    const { data: txns } = await admin
      .from("transactions")
      .select("status, type, amount_cents, attempted_at, processor_response_text")
      .eq("subscription_id", s.id)
      .order("attempted_at", { ascending: false })
      .limit(1);
    const lastTxn = txns?.[0];

    const flag = inDunning ? "  (in dunning — expected)" : "⚠️  ANOMALY — not in dunning";
    if (!inDunning) anomalies++;

    console.log(`${flag}`);
    console.log(`  sub ${s.id}  cust ${s.customer_id}`);
    console.log(`  next_billing_date ${s.next_billing_date}  (${hoursLate.toFixed(1)}h late, every ${s.billing_interval})`);
    console.log(`  last_payment_status=${s.last_payment_status ?? "—"}  pause_resume_at=${s.pause_resume_at ?? "—"}  items=${(s.items as any[])?.length ?? 0}`);
    console.log(`  dunning: ${cycle ? `${cycle.status} next_retry=${cycle.next_retry_at ?? "—"}` : "none"}`);
    console.log(`  last txn: ${lastTxn ? `${lastTxn.type}/${lastTxn.status} $${((lastTxn.amount_cents ?? 0) / 100).toFixed(2)} @ ${lastTxn.attempted_at} ${lastTxn.processor_response_text ?? ""}` : "none"}`);
    console.log("");
  }

  console.log(`=== ${anomalies} anomaly(ies): overdue, active, NOT in dunning ===`);
})().catch((e) => console.error("ERR:", e.message));
