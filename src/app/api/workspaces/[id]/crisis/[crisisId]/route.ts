import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET — single crisis detail with full stats
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; crisisId: string }> },
) {
  const { id: workspaceId, crisisId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: crisis, error } = await admin
    .from("crisis_events")
    .select("*")
    .eq("id", crisisId)
    .eq("workspace_id", workspaceId)
    .single();

  if (error || !crisis) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Load all customer actions for this crisis
  const { data: actions } = await admin
    .from("crisis_customer_actions")
    .select("*, customers(id, first_name, last_name, email)")
    .eq("crisis_id", crisisId)
    .order("created_at", { ascending: false });

  const allActions = actions || [];

  // Compute stats
  const stats = {
    total: allActions.length,
    by_segment: {
      berry_only: allActions.filter(a => a.segment === "berry_only").length,
      berry_plus: allActions.filter(a => a.segment === "berry_plus").length,
    },
    tier1: {
      sent: allActions.filter(a => a.tier1_sent_at).length,
      accepted: allActions.filter(a => a.tier1_response === "accepted_swap" || a.tier1_response === "accepted_default_swap" || a.tier1_response === "swapped_flavor").length,
      rejected: allActions.filter(a => a.tier1_response === "rejected").length,
      pending: allActions.filter(a => a.tier1_sent_at && !a.tier1_response).length,
    },
    tier2: {
      sent: allActions.filter(a => a.tier2_sent_at).length,
      accepted: allActions.filter(a => a.tier2_response === "swapped_product" || a.tier2_response === "accepted_swap").length,
      rejected: allActions.filter(a => a.tier2_response === "rejected").length,
      pending: allActions.filter(a => a.tier2_sent_at && !a.tier2_response).length,
    },
    tier3: {
      sent: allActions.filter(a => a.tier3_sent_at).length,
      accepted: allActions.filter(a =>
        a.tier3_response === "accepted_pause" || a.tier3_response === "accepted_remove"
      ).length,
      rejected: allActions.filter(a => a.tier3_response === "rejected").length,
      pending: allActions.filter(a => a.tier3_sent_at && !a.tier3_response).length,
    },
    paused: allActions.filter(a => a.paused_at).length,
    removed_auto_readd: allActions.filter(a => a.removed_item_at && a.auto_readd).length,
    removed_permanent: allActions.filter(a => a.removed_item_at && !a.auto_readd).length,
    cancelled: allActions.filter(a => a.cancelled).length,
  };

  // ── Financial impact ──
  // Count affected subscriptions and estimate revenue at risk
  const affectedSku = crisis.affected_sku;
  const affectedVariantId = crisis.affected_variant_id;

  // Paginate through all active/paused subs (default limit is 1000)
  const affectedSubs: { id: string; items: unknown; billing_interval: string | null; billing_interval_count: number | null; next_billing_date: string | null; status: string }[] = [];
  let subOffset = 0;
  while (true) {
    const { data: batch } = await admin.from("subscriptions")
      .select("id, items, billing_interval, billing_interval_count, next_billing_date, status")
      .eq("workspace_id", workspaceId)
      .in("status", ["active", "paused"])
      .range(subOffset, subOffset + 999);
    if (!batch || batch.length === 0) break;
    affectedSubs.push(...batch);
    subOffset += batch.length;
    if (batch.length < 1000) break;
  }

  const matchingSubs = (affectedSubs || []).filter(s => {
    const items = (s.items as { sku?: string; variant_id?: string; price_cents?: number }[]) || [];
    return items.some(i =>
      (i.sku && affectedSku && i.sku.toUpperCase() === affectedSku.toUpperCase()) ||
      (i.variant_id && i.variant_id === affectedVariantId)
    );
  });

  // Calculate monthly revenue from affected subs
  let monthlyRevenueCents = 0;
  for (const sub of matchingSubs) {
    const items = (sub.items as { price_cents?: number; quantity?: number }[]) || [];
    const subTotal = items.reduce((sum, i) => sum + ((i.price_cents || 0) * (i.quantity || 1)), 0);
    const interval = (sub.billing_interval || "MONTH").toUpperCase();
    const count = sub.billing_interval_count || 1;
    // Normalize to monthly
    if (interval === "WEEK") monthlyRevenueCents += subTotal * (4.33 / count);
    else if (interval === "DAY") monthlyRevenueCents += subTotal * (30 / count);
    else monthlyRevenueCents += subTotal / count; // MONTH
  }

  // Estimate months at risk
  let monthsAtRisk = 3; // default
  if (crisis.expected_restock_date) {
    const restockDate = new Date(crisis.expected_restock_date);
    const now = new Date();
    monthsAtRisk = Math.max(1, Math.ceil((restockDate.getTime() - now.getTime()) / (30 * 24 * 60 * 60 * 1000)));
  }

  // Affected = subs still with the item + subs already processed (swapped away)
  const processedSubIds = new Set(allActions.map(a => a.subscription_id).filter(Boolean));
  const stillAffected = matchingSubs.filter(s => !processedSubIds.has(s.id)).length;
  const totalAffected = stillAffected + processedSubIds.size;

  const financialImpact = {
    affected_subscriptions: totalAffected,
    monthly_revenue_at_risk: Math.round(monthlyRevenueCents) / 100,
    months_at_risk: monthsAtRisk,
    total_revenue_at_risk: Math.round(monthlyRevenueCents * monthsAtRisk) / 100,
    annual_revenue_at_risk: Math.round(monthlyRevenueCents * 12) / 100,
    processed_count: allActions.length,
    // Everyone starts as saved. Only "lost" if they explicitly cancelled or permanently removed (no auto_readd).
    lost_count: allActions.filter(a =>
      a.cancelled === true ||
      (a.removed_item_at && a.auto_readd === false)
    ).length,
    saved_count: allActions.length - allActions.filter(a =>
      a.cancelled === true ||
      (a.removed_item_at && a.auto_readd === false)
    ).length,
  };

  return NextResponse.json({ crisis, actions: allActions, stats, financialImpact });
}

// PATCH — update crisis settings + status
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; crisisId: string }> },
) {
  const { id: workspaceId, crisisId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();

  // Allow updating these fields
  const allowedFields = [
    "name", "status", "affected_variant_id", "affected_sku", "affected_product_title",
    "default_swap_variant_id", "default_swap_title",
    "available_flavor_swaps", "available_product_swaps",
    "tier2_coupon_code", "tier2_coupon_percent",
    "expected_restock_date", "lead_time_days", "tier_wait_days",
  ];

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const field of allowedFields) {
    if (field in body) {
      updates[field] = body[field];
    }
  }

  const { data: crisis, error } = await admin
    .from("crisis_events")
    .update(updates)
    .eq("id", crisisId)
    .eq("workspace_id", workspaceId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(crisis);
}

// POST — actions (resolve)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; crisisId: string }> },
) {
  const { id: workspaceId, crisisId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();

  if (body.action === "resolve") {
    // For now, just set status to resolved — mass actions will be implemented later
    const { data: crisis, error } = await admin
      .from("crisis_events")
      .update({ status: "resolved", updated_at: new Date().toISOString() })
      .eq("id", crisisId)
      .eq("workspace_id", workspaceId)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json(crisis);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
