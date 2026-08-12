/**
 * Read-only: did the out-of-band renewal attempts actually land?
 *
 * Checks the three things that must ALL move for a renewal to be real: an outcome heartbeat, a
 * paid order, and an advanced `next_billing_date`. A sub that charged but never advanced would
 * re-charge on the next cron tick, so the calendar is as important as the money.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SUBS: Record<string, string> = {
  "2ff698dc-3865-4996-a7a6-5f283ffbc050": "Carol Wisemen (was due 2026-07-19)",
  "851034c9-983a-4d49-b335-ac365b835bfb": "Veena Singh (was due 2026-07-20)",
  "7a42e8fd-55f4-44e0-b63f-0fb4afe952d4": "Laurie Predmore (was due 2026-07-23)",
};

async function main() {
  const admin = createAdminClient();
  const since = new Date(Date.now() - 30 * 60000).toISOString();

  const { data: beats } = await admin
    .from("loop_heartbeats").select("ran_at, produced")
    .eq("loop_id", "internal-subscription-renewal-outcome").gte("ran_at", since).order("ran_at");
  console.log(`outcome beats in the last 30m: ${beats?.length ?? 0}`);
  for (const b of beats ?? []) console.log(`   ${String(b.ran_at).slice(11, 19)}  ${(b.produced as { outcome?: string })?.outcome ?? "(none)"}`);

  console.log(`\nper-subscription result:`);
  for (const [id, who] of Object.entries(SUBS)) {
    const { data: s } = await admin
      .from("subscriptions").select("next_billing_date, last_payment_status, updated_at").eq("id", id).maybeSingle();
    const { data: ords } = await admin
      .from("orders").select("order_number, created_at, total_cents, financial_status, source_name")
      .eq("workspace_id", WS).eq("subscription_id", id).gte("created_at", since).order("created_at", { ascending: false });
    const { data: txns } = await admin
      .from("transactions").select("type, status, amount_cents, created_at")
      .eq("workspace_id", WS).eq("subscription_id", id).gte("created_at", since).order("created_at", { ascending: false });

    const advanced = s?.next_billing_date && new Date(s.next_billing_date) > new Date();
    console.log(`\n${who}`);
    console.log(`   next_billing_date : ${String(s?.next_billing_date).slice(0, 10)} ${advanced ? "✓ ADVANCED (future)" : "⚠ still in the past"}`);
    console.log(`   last_payment_status: ${s?.last_payment_status ?? "—"}`);
    console.log(`   new order(s)      : ${ords?.length ? ords.map((o) => `${o.order_number} $${(Number(o.total_cents) / 100).toFixed(2)} ${o.financial_status}`).join(", ") : "none"}`);
    console.log(`   new transaction(s): ${txns?.length ? txns.map((t) => `${t.type}/${t.status} $${(Number(t.amount_cents) / 100).toFixed(2)}`).join(", ") : "none"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
