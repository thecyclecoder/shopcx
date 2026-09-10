import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  // paginate snapshots
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("appstle_contract_snapshots")
      .select("appstle_contract_id, subscription_id, status, next_billing_date, delivery_price_cents, payment_method_id, payment_method_revoked, lines, fetch_error, migrated_to_contract_id, migration_completed_at")
      .eq("workspace_id", WS).range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  console.log("snapshots:", rows.length);
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[String(r.status)] = (byStatus[String(r.status)] || 0) + 1;
  console.log("status:", byStatus);
  console.log("fetch_error rows:", rows.filter(r => r.fetch_error).length);
  console.log("subscription_id NULL:", rows.filter(r => !r.subscription_id).length);
  console.log("  ... of which status ACTIVE:", rows.filter(r => !r.subscription_id && r.status === "ACTIVE").length);
  console.log("delivery_price_cents > 0:", rows.filter(r => (r.delivery_price_cents ?? 0) > 0).length);
  const dp: Record<string, number> = {};
  for (const r of rows) dp[String(r.delivery_price_cents)] = (dp[String(r.delivery_price_cents)]||0)+1;
  console.log("delivery price dist:", dp);
  console.log("already migrated marker:", rows.filter(r => r.migrated_to_contract_id).length,
    "completed:", rows.filter(r => r.migration_completed_at).length);
  // duplicate line keys within a contract
  let dupSku = 0, dupVariant = 0, zeroQty = 0, nullSku = 0, lineCount = 0;
  for (const r of rows) {
    const ls = (r.lines ?? []) as any[];
    lineCount += ls.length;
    const skus = ls.map(l => String(l.sku ?? l.variant_id));
    if (new Set(skus).size !== skus.length) dupSku++;
    const vs = ls.map(l => String(l.variant_id));
    if (new Set(vs).size !== vs.length) dupVariant++;
    for (const l of ls) { if (!(Number(l.quantity) > 0)) zeroQty++; if (!l.sku) nullSku++; }
  }
  console.log({ lineCount, dupSku, dupVariant, zeroQty, nullSku });
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
