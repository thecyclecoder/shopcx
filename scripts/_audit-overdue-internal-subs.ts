/**
 * Read-only: for every OVERDUE active internal sub, decide whether it is LEGITIMATELY deferred
 * or genuinely STUCK.
 *
 * Per docs/brain/inngest/internal-subscription-renewals.md the cron intentionally skips a
 * candidate whose active dunning cycle has `next_retry_at` strictly in the future — dunning owns
 * when the next failed-payment retry is allowed. Two documented holds also park a sub WITHOUT
 * advancing `next_billing_date` (overcharge guard, no-recipient-name), which is by design and
 * expects a human.
 *
 * So "overdue" alone proves nothing. This classifies each one.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const P = (s: unknown, n: number) => String(s).slice(0, n).padEnd(n);

async function main() {
  const admin = createAdminClient();
  const now = new Date();

  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, customer_id, status, next_billing_date, last_payment_status, comp, items")
    .eq("workspace_id", WS).eq("is_internal", true).eq("status", "active");
  const overdue = (subs ?? [])
    .filter((s) => s.next_billing_date && new Date(s.next_billing_date) < now)
    .map((s) => ({ ...s, daysLate: Math.floor((now.getTime() - new Date(s.next_billing_date as string).getTime()) / 86400000) }))
    .sort((a, b) => b.daysLate - a.daysLate);

  const ids = overdue.map((s) => s.id);

  // dunning cycles — the legitimate deferral
  const { data: cycles } = await admin
    .from("dunning_cycles")
    .select("subscription_id, status, cycle_number, next_retry_at, recovered_at, paused_at, created_at")
    .eq("workspace_id", WS).in("subscription_id", ids);
  const cycleBySub = new Map<string, Record<string, unknown>[]>();
  for (const c of cycles ?? []) {
    const k = String(c.subscription_id);
    if (!cycleBySub.has(k)) cycleBySub.set(k, []);
    cycleBySub.get(k)!.push(c);
  }

  // documented holds live in customer_events.properties (NOT a subscription_id column)
  const { data: evs } = await admin
    .from("customer_events")
    .select("event_type, created_at, properties")
    .eq("workspace_id", WS)
    .in("event_type", [
      "subscription.renewal_held_overcharge_guard",
      "subscription.renewal_blocked_no_recipient_name",
      "subscription.comp_renewal_failed",
      "subscription.payment_failed",
    ])
    .gte("created_at", new Date(now.getTime() - 90 * 86400000).toISOString())
    .order("created_at", { ascending: false });
  const holdBySub = new Map<string, { type: string; at: string }>();
  const holdCounts = new Map<string, number>();
  for (const e of evs ?? []) {
    const sid = String((e.properties as Record<string, unknown> | null)?.subscription_id ?? "");
    holdCounts.set(e.event_type, (holdCounts.get(e.event_type) ?? 0) + 1);
    if (!sid) continue;
    if (!holdBySub.has(sid)) holdBySub.set(sid, { type: e.event_type, at: String(e.created_at) });
  }
  console.log("renewal-path events in the last 90d (by type):");
  for (const [k, v] of [...holdCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${P(k, 50)} ${v}`);

  // last renewal order per overdue sub
  const { data: ords } = await admin
    .from("orders").select("subscription_id, created_at, financial_status")
    .eq("workspace_id", WS).in("subscription_id", ids)
    .in("source_name", ["internal_subscription_renewal", "internal_subscription_comp_renewal"])
    .order("created_at", { ascending: false });
  const lastOrder = new Map<string, string>();
  for (const o of ords ?? []) if (!lastOrder.has(String(o.subscription_id))) lastOrder.set(String(o.subscription_id), String(o.created_at));

  console.log(`\n=== ${overdue.length} OVERDUE active internal subs — classified ===\n`);
  const verdictCount = new Map<string, number>();
  for (const s of overdue) {
    const cs = (cycleBySub.get(String(s.id)) ?? []) as Record<string, unknown>[];
    const openCycle = cs.find((c) => ["retrying", "active"].includes(String(c.status)));
    const retryAt = openCycle?.next_retry_at ? new Date(String(openCycle.next_retry_at)) : null;
    const hold = holdBySub.get(String(s.id));

    let verdict: string;
    if (openCycle && retryAt && retryAt > now) verdict = "DEFERRED (dunning retry window)";
    else if (openCycle) verdict = "IN DUNNING (retry due — should re-attempt)";
    else if (hold) verdict = `HELD (${hold.type.replace("subscription.", "")})`;
    else verdict = "⚠ UNEXPLAINED";
    verdictCount.set(verdict, (verdictCount.get(verdict) ?? 0) + 1);

    console.log(
      `${P(s.id, 38)} ${String(s.daysLate).padStart(3)}d late  pay=${P(s.last_payment_status ?? "—", 10)} ` +
        `cycles=${cs.length}${openCycle ? `/${openCycle.status}` : ""} ${retryAt ? `retry ${retryAt.toISOString().slice(0, 10)}` : ""}`,
    );
    console.log(`   last renewal order: ${lastOrder.get(String(s.id))?.slice(0, 10) ?? "NONE"}   → ${verdict}`);
  }

  console.log(`\n=== VERDICT SUMMARY ===`);
  for (const [k, v] of [...verdictCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${P(k, 44)} ${v}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
