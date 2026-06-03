/**
 * One-time cleanup of stuck subscriptions (2026-06-03).
 *
 * For each active sub with next_billing_date in the past:
 *   - Fetch fresh Appstle truth.
 *   - If Appstle says ACTIVE with later date → UPDATE next_billing_date in our DB.
 *   - If Appstle says CANCELLED → UPDATE status='cancelled' in our DB.
 *   - If Appstle ALSO has next_billing_date in past → trigger appstleAttemptBilling now.
 *
 * Reports each action before applying. No additional confirmation prompt —
 * user already approved all three buckets.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";
import { decrypt } from "@/lib/crypto";
import { createClient as createSb } from "@supabase/supabase-js";
import { appstleGetUpcomingOrders, appstleAttemptBilling } from "@/lib/appstle";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"),"utf8").split("\n")) {
  const t=line.trim(); if(!t||t.startsWith("#")) continue;
  const eq=t.indexOf("="); if(eq<0) continue;
  if(!process.env[t.slice(0,eq)]) process.env[t.slice(0,eq)]=t.slice(eq+1);
}
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const pw=process.env.SUPABASE_DB_PASSWORD!;
  const cs=`postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(pw)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;
  const c=new Client({connectionString:cs});
  await c.connect();

  const sb = createSb(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const wsRow = await c.query(`SELECT appstle_api_key_encrypted FROM workspaces WHERE id=$1::uuid`, [WS]);
  const apiKey = decrypt(wsRow.rows[0].appstle_api_key_encrypted);

  // Fetch stuck subs
  const stuck = await c.query(`
    SELECT s.id, s.shopify_contract_id, s.status, s.next_billing_date, s.last_payment_status, s.customer_id, s.is_internal
    FROM subscriptions s
    WHERE s.workspace_id=$1::uuid AND s.status='active' AND s.next_billing_date < now() - interval '1 day'
    ORDER BY s.next_billing_date
  `, [WS]);
  console.log(`Stuck subs: ${stuck.rows.length}`);

  type Row = {
    sub_id: string; contract_id: string; db_next: Date; customer_id: string | null; is_internal: boolean | null;
    appstle_status?: string; appstle_next?: string; appstle_error?: string;
    action?: "advance" | "cancel" | "force_bill" | "skip"; reason?: string;
  };
  const rows: Row[] = stuck.rows.map(r => ({
    sub_id: r.id, contract_id: r.shopify_contract_id, db_next: r.next_billing_date,
    customer_id: r.customer_id, is_internal: r.is_internal,
  }));

  // 1. Fetch fresh Appstle state
  console.log("\nFetching fresh Appstle state for all 83...");
  async function fetchOne(r: Row): Promise<void> {
    if (r.is_internal) { r.action = "skip"; r.reason = "internal_sub_no_appstle"; return; }
    try {
      const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${r.contract_id}?api_key=${apiKey}`;
      const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
      if (!res.ok) { r.appstle_error = `${res.status}`; r.action = "skip"; r.reason = `appstle_${res.status}`; return; }
      const data = await res.json();
      r.appstle_status = (data?.status || data?.subscriptionContract?.status || "").toUpperCase();
      r.appstle_next = data?.nextBillingDate || data?.subscriptionContract?.nextBillingDate;
    } catch (err: any) {
      r.appstle_error = String(err?.message || err);
      r.action = "skip"; r.reason = "fetch_error";
    }
  }
  const BATCH = 4;
  for (let i=0; i<rows.length; i+=BATCH) {
    await Promise.all(rows.slice(i, i+BATCH).map(fetchOne));
  }

  // 2. Classify
  for (const r of rows) {
    if (r.action) continue;
    const aStatus = r.appstle_status || "";
    const aNext = r.appstle_next ? new Date(r.appstle_next) : null;
    if (aStatus === "CANCELLED" || aStatus === "CANCELED" || aStatus === "EXPIRED") {
      r.action = "cancel"; r.reason = `appstle_${aStatus}`;
    } else if (aStatus === "ACTIVE" || aStatus === "") {
      if (aNext && aNext.getTime() > r.db_next.getTime() + 60_000) {
        r.action = "advance"; r.reason = `to_${r.appstle_next?.slice(0,10)}`;
      } else if (aNext && aNext < new Date(Date.now() - 86400_000)) {
        r.action = "force_bill"; r.reason = "appstle_also_in_past";
      } else {
        r.action = "skip"; r.reason = `unknown_active_state next=${r.appstle_next}`;
      }
    } else {
      r.action = "skip"; r.reason = `unknown_appstle_status:${aStatus}`;
    }
  }

  // 3. Preview
  const tally = new Map<string, number>();
  for (const r of rows) tally.set(r.action!, (tally.get(r.action!) || 0) + 1);
  console.log("\n=== Plan ===");
  for (const [k, v] of [...tally.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(15)} ${v}`);

  // 4. Apply — advance bucket (UPDATE next_billing_date)
  console.log("\n=== Applying advance (next_billing_date sync from Appstle) ===");
  let advanced = 0;
  for (const r of rows.filter(x => x.action === "advance")) {
    const { error } = await sb.from("subscriptions")
      .update({ next_billing_date: r.appstle_next!, updated_at: new Date().toISOString() })
      .eq("id", r.sub_id).eq("workspace_id", WS);
    if (error) {
      console.log(`  ✗ ${r.sub_id.slice(0,8)}: ${error.message}`);
    } else {
      advanced++;
    }
  }
  console.log(`  advanced ${advanced}/${rows.filter(x => x.action === "advance").length}`);

  // 5. Apply — cancel bucket
  console.log("\n=== Applying cancel (sync our status to Appstle's CANCELLED) ===");
  let cancelled = 0;
  for (const r of rows.filter(x => x.action === "cancel")) {
    const { error } = await sb.from("subscriptions")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", r.sub_id).eq("workspace_id", WS);
    if (error) {
      console.log(`  ✗ ${r.sub_id.slice(0,8)} contract ${r.contract_id}: ${error.message}`);
    } else {
      cancelled++;
      console.log(`  ✓ ${r.sub_id.slice(0,8)} contract ${r.contract_id} → cancelled`);
    }
  }
  console.log(`  cancelled ${cancelled}/${rows.filter(x => x.action === "cancel").length}`);

  // 6. Apply — force_bill bucket (the 2 truly stuck)
  console.log("\n=== Applying force_bill (the truly stuck ones — appstleAttemptBilling) ===");
  for (const r of rows.filter(x => x.action === "force_bill")) {
    console.log(`\n  Sub ${r.sub_id.slice(0,8)} contract ${r.contract_id}, stuck since ${r.db_next?.toISOString?.().slice(0,10)}`);

    // Get upcoming orders
    const upc = await appstleGetUpcomingOrders(WS, r.contract_id);
    if (!upc.success || !upc.orders?.length) {
      console.log(`    ✗ no upcoming orders: ${upc.error || "empty"}`);
      continue;
    }
    const target = upc.orders[0];
    console.log(`    Found upcoming order ${target.id} status=${target.status} billingDate=${target.billingDate}`);

    // Force the billing attempt
    const att = await appstleAttemptBilling(WS, target.id);
    if (att.success) {
      console.log(`    ✓ attempt-billing fired (dunning will pick up if it fails)`);
    } else {
      console.log(`    ✗ attempt-billing failed: ${att.error}`);
    }
  }

  // 7. Final tally
  console.log("\n=== Done ===");
  console.log(`  advanced: ${advanced}`);
  console.log(`  cancelled: ${cancelled}`);
  console.log(`  force_billed: ${rows.filter(x => x.action === "force_bill").length}`);
  console.log(`  skipped (unknown state): ${rows.filter(x => x.action === "skip").length}`);

  // 8. Re-check
  const after = await c.query(`
    SELECT COUNT(*) AS n FROM subscriptions
    WHERE workspace_id=$1::uuid AND status='active' AND next_billing_date < now() - interval '1 day'
  `, [WS]);
  console.log(`\nActive subs with next_billing_date in past, AFTER cleanup: ${after.rows[0].n}`);

  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
