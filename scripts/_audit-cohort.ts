/** Full post-swap audit of the migration cohort: billing, portal, CS, drift, Appstle. */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { fetchAppstleContract } from "../src/lib/appstle-snapshot";
import { reconcileShopcxDrift } from "../src/lib/commerce/shopcx-drift-reconciler";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OLD = ["31315165357","34524233901","27894087853","27862499501","31308382381","35177660589","29318578349","27970207917","27895070893","33283965101","28184641709","27964866733","27893104813","27862728877","27825438893","27821539501","27836285101","32234864813","35728982189","27826225325","27810234541","33970946221","34054733997","27832090797","27847327917"];
const APPSTLE_CHECK = process.argv.includes("--appstle");
async function main() {
  const admin = createAdminClient();
  const { data: rows } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, migrated_from_contract_id, billing_source, status, next_billing_date, items, applied_discounts, shipping_address, customer_id")
    .eq("workspace_id", WS).in("migrated_from_contract_id", OLD);
  console.log(`swapped rows: ${rows?.length}`);

  let dupes = 0, noItems = 0, noAddr = 0, pastDue = 0;
  let cycle = 0;
  for (const r of rows ?? []) {
    const items = (r.items as any[]) ?? [];
    cycle += items.reduce((t, i) => t + i.price_cents * i.quantity, 0);
    if (!items.length) noItems++;
    if (!r.shipping_address) noAddr++;
    if (r.next_billing_date && new Date(r.next_billing_date) < new Date()) pastDue++;
    const { count } = await admin.from("subscriptions").select("*", { count: "exact", head: true })
      .eq("workspace_id", WS).eq("shopify_contract_id", r.migrated_from_contract_id!);
    if (count) dupes++;
  }
  console.log(`  duplicate old-id rows : ${dupes}  ${dupes ? "⚠️" : "✅ none"}`);
  console.log(`  rows with no items    : ${noItems} ${noItems ? "⚠️" : "✅"}`);
  console.log(`  rows with no address  : ${noAddr} ${noAddr ? "⚠️" : "✅"}`);
  console.log(`  past-due dates        : ${pastDue} ${pastDue ? "⚠️" : "✅"}`);
  console.log(`  cohort value/cycle    : $${(cycle/100).toFixed(2)}`);

  const r = await reconcileShopcxDrift(WS, {});
  console.log(`\ndrift across ALL shopcx subs: ${r.drift.length}/${r.checked}`);
  for (const d of r.drift) console.log(`  [${d.kind}] ${d.contractId}: ${d.detail.slice(0,110)}`);

  if (APPSTLE_CHECK) {
    console.log("\nappstle side (live, metered):");
    let stopped = 0, live = 0;
    for (const id of OLD.slice(0, 25)) {
      const f = await fetchAppstleContract(WS, id);
      const st = (f.raw as any)?.status;
      if (st === "CANCELLED") stopped++; else { live++; console.log(`  ⚠️ ${id} still ${st}`); }
      await new Promise((x) => setTimeout(x, 400));
    }
    console.log(`  cancelled=${stopped}  stillLive=${live}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
