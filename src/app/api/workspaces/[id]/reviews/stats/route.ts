/**
 * Review-programme funnel: sent → clicked → reviewed.
 *
 * Deliberately measured from DELIVERY TRUTH rather than the ladder's own columns. The
 * 2026-09-08 outage was invisible for eight days precisely because `review_requests` looked
 * healthy — 545 rows, all `outcome='sent'` — while every magic link 404'd and
 * `review_requests.channel` recorded 311 SMS sends that went out as email. A funnel built on
 * those columns would have reported "fine" the whole time.
 *
 * So each stage is derived from the thing that can't lie about itself:
 *   sent      — the ask row exists AND its message actually left (sent_at, not send_cancelled)
 *   linkable  — the token resolves to a journey_sessions row (a link with no session is dead)
 *   clicked   — the session moved off `pending`
 *   reviewed  — a submitted review exists for that session
 *
 * `linkable` has no business meaning to a marketer — it should always equal `sent`. It is on the
 * page because when it does NOT, that gap IS the outage, visible on day one instead of day eight.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role as string)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 30)));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  type Ask = { id: string; product_id: string; channel: string; angle: string; sent_at: string; journey_session_id: string | null };
  const asks: Ask[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("review_requests")
      .select("id,product_id,channel,angle,sent_at,journey_session_id")
      .eq("workspace_id", workspaceId)
      .range(from, from + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    asks.push(...((data ?? []) as Ask[]));
    if ((data ?? []).length < 1000) break;
  }
  const recent = asks.filter((a) => a.sent_at >= since);

  // Sessions carry the click/submit truth.
  const sessionIds = recent.map((a) => a.journey_session_id).filter(Boolean) as string[];
  const sessions = new Map<string, { status: string; responses: unknown }>();
  for (let i = 0; i < sessionIds.length; i += 200) {
    const { data } = await admin.from("journey_sessions")
      .select("id,status,responses").in("id", sessionIds.slice(i, i + 200));
    for (const s of data ?? []) sessions.set(String(s.id), { status: String(s.status), responses: s.responses });
  }

  const linkable = recent.filter((a) => a.journey_session_id && sessions.has(a.journey_session_id)).length;
  const clicked = recent.filter((a) => {
    const s = a.journey_session_id ? sessions.get(a.journey_session_id) : null;
    return s && s.status !== "pending";
  }).length;
  const reviewed = recent.filter((a) => {
    const s = a.journey_session_id ? sessions.get(a.journey_session_id) : null;
    return s?.status === "completed";
  }).length;

  const sent = recent.length;
  const rate = (n: number) => (sent ? Number(((n / sent) * 100).toFixed(2)) : 0);

  // Daily send volume for the sparkline.
  const byDay = new Map<string, number>();
  for (const a of recent) {
    const d = a.sent_at.slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }

  const byChannel = new Map<string, number>();
  for (const a of recent) byChannel.set(a.channel, (byChannel.get(a.channel) ?? 0) + 1);

  return NextResponse.json({
    ok: true,
    window_days: days,
    funnel: {
      sent,
      linkable,
      clicked,
      reviewed,
      click_rate: rate(clicked),
      review_rate: rate(reviewed),
      // Non-zero means links are going out that cannot possibly be answered.
      dead_links: sent - linkable,
    },
    by_day: [...byDay.entries()].sort().map(([date, count]) => ({ date, count })),
    by_channel: [...byChannel.entries()].map(([channel, count]) => ({ channel, count })),
    all_time_asks: asks.length,
  });
}
