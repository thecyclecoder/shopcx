/**
 * SMS marketing campaigns — list + create.
 *   GET    /api/workspaces/[id]/sms-campaigns
 *   POST   /api/workspaces/[id]/sms-campaigns  → create draft
 */

import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  void request;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: campaigns } = await admin
    .from("sms_campaigns")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(50);

  const list = campaigns || [];
  if (list.length === 0) return NextResponse.json({ campaigns: [] });

  const ids = list.map((c) => c.id);
  const codes = Array.from(
    new Set(list.map((c) => c.coupon_code).filter(Boolean) as string[])
  );

  // Recipients — bucket by status per campaign for delivered/sent counts.
  const { data: recRows } = await admin
    .from("sms_campaign_recipients")
    .select("campaign_id, status")
    .in("campaign_id", ids);
  const recByCamp = new Map<string, { sent: number; delivered: number; total: number }>();
  for (const r of (recRows || []) as { campaign_id: string; status: string }[]) {
    const cur = recByCamp.get(r.campaign_id) || { sent: 0, delivered: 0, total: 0 };
    cur.total++;
    if (r.status === "sent" || r.status === "delivered") cur.sent++;
    if (r.status === "delivered") cur.delivered++;
    recByCamp.set(r.campaign_id, cur);
  }

  // Shortlinks — click_count is maintained on the row.
  const { data: slRows } = await admin
    .from("marketing_shortlinks")
    .select("campaign_id, click_count")
    .in("campaign_id", ids);
  const clicksByCamp = new Map<string, number>();
  for (const s of (slRows || []) as { campaign_id: string; click_count: number | null }[]) {
    clicksByCamp.set(s.campaign_id, (clicksByCamp.get(s.campaign_id) || 0) + (s.click_count || 0));
  }

  // UTM-precise conversions per campaign — orders.attributed_utm_campaign = campaign.id.
  const { data: utmOrders } = await admin
    .from("orders")
    .select("attributed_utm_campaign, total_cents, source_name, subscription_id")
    .eq("workspace_id", workspaceId)
    .in("attributed_utm_campaign", ids);
  const SUB_SOURCES = new Set(["subscription_contract", "subscription_contract_checkout_one"]);
  const utmByCamp = new Map<string, { count: number; revenue: number }>();
  for (const o of (utmOrders || []) as { attributed_utm_campaign: string; total_cents: number | null; source_name: string | null; subscription_id: string | null }[]) {
    if (SUB_SOURCES.has(o.source_name || "") || o.subscription_id) continue;
    const cur = utmByCamp.get(o.attributed_utm_campaign) || { count: 0, revenue: 0 };
    cur.count++;
    cur.revenue += o.total_cents || 0;
    utmByCamp.set(o.attributed_utm_campaign, cur);
  }

  // Coupon-fallback — orders that used a campaign's coupon AND have no UTM
  // attribution (untracked landings). Shared coupons match all campaigns
  // that share the code — we surface this as an "untracked" indicator,
  // never folded into the precise per-campaign revenue.
  const couponByCode = new Map<string, { count: number; revenue: number }>();
  if (codes.length > 0) {
    const { data: codeOrders } = await admin
      .from("orders")
      .select("discount_codes, total_cents, source_name, subscription_id, attributed_utm_source")
      .eq("workspace_id", workspaceId)
      .is("attributed_utm_source", null)
      .gte("created_at", "2026-01-01T00:00:00Z");  // bound to keep query small
    for (const o of (codeOrders || []) as { discount_codes: unknown; total_cents: number | null; source_name: string | null; subscription_id: string | null }[]) {
      if (SUB_SOURCES.has(o.source_name || "") || o.subscription_id) continue;
      const arr = Array.isArray(o.discount_codes) ? o.discount_codes : [];
      const orderCodes = new Set(
        arr.map((c) => (typeof c === "string" ? c : (c as { code?: string })?.code || "")).filter(Boolean).map((s) => s.toUpperCase())
      );
      for (const code of codes) {
        if (orderCodes.has(code.toUpperCase())) {
          const cur = couponByCode.get(code) || { count: 0, revenue: 0 };
          cur.count++;
          cur.revenue += o.total_cents || 0;
          couponByCode.set(code, cur);
        }
      }
    }
  }

  // Compose
  const enriched = list.map((c) => {
    const rec = recByCamp.get(c.id) || { sent: 0, delivered: 0, total: 0 };
    const clicks = clicksByCamp.get(c.id) || 0;
    const utm = utmByCamp.get(c.id) || { count: 0, revenue: 0 };
    const couponBucket = c.coupon_code ? (couponByCode.get(c.coupon_code) || { count: 0, revenue: 0 }) : { count: 0, revenue: 0 };
    return {
      ...c,
      stats: {
        recipients: rec.total,
        sent: rec.sent,
        delivered: rec.delivered,
        clicks,
        click_rate: rec.sent > 0 ? clicks / rec.sent : 0,
        conversions: utm.count,
        revenue_cents: utm.revenue,
        cvr: rec.sent > 0 ? utm.count / rec.sent : 0,
        untracked_coupon_redemptions: couponBucket.count,
        untracked_coupon_revenue_cents: couponBucket.revenue,
      },
    };
  });

  return NextResponse.json({ campaigns: enriched });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const { user } = await getAuthedUser();
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
    send_date, target_local_hour, fallback_target_local_hour, fallback_timezone,
    audience_filter,
    included_segments, excluded_segments,
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
      fallback_target_local_hour: Number.isInteger(fallback_target_local_hour) ? fallback_target_local_hour : 10,
      fallback_timezone: (fallback_timezone as string) || "America/Chicago",
      audience_filter: (audience_filter as Record<string, unknown>) || {},
      included_segments: Array.isArray(included_segments) ? (included_segments as string[]) : [],
      excluded_segments: Array.isArray(excluded_segments) ? (excluded_segments as string[]) : [],
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
