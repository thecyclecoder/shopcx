/**
 * SMS marketing campaigns — list + create.
 *   GET    /api/workspaces/[id]/sms-campaigns
 *   POST   /api/workspaces/[id]/sms-campaigns  → create draft
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("sms_campaigns")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(50);
  return NextResponse.json({ campaigns: data || [] });
}

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
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin", "marketing"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const {
    name, message_body, media_url,
    send_date, target_local_hour, fallback_timezone,
    audience_filter,
    coupon_enabled, coupon_discount_pct, coupon_expires_days_after_send,
    shortlink_target_url,
  } = body as Record<string, unknown>;

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  if (!message_body || typeof message_body !== "string") {
    return NextResponse.json({ error: "message_body required" }, { status: 400 });
  }
  if (!send_date || typeof send_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(send_date)) {
    return NextResponse.json({ error: "send_date required (YYYY-MM-DD)" }, { status: 400 });
  }
  const hour = Number(target_local_hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return NextResponse.json({ error: "target_local_hour 0-23 required" }, { status: 400 });
  }

  const { data, error } = await admin
    .from("sms_campaigns")
    .insert({
      workspace_id: workspaceId,
      name,
      message_body,
      media_url: (media_url as string) || null,
      send_date,
      target_local_hour: hour,
      fallback_timezone: (fallback_timezone as string) || "America/Chicago",
      audience_filter: (audience_filter as Record<string, unknown>) || {},
      coupon_enabled: !!coupon_enabled,
      coupon_discount_pct: coupon_enabled ? Number(coupon_discount_pct) || null : null,
      coupon_expires_days_after_send: coupon_enabled
        ? Number(coupon_expires_days_after_send) || 21
        : 21,
      shortlink_target_url: (shortlink_target_url as string) || null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaign: data });
}
