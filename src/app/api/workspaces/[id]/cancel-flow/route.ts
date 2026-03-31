import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Load cancel reasons from workspace portal_config
  const { data: ws } = await admin.from("workspaces")
    .select("portal_config")
    .eq("id", workspaceId)
    .single();

  const portalConfig = (ws?.portal_config || {}) as Record<string, unknown>;
  const cancelConfig = (portalConfig.cancel_flow || {}) as Record<string, unknown>;
  const reasons = Array.isArray(cancelConfig.reasons) ? cancelConfig.reasons : [];

  // Load remedies
  const { data: remedies } = await admin.from("remedies")
    .select("id, name, type, description, enabled, priority, config")
    .eq("workspace_id", workspaceId)
    .order("priority", { ascending: true });

  // Compute success rates from remedy_outcomes
  const { data: outcomes } = await admin.from("remedy_outcomes")
    .select("remedy_id, outcome")
    .eq("workspace_id", workspaceId);

  const rateMap: Record<string, { offered: number; accepted: number }> = {};
  for (const o of outcomes || []) {
    if (!o.remedy_id) continue;
    if (!rateMap[o.remedy_id]) rateMap[o.remedy_id] = { offered: 0, accepted: 0 };
    rateMap[o.remedy_id].offered++;
    if (o.outcome === "accepted") rateMap[o.remedy_id].accepted++;
  }

  const enriched = (remedies || []).map(r => ({
    ...r,
    is_active: r.enabled,
    success_rate: rateMap[r.id] && rateMap[r.id].offered > 0
      ? rateMap[r.id].accepted / rateMap[r.id].offered
      : null,
    coupon_mapping_id: (r.config as Record<string, unknown>)?.coupon_mapping_id || null,
  }));

  // Load coupon mappings for reference
  const { data: coupons } = await admin.from("coupon_mappings")
    .select("id, code, value_type, value")
    .eq("workspace_id", workspaceId)
    .eq("ai_enabled", true)
    .order("code");

  return NextResponse.json({
    reasons,
    remedies: enriched,
    coupons: coupons || [],
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const admin = createAdminClient();

  if (body.reasons) {
    // Update cancel reasons in portal_config
    const { data: ws } = await admin.from("workspaces")
      .select("portal_config")
      .eq("id", workspaceId)
      .single();

    const portalConfig = (ws?.portal_config || {}) as Record<string, unknown>;
    const updated = {
      ...portalConfig,
      cancel_flow: {
        ...((portalConfig.cancel_flow || {}) as Record<string, unknown>),
        reasons: body.reasons,
      },
    };

    await admin.from("workspaces")
      .update({ portal_config: updated })
      .eq("id", workspaceId);

    return NextResponse.json({ reasons: body.reasons });
  }

  return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
}
