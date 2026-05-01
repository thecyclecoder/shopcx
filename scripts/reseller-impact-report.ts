/**
 * Build a report of every order shipped to a known reseller address,
 * group by reseller, and surface every customer profile + active
 * subscription tied to those addresses.
 *
 * Output goes to console + a JSON file at
 * /tmp/reseller-impact-report.json so the cancel/ban scripts can
 * consume it without re-querying.
 *
 * Run: npx tsx scripts/reseller-impact-report.ts
 */
import { readFileSync, writeFileSync } from "fs";

const envPath = "/Users/admin/Projects/shopcx/.env.local";
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

interface AddressLite {
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  province?: string | null;
  zip?: string | null;
}

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { normalizeReseller } = await import("../src/lib/known-resellers");
  const admin = createAdminClient();

  const { data: workspaces } = await admin
    .from("workspaces")
    .select("id, name")
    .not("shopify_access_token_encrypted", "is", null);

  type ReportEntry = {
    workspace_id: string;
    reseller_id: string;
    reseller_name: string;
    address: string;
    matched_orders: Array<{
      order_id: string;
      order_number: string;
      customer_id: string | null;
      email: string | null;
      ship_name: string;
      total: number;
      created_at: string;
      coupon_codes: string[];
      matched_on: "shipping" | "billing";
    }>;
    customer_ids: string[];
    customer_emails: string[];
    active_subscriptions: Array<{
      subscription_id: string;
      shopify_contract_id: string | null;
      status: string;
      next_billing_date: string | null;
      customer_id: string;
      customer_email: string | null;
    }>;
    total_revenue_cents: number;
    total_orders: number;
  };

  const report: ReportEntry[] = [];

  for (const ws of workspaces || []) {
    console.log(`\n══ ${ws.name} (${ws.id}) ══`);

    const { data: resellers } = await admin
      .from("known_resellers")
      .select("id, business_name, address1, address2, city, state, zip, normalized_address, amazon_seller_id, status")
      .eq("workspace_id", ws.id)
      .in("status", ["active", "unverified"]);

    if (!resellers?.length) {
      console.log("  No resellers in scope. Run scripts/discover-resellers.ts first.");
      continue;
    }
    console.log(`  ${resellers.length} resellers in scope`);

    // Pull every order with a non-null shipping or billing address
    type Order = {
      id: string;
      customer_id: string | null;
      order_number: string;
      total_cents: number;
      discount_codes: Array<{ code: string }> | string[] | null;
      shipping_address: AddressLite | null;
      billing_address: AddressLite | null;
      created_at: string;
      email: string | null;
    };

    const allOrders: Order[] = [];
    let cursor: string | null = null;
    const PAGE = 1000; // Supabase default db.max_rows cap
    for (;;) {
      let q = admin.from("orders")
        .select("id, customer_id, order_number, total_cents, discount_codes, shipping_address, billing_address, created_at, email")
        .eq("workspace_id", ws.id)
        .order("created_at", { ascending: false })
        .limit(PAGE);
      if (cursor) q = q.lt("created_at", cursor);
      const { data, error } = await q;
      if (error) { console.error(error.message); break; }
      if (!data?.length) break;
      for (const o of data as unknown as Order[]) {
        if (o.shipping_address || o.billing_address) allOrders.push(o);
      }
      cursor = data[data.length - 1].created_at;
      process.stdout.write(`\r  loading orders… ${allOrders.length}`);
      if (data.length < PAGE) break;
    }
    console.log(`\n  ${allOrders.length} orders with addresses loaded.`);

    // For each reseller, exact-normalized match against orders
    for (const r of resellers) {
      const matches: ReportEntry["matched_orders"] = [];
      const customerIds = new Set<string>();
      const customerEmails = new Set<string>();
      let totalRevenue = 0;

      for (const o of allOrders) {
        for (const side of ["shipping", "billing"] as const) {
          const a = side === "shipping" ? o.shipping_address : o.billing_address;
          if (!a?.address1 || !a?.zip) continue;
          const norm = normalizeReseller({ address1: a.address1, zip: a.zip });
          if (norm === r.normalized_address) {
            const codes = Array.isArray(o.discount_codes)
              ? (o.discount_codes as Array<string | { code: string }>).map(c => typeof c === "string" ? c : c.code).filter(Boolean)
              : [];
            matches.push({
              order_id: o.id,
              order_number: o.order_number,
              customer_id: o.customer_id,
              email: o.email,
              ship_name: "",
              total: o.total_cents / 100,
              created_at: o.created_at,
              coupon_codes: codes,
              matched_on: side,
            });
            if (o.customer_id) customerIds.add(o.customer_id);
            if (o.email) customerEmails.add(o.email.toLowerCase());
            totalRevenue += o.total_cents;
            break; // already matched for this order, don't double-count
          }
        }
      }

      if (matches.length === 0) continue;

      // Pull active subscriptions for the customer set
      let activeSubs: ReportEntry["active_subscriptions"] = [];
      if (customerIds.size > 0) {
        const { data: subs } = await admin
          .from("subscriptions")
          .select("id, shopify_contract_id, status, next_billing_date, customer_id")
          .eq("workspace_id", ws.id)
          .in("customer_id", [...customerIds])
          .in("status", ["ACTIVE", "PAUSED"]);

        const { data: subEmails } = customerIds.size > 0
          ? await admin.from("customers").select("id, email").in("id", [...customerIds])
          : { data: [] };
        const emailById = new Map((subEmails || []).map(c => [c.id, c.email]));

        activeSubs = (subs || []).map(s => ({
          subscription_id: s.id,
          shopify_contract_id: s.shopify_contract_id,
          status: s.status,
          next_billing_date: s.next_billing_date,
          customer_id: s.customer_id,
          customer_email: emailById.get(s.customer_id) || null,
        }));
      }

      report.push({
        workspace_id: ws.id,
        reseller_id: r.id,
        reseller_name: r.business_name || r.amazon_seller_id || "(unknown)",
        address: `${r.address1}${r.address2 ? ", " + r.address2 : ""}, ${r.city}, ${r.state} ${r.zip}`,
        matched_orders: matches,
        customer_ids: [...customerIds],
        customer_emails: [...customerEmails],
        active_subscriptions: activeSubs,
        total_revenue_cents: totalRevenue,
        total_orders: matches.length,
      });
    }
  }

  // Print
  console.log("\n" + "═".repeat(80));
  console.log("RESELLER IMPACT REPORT");
  console.log("═".repeat(80));
  for (const e of report.sort((a, b) => b.total_orders - a.total_orders)) {
    console.log(`\n▶ ${e.reseller_name}  (reseller_id=${e.reseller_id.slice(0, 8)})`);
    console.log(`  ${e.address}`);
    console.log(`  ${e.total_orders} orders · $${(e.total_revenue_cents / 100).toFixed(2)} revenue`);
    console.log(`  ${e.customer_ids.length} customer profiles · ${e.customer_emails.length} unique emails`);
    console.log(`  ${e.active_subscriptions.length} ACTIVE/PAUSED subscriptions`);
    if (e.active_subscriptions.length) {
      for (const s of e.active_subscriptions.slice(0, 5)) {
        console.log(`    - ${s.status}  ${s.shopify_contract_id}  ${s.customer_email || s.customer_id}  next=${s.next_billing_date?.slice(0, 10) || "—"}`);
      }
      if (e.active_subscriptions.length > 5) console.log(`    + ${e.active_subscriptions.length - 5} more`);
    }
  }

  // Totals
  const totalOrders = report.reduce((s, e) => s + e.total_orders, 0);
  const totalRevenue = report.reduce((s, e) => s + e.total_revenue_cents, 0);
  const totalCustomers = new Set(report.flatMap(e => e.customer_ids)).size;
  const totalSubs = report.reduce((s, e) => s + e.active_subscriptions.length, 0);
  console.log("\n" + "─".repeat(80));
  console.log(`TOTALS: ${report.length} resellers · ${totalOrders} orders · $${(totalRevenue/100).toFixed(2)} revenue · ${totalCustomers} customers · ${totalSubs} active subs`);

  writeFileSync("/tmp/reseller-impact-report.json", JSON.stringify(report, null, 2));
  console.log(`\nReport saved to /tmp/reseller-impact-report.json`);
  console.log(`Run scripts/cancel-reseller-subs.ts to cancel + ban based on this file.`);
}
main().catch(e => { console.error(e); process.exit(1); });
