/**
 * SMS marketing campaign — detail + action endpoints.
 *
 *   GET    /api/workspaces/[id]/sms-campaigns/[campaignId]
 *   PATCH  …                                       → edit draft fields
 *   POST   …                                       → action via { action: "schedule" | "pause" | "resume" | "cancel" | "preview_audience" }
 *   DELETE …                                       → delete draft only
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

interface RouteParams {
  params: Promise<{ id: string; campaignId: string }>;
}

const EDITABLE_DRAFT_FIELDS = new Set([
  "name", "message_body", "media_url",
  "send_date", "target_local_hour", "fallback_timezone",
  "audience_filter",
]);

export async function GET(request: Request, { params }: RouteParams) {
  const { id: workspaceId, campaignId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("sms_campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Pull recipient timezone-source breakdown for the detail UI.
  // Useful to show "how many sends are using the workspace fallback
  // because we couldn't resolve a TZ" — a flag for poor data
  // coverage we'd want to backfill.
  const { data: tzBreakdown } = await admin
    .from("sms_campaign_recipients")
    .select("timezone_source")
    .eq("campaign_id", campaignId);
  const sourceCounts: Record<string, number> = {};
  for (const r of (tzBreakdown || []) as { timezone_source: string }[]) {
    sourceCounts[r.timezone_source] = (sourceCounts[r.timezone_source] || 0) + 1;
  }

  return NextResponse.json({ campaign: data, tz_source_breakdown: sourceCounts });
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { id: workspaceId, campaignId } = await params;

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

  const { data: current } = await admin
    .from("sms_campaigns")
    .select("status")
    .eq("id", campaignId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (current.status !== "draft") {
    return NextResponse.json({ error: `Cannot edit a ${current.status} campaign` }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (EDITABLE_DRAFT_FIELDS.has(k)) updates[k] = v;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no editable fields" }, { status: 400 });
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await admin
    .from("sms_campaigns")
    .update(updates)
    .eq("id", campaignId)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ campaign: data });
}

export async function POST(request: Request, { params }: RouteParams) {
  const { id: workspaceId, campaignId } = await params;

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

  const { action } = await request.json().catch(() => ({}));
  const { data: campaign } = await admin
    .from("sms_campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  switch (action) {
    case "schedule": {
      if (campaign.status !== "draft") {
        return NextResponse.json({ error: `Cannot schedule from ${campaign.status}` }, { status: 400 });
      }
      // Inngest function does the heavy lifting — audience resolve +
      // recipient queue build + scheduled_send_at calc. Fire-and-forget.
      await inngest.send({
        name: "marketing/text-campaign.scheduled",
        data: { campaign_id: campaignId },
      });
      // Optimistic UI hint — the cron will overwrite this with real state.
      await admin.from("sms_campaigns")
        .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
        .eq("id", campaignId);
      return NextResponse.json({ ok: true });
    }
    case "pause": {
      if (!["scheduled", "sending"].includes(campaign.status)) {
        return NextResponse.json({ error: `Cannot pause from ${campaign.status}` }, { status: 400 });
      }
      await admin.from("sms_campaigns")
        .update({ status: "paused", updated_at: new Date().toISOString() })
        .eq("id", campaignId);
      return NextResponse.json({ ok: true });
    }
    case "resume": {
      if (campaign.status !== "paused") {
        return NextResponse.json({ error: `Cannot resume from ${campaign.status}` }, { status: 400 });
      }
      await admin.from("sms_campaigns")
        .update({ status: "scheduled", updated_at: new Date().toISOString() })
        .eq("id", campaignId);
      return NextResponse.json({ ok: true });
    }
    case "cancel": {
      if (["sent", "cancelled"].includes(campaign.status)) {
        return NextResponse.json({ error: `Cannot cancel from ${campaign.status}` }, { status: 400 });
      }
      await admin.from("sms_campaigns")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", campaignId);
      return NextResponse.json({ ok: true });
    }
    case "preview_audience": {
      // Count of subscribers matching the audience filter without
      // creating recipient rows. Cheap sanity check before scheduling.
      const filter = (campaign.audience_filter as Record<string, unknown>) || {};
      let q = admin.from("customers")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .not("phone", "is", null)
        .eq("sms_marketing_status", "subscribed");
      const subStatuses = filter.subscription_status as string[] | undefined;
      if (Array.isArray(subStatuses) && subStatuses.length > 0) {
        q = q.in("subscription_status", subStatuses);
      }
      const { count } = await q;
      return NextResponse.json({ audience_count: count || 0 });
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { id: workspaceId, campaignId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: c } = await admin
    .from("sms_campaigns")
    .select("status")
    .eq("id", campaignId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!c) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (c.status !== "draft" && c.status !== "cancelled") {
    return NextResponse.json({ error: `Cannot delete a ${c.status} campaign` }, { status: 400 });
  }
  await admin.from("sms_campaigns").delete().eq("id", campaignId);
  return NextResponse.json({ ok: true });
}
