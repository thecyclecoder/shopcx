/**
 * Loyalty audit since 2026-03-30 (the Smile.io import cutover).
 *
 * Step 1: walks ALL orders placed since the cutover (paginated), groups by
 *         customer, ensures every ordering customer has a loyalty_members
 *         record (creates one if missing, `source='audit_native'`).
 * Step 2: identifies the orders that are owed points — orders since the
 *         cutover with no matching `earning` transaction in
 *         loyalty_transactions. Writes the manifest to
 *         /tmp/loyalty-backfill-manifest.json for the points-backfill step
 *         to consume.
 *
 * Does NOT credit any points. Crediting happens via a separate script so
 * we can review the manifest first.
 *
 * Usage:
 *   npx tsx scripts/loyalty-audit-since-cutover.ts             # dry run
 *   npx tsx scripts/loyalty-audit-since-cutover.ts --apply     # write
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
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

const APPLY = process.argv.includes("--apply");
const WORKSPACE_ID = process.env.AGENT_TODO_WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CUTOVER = "2026-03-30T00:00:00Z";
const MANIFEST_PATH = "/tmp/loyalty-backfill-manifest.json";

type OrderRow = {
  id: string;
  order_number: string | null;
  customer_id: string | null;
  shopify_customer_id: string | null;
  email: string | null;
  total_cents: number | null;
  created_at: string;
  line_items: Array<{ sku?: string; quantity?: number; price_cents?: number }> | null;
};

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  console.log(`[audit] workspace ${WORKSPACE_ID} · cutover ${CUTOVER} · mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);

  // 1. Paginated fetch of every order since cutover
  console.log("[1] fetching orders since cutover …");
  const pageSize = 1000;
  const orders: OrderRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await admin
      .from("orders")
      .select("id, order_number, customer_id, shopify_customer_id, email, total_cents, created_at, line_items")
      .eq("workspace_id", WORKSPACE_ID)
      .gte("created_at", CUTOVER)
      .not("customer_id", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) { console.error(error); process.exit(1); }
    if (!data || data.length === 0) break;
    orders.push(...(data as OrderRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  console.log(`  total orders since cutover: ${orders.length}`);

  // Group orders by customer
  const ordersByCust = new Map<string, OrderRow[]>();
  for (const o of orders) {
    if (!o.customer_id) continue;
    const arr = ordersByCust.get(o.customer_id) || [];
    arr.push(o);
    ordersByCust.set(o.customer_id, arr);
  }
  console.log(`  unique customers ordering: ${ordersByCust.size}`);

  // 2. Resolve linked-account groups so loyalty lookups don't double-count
  //    a customer split across email aliases.
  const customerIds = Array.from(ordersByCust.keys());
  const { data: links } = await admin
    .from("customer_links")
    .select("customer_id, group_id")
    .in("customer_id", customerIds);
  const groupByCust = new Map<string, string>();
  for (const l of links || []) {
    if (l.customer_id && l.group_id) groupByCust.set(l.customer_id, l.group_id);
  }
  // Build a list of all "primary" customer ids — the canonical one per linked group,
  // chosen as the one with a shopify_customer_id (if any in the group) else the input id.
  // For audit purposes, we treat each unique customer_id with orders as needing
  // a lookup; if multiple ids share a group, they'll share a member record.

  // 3. For each customer, find their existing member record (if any).
  // Batch the `.in()` lookup — PostgREST/Supabase URL caps mean we silently
  // truncate to ~1000 ids per request, which produced a false negative for
  // every customer when we tried to filter 3K+ at once.
  const memberByCust = new Map<string, { id: string; source: string; points_balance: number }>();
  // Keep this small — 500 UUIDs in an `.in()` produces a URL near 18KB
  // which PostgREST silently truncates (saw 19/3038 instead of ~65% on
  // first run with chunk=500). 100 keeps each request under ~4KB.
  const CHUNK = 100;
  for (let i = 0; i < customerIds.length; i += CHUNK) {
    const chunk = customerIds.slice(i, i + CHUNK);
    const { data: existingMembers } = await admin
      .from("loyalty_members")
      .select("id, customer_id, source, points_balance")
      .eq("workspace_id", WORKSPACE_ID)
      .in("customer_id", chunk);
    for (const m of existingMembers || []) {
      if (m.customer_id) memberByCust.set(m.customer_id, { id: m.id, source: m.source || "", points_balance: m.points_balance || 0 });
    }
  }
  // Also propagate within linked groups: if any customer in a group has a member, all do.
  const groupToMember = new Map<string, { id: string; source: string; points_balance: number }>();
  for (const [cid, mem] of memberByCust.entries()) {
    const g = groupByCust.get(cid);
    if (g) groupToMember.set(g, mem);
  }
  for (const cid of customerIds) {
    if (memberByCust.has(cid)) continue;
    const g = groupByCust.get(cid);
    if (g && groupToMember.has(g)) memberByCust.set(cid, groupToMember.get(g)!);
  }

  console.log(`  customers with an existing member: ${memberByCust.size}`);
  console.log(`  customers MISSING a member: ${customerIds.length - memberByCust.size}`);

  // 4. Find all earning transactions on the post-cutover orders to know what's
  //    already been credited (so we don't double-count when we compute owed).
  const memberIds = [...new Set(Array.from(memberByCust.values()).map((m) => m.id))];
  const earnedOrderIds = new Set<string>();
  // Batch the `.in()` over member_ids — same URL-cap reason as above.
  for (let i = 0; i < memberIds.length; i += CHUNK) {
    const memberChunk = memberIds.slice(i, i + CHUNK);
    let from2 = 0;
    while (true) {
      const { data, error } = await admin
        .from("loyalty_transactions")
        .select("order_id, member_id")
        .eq("workspace_id", WORKSPACE_ID)
        .eq("type", "earning")
        .in("member_id", memberChunk)
        .not("order_id", "is", null)
        .range(from2, from2 + pageSize - 1);
      if (error) { console.error(error); process.exit(1); }
      if (!data || data.length === 0) break;
      for (const t of data) if (t.order_id) earnedOrderIds.add(t.order_id);
      if (data.length < pageSize) break;
      from2 += pageSize;
    }
  }
  console.log(`  earning txns already on post-cutover orders: ${earnedOrderIds.size}`);

  // 5. Resolve customer details for any we'll need to enroll (batched)
  const missingCustIds = customerIds.filter((cid) => !memberByCust.has(cid));
  const custInfo = new Map<string, { shopify_customer_id: string | null; email: string | null }>();
  for (let i = 0; i < missingCustIds.length; i += CHUNK) {
    const chunk = missingCustIds.slice(i, i + CHUNK);
    const { data: missingCusts } = await admin
      .from("customers")
      .select("id, shopify_customer_id, email")
      .in("id", chunk);
    for (const c of missingCusts || []) custInfo.set(c.id, { shopify_customer_id: c.shopify_customer_id, email: c.email });
  }

  // 6. Apply: enroll the missing customers + assemble the backfill manifest.
  let enrolled = 0;
  let skippedNoIdentity = 0;
  const manifest: Array<{ member_id: string; customer_id: string; email: string | null; order_ids: string[]; total_points_to_credit: number }> = [];

  for (const [cid, custOrders] of ordersByCust.entries()) {
    let member = memberByCust.get(cid);

    if (!member) {
      // Need to enroll. Pull identity from customers table (or from orders if missing).
      const info = custInfo.get(cid);
      const shopifyCustomerId = info?.shopify_customer_id || custOrders[0]?.shopify_customer_id;
      const email = info?.email || custOrders[0]?.email;
      if (!shopifyCustomerId || !email) {
        skippedNoIdentity++;
        continue;
      }
      if (APPLY) {
        const { data: created, error } = await admin
          .from("loyalty_members")
          .upsert(
            {
              workspace_id: WORKSPACE_ID,
              customer_id: cid,
              shopify_customer_id: shopifyCustomerId,
              email,
              source: "audit_native",
            },
            { onConflict: "workspace_id,shopify_customer_id" },
          )
          .select("id, source, points_balance")
          .single();
        if (error) { console.error("enroll err:", error.message); continue; }
        member = { id: created.id, source: created.source || "", points_balance: created.points_balance || 0 };
        memberByCust.set(cid, member);
      } else {
        // Dry-run placeholder — synthesize so we still count owed
        member = { id: `(dry-run for ${cid.slice(0, 8)})`, source: "audit_native", points_balance: 0 };
      }
      enrolled++;
    }

    // Figure out which orders for this customer are still owed points.
    const owedOrders = custOrders.filter((o) => !earnedOrderIds.has(o.id));
    if (owedOrders.length === 0) continue;

    // Compute the to-credit total for the manifest (same formula as Lavinya's backfill).
    let totalPoints = 0;
    for (const o of owedOrders) {
      const items = o.line_items || [];
      const productSubtotalCents = items
        .filter((i) => i.sku !== "Insure01")
        .reduce((s, i) => s + (i.price_cents || 0) * (i.quantity || 1), 0);
      const qualifyingCents = Math.min(productSubtotalCents, o.total_cents || 0);
      totalPoints += Math.floor((qualifyingCents / 100) * 10); // workspace points_per_dollar = 10
    }
    if (totalPoints <= 0) continue;

    manifest.push({
      member_id: member.id,
      customer_id: cid,
      email: custInfo.get(cid)?.email || custOrders[0]?.email || null,
      order_ids: owedOrders.map((o) => o.id),
      total_points_to_credit: totalPoints,
    });
  }

  // 7. Write manifest + summary
  if (APPLY) {
    writeFileSync(MANIFEST_PATH, JSON.stringify({ workspace_id: WORKSPACE_ID, cutover: CUTOVER, generated_at: new Date().toISOString(), entries: manifest }, null, 2));
  }
  const grandTotalPoints = manifest.reduce((s, m) => s + m.total_points_to_credit, 0);

  console.log("\n=== SUMMARY ===");
  console.log(`  orders since cutover:           ${orders.length}`);
  console.log(`  unique ordering customers:      ${ordersByCust.size}`);
  console.log(`  enrolled (new memberships):     ${enrolled}`);
  console.log(`  skipped (no shopify_id/email):  ${skippedNoIdentity}`);
  console.log(`  members owed backfill:          ${manifest.length}`);
  console.log(`  total points to backfill:       ${grandTotalPoints.toLocaleString()} (~$${(grandTotalPoints / 100).toFixed(2)} in redemption value)`);
  if (APPLY) {
    console.log(`  manifest written to:            ${MANIFEST_PATH}`);
  } else {
    console.log(`\n  (dry run — pass --apply to enroll missing members + write manifest)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
