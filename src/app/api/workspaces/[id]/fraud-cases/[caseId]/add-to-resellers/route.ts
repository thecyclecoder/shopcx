/**
 * POST /api/workspaces/{id}/fraud-cases/{caseId}/add-to-resellers
 *
 * Insta-promotes the fraud case's customer addresses to known_resellers
 * so the amazon_reseller fraud rule blocks future orders to those
 * addresses on sight (no waiting for Amazon storefront discovery).
 *
 * Workflow:
 *   1. Load the case + every order referenced on it
 *   2. Collect unique normalized shipping AND billing addresses
 *   3. For each unique address, upsert a known_resellers row with
 *      platform='manual', status='active', business_name from the
 *      first customer name we can find, source noted as
 *      "Manually added from fraud case <id>"
 *   4. Skip addresses that already exist (matched by normalized_address)
 *   5. Log every insert/skip to fraud_action_log
 *
 * Returns: { added: number, skipped: number, reseller_ids: string[] }
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeReseller } from "@/lib/known-resellers";

interface Addr {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  province_code?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  country_code?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> },
) {
  const { id: workspaceId, caseId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("id, role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Load the fraud case
  const { data: fraudCase } = await admin
    .from("fraud_cases")
    .select("id, customer_ids, order_ids")
    .eq("id", caseId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!fraudCase) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const orderIds = (fraudCase.order_ids || []) as string[];
  const customerIds = (fraudCase.customer_ids || []) as string[];
  if (orderIds.length === 0) {
    return NextResponse.json({ error: "No orders on this fraud case to extract an address from." }, { status: 400 });
  }

  // Pull every order on the case. order_ids may be Shopify ids or
  // internal UUIDs depending on rule type — try both.
  const { data: ordersByUuid } = await admin
    .from("orders")
    .select("id, order_number, shopify_order_id, customer_id, shipping_address, billing_address")
    .in("id", orderIds)
    .eq("workspace_id", workspaceId);
  let orders = ordersByUuid || [];
  if (orders.length === 0) {
    const { data: ordersByShopify } = await admin
      .from("orders")
      .select("id, order_number, shopify_order_id, customer_id, shipping_address, billing_address")
      .in("shopify_order_id", orderIds)
      .eq("workspace_id", workspaceId);
    orders = ordersByShopify || [];
  }
  if (orders.length === 0) {
    return NextResponse.json({ error: "Couldn't resolve any orders on this fraud case." }, { status: 400 });
  }

  // Pull a customer name to use as business_name
  let businessName: string | null = null;
  if (customerIds.length > 0) {
    const { data: cust } = await admin
      .from("customers")
      .select("first_name, last_name")
      .in("id", customerIds)
      .limit(1)
      .maybeSingle();
    if (cust) {
      const fn = (cust.first_name || "").trim();
      const ln = (cust.last_name || "").trim();
      const combined = [fn, ln].filter(Boolean).join(" ");
      if (combined) businessName = combined;
    }
  }

  // Build the dedup set of addresses across ship + bill for every
  // order. Multi-order cases (Aiden-style) frequently share one
  // address so dedupe is what we want — one reseller row per location.
  type Candidate = {
    norm: string;
    addr: Addr;
  };
  const candidates = new Map<string, Candidate>();
  for (const o of orders || []) {
    for (const raw of [o.shipping_address as Addr | null, o.billing_address as Addr | null]) {
      if (!raw?.address1 || !raw?.zip) continue;
      const norm = normalizeReseller({ address1: raw.address1, zip: raw.zip });
      if (!norm || norm === "|") continue;
      if (!candidates.has(norm)) candidates.set(norm, { norm, addr: raw });
    }
  }
  if (candidates.size === 0) {
    return NextResponse.json({ error: "No addresses with a street + ZIP on these orders." }, { status: 400 });
  }

  // Check which normalized addresses already exist
  const norms = [...candidates.keys()];
  const { data: existing } = await admin
    .from("known_resellers")
    .select("id, normalized_address, status")
    .eq("workspace_id", workspaceId)
    .in("normalized_address", norms);
  const existingByNorm = new Map<string, { id: string; status: string }>();
  for (const r of existing || []) existingByNorm.set(r.normalized_address as string, { id: r.id, status: r.status });

  const insertRows: Array<Record<string, unknown>> = [];
  const reactivatedIds: string[] = [];
  const skipped: string[] = [];

  for (const c of candidates.values()) {
    const ex = existingByNorm.get(c.norm);
    if (ex) {
      // Already in the table. If it was dormant / unverified, flip it
      // active — a fresh fraud case is strong signal. If already
      // active or whitelisted, leave alone and report skipped.
      if (ex.status === "dormant" || ex.status === "unverified") {
        await admin
          .from("known_resellers")
          .update({
            status: "active",
            last_seen_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            notes: `Re-activated from fraud case ${caseId} on ${new Date().toISOString().slice(0, 10)}`,
          })
          .eq("id", ex.id);
        reactivatedIds.push(ex.id);
      } else {
        skipped.push(ex.id);
      }
      continue;
    }
    const addr = c.addr;
    const state = (addr.province_code || addr.state || addr.province || "").toString().toUpperCase().slice(0, 2);
    insertRows.push({
      workspace_id: workspaceId,
      platform: "manual",
      business_name: businessName,
      address1: addr.address1 || null,
      address2: addr.address2 || null,
      city: addr.city || null,
      state: state || null,
      zip: (addr.zip || "").toString().slice(0, 10),
      country: addr.country_code || addr.country || "US",
      normalized_address: c.norm,
      source_asins: [],
      status: "active",
      notes: `Manually added from fraud case ${caseId} on ${new Date().toISOString().slice(0, 10)}`,
    });
  }

  let insertedIds: string[] = [];
  if (insertRows.length > 0) {
    const { data: inserted, error: insertErr } = await admin
      .from("known_resellers")
      .insert(insertRows)
      .select("id");
    if (insertErr) {
      return NextResponse.json({ error: "Insert failed", details: insertErr.message }, { status: 500 });
    }
    insertedIds = (inserted || []).map((r) => r.id as string);
  }

  // Audit log — one fraud_action_log row per reseller touched. Easier
  // to query later than a single multi-row blob.
  const actionRows: Array<Record<string, unknown>> = [];
  for (const id of insertedIds) {
    actionRows.push({
      workspace_id: workspaceId,
      fraud_case_id: caseId,
      reseller_id: id,
      action: "reseller_discovered",
      metadata: { source: "manual_add_from_fraud_case", actor_user_id: user.id },
    });
  }
  for (const id of reactivatedIds) {
    actionRows.push({
      workspace_id: workspaceId,
      fraud_case_id: caseId,
      reseller_id: id,
      action: "reseller_reactivated",
      metadata: { source: "manual_add_from_fraud_case", actor_user_id: user.id },
    });
  }
  if (actionRows.length > 0) {
    await admin.from("fraud_action_log").insert(actionRows);
  }

  return NextResponse.json({
    ok: true,
    added: insertedIds.length,
    reactivated: reactivatedIds.length,
    skipped: skipped.length,
    reseller_ids: [...insertedIds, ...reactivatedIds],
  });
}
