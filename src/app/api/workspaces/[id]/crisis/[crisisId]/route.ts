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
      accepted: allActions.filter(a => a.tier1_response === "accepted_swap").length,
      rejected: allActions.filter(a => a.tier1_response === "rejected").length,
      pending: allActions.filter(a => a.tier1_sent_at && !a.tier1_response).length,
    },
    tier2: {
      sent: allActions.filter(a => a.tier2_sent_at).length,
      accepted: allActions.filter(a => a.tier2_response === "accepted_swap").length,
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
    removed: allActions.filter(a => a.removed_item_at).length,
    cancelled: allActions.filter(a => a.cancelled).length,
  };

  return NextResponse.json({ crisis, actions: allActions, stats });
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
