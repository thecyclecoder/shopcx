/**
 * Read-only audit of the INTERNAL subscription renewal system (`subscriptions.is_internal = true`
 * only — Appstle-backed subs are explicitly excluded).
 *
 * Columns taken from docs/brain/tables/subscriptions.md and the renewal contract from
 * docs/brain/inngest/internal-subscription-renewals.md — not guessed.
 *
 * Asks: is anything DUE that never renewed, is anything HELD, and does the outcome mix look
 * healthy? An empty result here is reported as empty, never interpreted as "fine".
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const P = (s: unknown, n: number) => String(s).slice(0, n).padEnd(n);
const L = (s: unknown, n: number) => String(s).slice(0, n).padStart(n);

async function main() {
  const admin = createAdminClient();
  const now = new Date();

  // ── shape first: how many internal subs, and what statuses actually exist ──
  const { data: subs, error } = await admin
    .from("subscriptions")
    .select("id, customer_id, status, next_billing_date, billing_interval, billing_interval_count, comp, items, last_payment_status, pause_resume_at, updated_at, created_at, shopify_contract_id")
    .eq("workspace_id", WS)
    .eq("is_internal", true);
  if (error) throw new Error(`subscriptions: ${error.message}`);
  console.log(`internal subscriptions (is_internal=true): ${subs?.length ?? 0}`);
  if (!subs?.length) {
    console.log("⚠ ZERO rows — verify the filter before concluding anything.");
    return;
  }

  const byStatus = new Map<string, number>();
  for (const s of subs) byStatus.set(String(s.status), (byStatus.get(String(s.status)) ?? 0) + 1);
  console.log(`  by status: ${[...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  console.log(`  comp: ${subs.filter((s) => s.comp).length} · paid: ${subs.filter((s) => !s.comp).length}`);

  // ── THE integrity check: active subs whose next_billing_date is in the past ──
  // The cron runs daily at 09:00 UTC, so anything more than ~1 day overdue never advanced.
  const active = subs.filter((s) => s.status === "active");
  const overdue = active
    .filter((s) => s.next_billing_date && new Date(s.next_billing_date) < now)
    .map((s) => ({ ...s, daysLate: Math.floor((now.getTime() - new Date(s.next_billing_date as string).getTime()) / 86400000) }))
    .sort((a, b) => b.daysLate - a.daysLate);

  console.log(`\n=== OVERDUE (status=active, next_billing_date in the past) ===`);
  console.log(`${overdue.length} of ${active.length} active internal subs`);
  if (overdue.length) {
    console.log(`\n${P("subscription", 38)}${L("days late", 10)}${L("comp", 6)}  ${P("next_billing_date", 26)}last_payment_status`);
    for (const s of overdue.slice(0, 40))
      console.log(P(s.id, 38) + L(s.daysLate, 10) + L(s.comp ? "yes" : "", 6) + "  " + P(s.next_billing_date, 26) + (s.last_payment_status ?? "—"));
  }

  const missingDate = active.filter((s) => !s.next_billing_date);
  console.log(`\nactive with NO next_billing_date: ${missingDate.length}${missingDate.length ? " ⚠ these can never be picked up" : ""}`);
  for (const s of missingDate.slice(0, 10)) console.log(`   ${s.id} created ${String(s.created_at).slice(0, 10)}`);

  // ── holds + failures the renewal path logs to customer_events ──
  const EVENTS = [
    "subscription.renewal_held_overcharge_guard",
    "subscription.renewal_blocked_no_recipient_name",
    "subscription.comp_renewal_failed",
    "subscription.payment_failed",
    "subscription.comp_shipped",
  ];
  console.log(`\n=== customer_events from the renewal path (last 60d) ===`);
  const since = new Date(now.getTime() - 60 * 86400000).toISOString();
  for (const ev of EVENTS) {
    const { data, error: e } = await admin
      .from("customer_events")
      .select("id, created_at, subscription_id, needs_attention")
      .eq("workspace_id", WS).eq("event_type", ev).gte("created_at", since)
      .order("created_at", { ascending: false });
    if (e) { console.log(`  ${P(ev, 48)} query error: ${e.message.slice(0, 60)}`); continue; }
    const open = (data ?? []).filter((r) => r.needs_attention).length;
    console.log(`  ${P(ev, 48)} ${L(data?.length ?? 0, 4)}${open ? `   ⚠ ${open} needs_attention` : ""}`);
    for (const r of (data ?? []).filter((x) => x.needs_attention).slice(0, 5))
      console.log(`        ${String(r.created_at).slice(0, 10)}  sub ${r.subscription_id}`);
  }

  // ── did renewals actually produce orders + transactions? ──
  console.log(`\n=== renewal ORDERS by month (source_name) ===`);
  const { data: orders } = await admin
    .from("orders")
    .select("created_at, source_name, total_cents, financial_status")
    .eq("workspace_id", WS)
    .in("source_name", ["internal_subscription_renewal", "internal_subscription_comp_renewal"])
    .gte("created_at", new Date(now.getTime() - 120 * 86400000).toISOString())
    .order("created_at");
  const byMonth = new Map<string, { n: number; cents: number; src: Set<string> }>();
  for (const o of orders ?? []) {
    const m = String(o.created_at).slice(0, 7);
    const cur = byMonth.get(m) ?? { n: 0, cents: 0, src: new Set<string>() };
    cur.n++; cur.cents += Number(o.total_cents ?? 0); cur.src.add(String(o.source_name));
    byMonth.set(m, cur);
  }
  if (!byMonth.size) console.log("  (no renewal orders in the last 120 days)");
  for (const [m, v] of [...byMonth.entries()].sort())
    console.log(`  ${m}  ${L(v.n, 4)} orders  $${(v.cents / 100).toFixed(2).padStart(10)}  [${[...v.src].join(", ")}]`);

  // ── per-sub: when did each active sub last actually renew? ──
  console.log(`\n=== active PAID subs with no renewal order in 60d ===`);
  const { data: recent } = await admin
    .from("orders").select("subscription_id, created_at")
    .eq("workspace_id", WS)
    .in("source_name", ["internal_subscription_renewal", "internal_subscription_comp_renewal"])
    .gte("created_at", since);
  const renewedRecently = new Set((recent ?? []).map((o) => String(o.subscription_id)));
  const stale = active.filter((s) => !renewedRecently.has(String(s.id)));
  console.log(`${stale.length} of ${active.length} active`);
  for (const s of stale.slice(0, 25))
    console.log(`   ${P(s.id, 38)} next ${P(String(s.next_billing_date).slice(0, 10), 12)} interval ${s.billing_interval_count ?? ""} ${s.billing_interval ?? "—"} ${s.comp ? "(comp)" : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
