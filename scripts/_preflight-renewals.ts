/**
 * Pre-flight the renewal cron against the migrated cohort WITHOUT charging anything.
 *
 * Replays exactly what the cron does — candidate selection, then per-sub cycle resolution against
 * Shopify — for a simulated run date. Everything up to `shopifyAttemptBilling` is a read, so this
 * proves the 22nd will work while there is still time to fix it if it will not.
 *
 *   npx tsx scripts/_preflight-renewals.ts --on 2026-09-22
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSubscriptionContract, getBillingCycleForDate } from "../src/lib/commerce/shopify-subscription-client";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const DUE_GRACE_MS = 6 * 60 * 60 * 1000;

async function main() {
  const admin = createAdminClient();
  const dates = arg("--on") ? [arg("--on")!] : ["2026-09-22","2026-09-23","2026-09-24","2026-09-25","2026-09-26","2026-09-27","2026-09-28"];

  for (const day of dates) {
    // the cron's own window: everything due by end of the run day
    const endOfDay = new Date(`${day}T23:59:59.999Z`);
    const { data: due, error } = await admin
      .from("subscriptions")
      .select("id, shopify_contract_id, next_billing_date, migrated_from_contract_id, items")
      .eq("workspace_id", WS)
      .eq("billing_source", "shopcx")
      .eq("status", "active")
      .not("shopify_contract_id", "is", null)
      .lte("next_billing_date", endOfDay.toISOString())
      .order("id");
    if (error) throw new Error(error.message);

    // exclude ones an earlier simulated day already covered
    const startOfDay = new Date(`${day}T00:00:00.000Z`);
    const todays = (due ?? []).filter((s) => new Date(s.next_billing_date!) >= startOfDay || dates.length === 1);
    const cohort = todays.filter((s) => s.migrated_from_contract_id);
    console.log(`\n=== ${day}: cron would select ${due?.length} sub(s) (${cohort.length} from wave 1) ===`);

    for (const s of todays) {
      const contract = await getSubscriptionContract(WS, s.shopify_contract_id);
      if (!contract.success || !contract.contract) { console.log(`  ✗ ${s.shopify_contract_id} unreadable: ${contract.error}`); continue; }
      if (contract.contract.status !== "ACTIVE") { console.log(`  ✗ ${s.shopify_contract_id} contract_${contract.contract.status.toLowerCase()}`); continue; }

      // the worker's own clamp: a selector before createdAt is rejected by Shopify
      const created = contract.contract.createdAt ? new Date(contract.contract.createdAt).getTime() : 0;
      const dueTs = new Date(s.next_billing_date!).getTime();
      const selectorDate = created && dueTs < created ? new Date(created + 1000).toISOString() : s.next_billing_date!;
      const cyc = await getBillingCycleForDate(WS, s.shopify_contract_id, selectorDate);
      if (!cyc.success || !cyc.cycle) { console.log(`  ✗ ${s.shopify_contract_id} no cycle for ${selectorDate}: ${cyc.error}`); continue; }

      const items = (s.items as any[]) ?? [];
      const amount = items.reduce((t, i) => t + i.price_cents * i.quantity, 0);
      const spent = cyc.cycle.status === "BILLED" || cyc.cycle.skipped;
      const overdue = dueTs < Date.now() - DUE_GRACE_MS;
      const verdict = spent ? "⚠️ STRANDED — cycle already spent, would be skipped" : "✅ would charge";
      console.log(`  ${verdict}  ${s.shopify_contract_id}  cycle#${cyc.cycle.index} ${cyc.cycle.status}  $${(amount/100).toFixed(2)}${overdue ? "  (overdue)" : ""}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
