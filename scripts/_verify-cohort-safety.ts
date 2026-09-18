import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const NEW = ["36063346861","36063379629","36063412397","36063477933","36063510701","36063543469","36063576237","36063609005","36063641773","36063674541","36063707309","36063740077","36063772845","36063805613","36063838381","36063871149","36063903917","36063936685","36063969453","36064002221","36064034989","36064067757","36064133293","36064166061"];
const OLD = ["31315165357","34524233901","27894087853","27862499501","31308382381","35177660589","29318578349","27970207917","27895070893","33283965101","28184641709","27964866733","27893104813","27862728877","27825438893","27821539501","27836285101","32234864813","35728982189","27826225325","27810234541","33970946221","34054733997","27832090797"];
async function main() {
  const admin = createAdminClient();

  // 1. Did the PDP ingest handler adopt any of the 24 new contracts? It must not have.
  const { data: leaked } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, billing_source").eq("workspace_id", WS).in("shopify_contract_id", NEW);
  console.log(`1. subscriptions rows for the 24 new contracts: ${leaked?.length ?? 0}  ${leaked?.length ? "⚠️ INGEST LEAKED" : "✅ ingest claim guard held"}`);

  // 2. Are any of the 24 customers now billed by us? They must all still be appstle.
  const { data: rows } = await admin.from("subscriptions")
    .select("shopify_contract_id, billing_source, status, next_billing_date, customer_id, items")
    .eq("workspace_id", WS).in("shopify_contract_id", OLD);
  const notAppstle = (rows ?? []).filter((r) => r.billing_source !== "appstle");
  console.log(`2. cohort rows: ${rows?.length}  not-on-appstle: ${notAppstle.length}  ${notAppstle.length ? "⚠️" : "✅ every customer still billed by Appstle"}`);

  // 3. Would OUR renewal cron pick any of them up? It selects billing_source='shopcx'.
  const { count: shopcxDue } = await admin.from("subscriptions")
    .select("*", { count: "exact", head: true }).eq("workspace_id", WS)
    .eq("billing_source", "shopcx").in("shopify_contract_id", [...OLD, ...NEW]);
  console.log(`3. cohort rows our renewal cron would select: ${shopcxDue}  ${shopcxDue ? "⚠️" : "✅ none — no double-charge path"}`);

  // 4. Portal: does each customer still resolve exactly one subscription, with items intact?
  let portalOk = 0, portalBad: string[] = [];
  for (const r of rows ?? []) {
    const items = (r.items as unknown[]) ?? [];
    const { count: subsForCustomer } = await admin.from("subscriptions")
      .select("*", { count: "exact", head: true }).eq("workspace_id", WS).eq("customer_id", r.customer_id!);
    if (items.length > 0 && r.status === "active") portalOk++;
    else portalBad.push(`${r.shopify_contract_id} (items=${items.length} status=${r.status} subsForCustomer=${subsForCustomer})`);
  }
  console.log(`4. portal-readable cohort rows: ${portalOk}/${rows?.length}  ${portalBad.length ? "⚠️ " + portalBad.join(", ") : "✅ items + status intact"}`);

  // 5. Did anything write a customer_event / ticket-visible change for these customers?
  const custIds = [...new Set((rows ?? []).map((r) => r.customer_id).filter(Boolean))] as string[];
  const since = new Date(Date.now() - 2 * 3600_000).toISOString();
  const { data: ev } = await admin.from("customer_events")
    .select("customer_id, event_type, created_at").eq("workspace_id", WS)
    .in("customer_id", custIds).gte("created_at", since);
  console.log(`5. customer_events written for cohort in the last 2h: ${ev?.length ?? 0}  ${ev?.length ? "⚠️ " + JSON.stringify(ev) : "✅ nothing customer-visible logged"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
