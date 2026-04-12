import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") || "30", 10);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Aggregate email events
  const { data: events } = await admin.from("email_events")
    .select("resend_email_id, event_type, recipient_email, subject, occurred_at, metadata")
    .eq("workspace_id", workspaceId)
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false });

  if (!events) return NextResponse.json({ stats: null });

  // Count unique emails per event type
  const sentIds = new Set<string>();
  const deliveredIds = new Set<string>();
  const openedIds = new Set<string>();
  const clickedIds = new Set<string>();
  const bouncedIds = new Set<string>();
  const complainedIds = new Set<string>();

  const bounceList: { email: string; subject: string; date: string; reason: string }[] = [];
  const complaintList: { email: string; subject: string; date: string }[] = [];

  for (const e of events) {
    switch (e.event_type) {
      case "sent": sentIds.add(e.resend_email_id); break;
      case "delivered": deliveredIds.add(e.resend_email_id); break;
      case "opened": openedIds.add(e.resend_email_id); break;
      case "clicked": clickedIds.add(e.resend_email_id); break;
      case "bounced":
        bouncedIds.add(e.resend_email_id);
        if (bounceList.length < 50) {
          bounceList.push({
            email: e.recipient_email || "unknown",
            subject: e.subject || "",
            date: e.occurred_at,
            reason: (e.metadata as { bounce?: { type?: string; description?: string } })?.bounce?.description
              || (e.metadata as { bounce?: { type?: string } })?.bounce?.type
              || "Unknown",
          });
        }
        break;
      case "complained":
        complainedIds.add(e.resend_email_id);
        if (complaintList.length < 50) {
          complaintList.push({
            email: e.recipient_email || "unknown",
            subject: e.subject || "",
            date: e.occurred_at,
          });
        }
        break;
    }
  }

  const sent = sentIds.size;
  const delivered = deliveredIds.size;
  const opened = openedIds.size;
  const clicked = clickedIds.size;
  const bounced = bouncedIds.size;
  const complained = complainedIds.size;

  // Count tracked emails (those with tracking pixel) for accurate open rate
  const trackedSentIds = new Set<string>();
  for (const e of events) {
    if (e.event_type === "sent" && (e.metadata as { tracked?: boolean })?.tracked) {
      trackedSentIds.add(e.resend_email_id);
    }
  }
  const trackedSent = trackedSentIds.size;

  // Calculate rates
  const deliveryRate = sent > 0 ? Math.round((delivered / sent) * 1000) / 10 : 0;
  const bounceRate = sent > 0 ? Math.round((bounced / sent) * 1000) / 10 : 0;
  // Open rate only counts tracked emails — transactional emails don't have tracking pixels
  const openRate = trackedSent > 0 ? Math.round((opened / trackedSent) * 1000) / 10 : 0;
  const clickRate = opened > 0 ? Math.round((clicked / opened) * 1000) / 10 : 0;
  const complaintRate = delivered > 0 ? Math.round((complained / delivered) * 10000) / 100 : 0;

  // Health score (0-100)
  // Good: delivery >98%, bounce <2%, complaint <0.1%, open >20%
  let score = 100;
  if (deliveryRate < 98) score -= (98 - deliveryRate) * 5;
  if (bounceRate > 2) score -= (bounceRate - 2) * 10;
  if (complaintRate > 0.1) score -= (complaintRate - 0.1) * 100;
  if (openRate < 15) score -= (15 - openRate);
  score = Math.max(0, Math.min(100, Math.round(score)));

  const scoreLabel = score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 50 ? "Fair" : "Needs Attention";
  const scoreColor = score >= 90 ? "emerald" : score >= 75 ? "blue" : score >= 50 ? "amber" : "red";

  return NextResponse.json({
    days,
    stats: { sent, delivered, opened, clicked, bounced, complained, trackedSent },
    rates: { deliveryRate, bounceRate, openRate, clickRate, complaintRate },
    score: { value: score, label: scoreLabel, color: scoreColor },
    bounces: bounceList,
    complaints: complaintList,
  });
}
