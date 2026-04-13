import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET — list crisis events for workspace with aggregate counts
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Verify membership + admin/owner
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status");

  let query = admin
    .from("crisis_events")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (status && status !== "all") query = query.eq("status", status);

  const { data: crises, error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Fetch aggregate counts for each crisis
  const crisisIds = (crises || []).map(c => c.id);
  let countsByCrisis: Record<string, {
    total: number;
    tier1_accepted: number;
    tier2_accepted: number;
    tier3_accepted: number;
    cancelled: number;
  }> = {};

  if (crisisIds.length > 0) {
    const { data: actions } = await admin
      .from("crisis_customer_actions")
      .select("crisis_id, tier1_response, tier2_response, tier3_response, cancelled")
      .in("crisis_id", crisisIds);

    for (const cid of crisisIds) {
      const crisisActions = (actions || []).filter(a => a.crisis_id === cid);
      countsByCrisis[cid] = {
        total: crisisActions.length,
        tier1_accepted: crisisActions.filter(a => a.tier1_response === "accepted_default_swap" || a.tier1_response === "swapped_flavor" || a.tier1_response === "accepted_swap").length,
        tier2_accepted: crisisActions.filter(a => a.tier2_response === "swapped_product" || a.tier2_response === "accepted_swap").length,
        tier3_accepted: crisisActions.filter(a =>
          a.tier3_response === "accepted_pause" || a.tier3_response === "accepted_remove"
        ).length,
        cancelled: crisisActions.filter(a => a.cancelled).length,
      };
    }
  }

  const result = (crises || []).map(c => ({
    ...c,
    counts: countsByCrisis[c.id] || { total: 0, tier1_accepted: 0, tier2_accepted: 0, tier3_accepted: 0, cancelled: 0 },
  }));

  return NextResponse.json({ crises: result });
}

// POST — create a new crisis event
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
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
  const {
    name,
    affected_variant_id,
    affected_sku,
    affected_product_title,
    default_swap_variant_id,
    default_swap_title,
    available_flavor_swaps,
    available_product_swaps,
    tier2_coupon_code,
    tier2_coupon_percent,
    expected_restock_date,
    lead_time_days,
    tier_wait_days,
  } = body;

  if (!name || !affected_variant_id) {
    return NextResponse.json({ error: "name and affected_variant_id are required" }, { status: 400 });
  }

  const { data: crisis, error } = await admin
    .from("crisis_events")
    .insert({
      workspace_id: workspaceId,
      name,
      status: "draft",
      affected_variant_id,
      affected_sku: affected_sku || null,
      affected_product_title: affected_product_title || null,
      default_swap_variant_id: default_swap_variant_id || null,
      default_swap_title: default_swap_title || null,
      available_flavor_swaps: available_flavor_swaps || [],
      available_product_swaps: available_product_swaps || [],
      tier2_coupon_code: tier2_coupon_code || null,
      tier2_coupon_percent: tier2_coupon_percent ?? 20,
      expected_restock_date: expected_restock_date || null,
      lead_time_days: lead_time_days ?? 7,
      tier_wait_days: tier_wait_days ?? 3,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(crisis, { status: 201 });
}
