import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * AI agent analytics: ratings over time, action breakdown, and the
 * latest analysis's issues/action items.
 *
 * Window default: 30 days. Pass ?days=N to override.
 */
export async function GET(
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
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") || "30", 10) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // ── 1. Score history (most recent N daily reports) ──
  const { data: reports } = await admin
    .from("dashboard_notifications")
    .select("created_at, metadata")
    .eq("workspace_id", workspaceId)
    .filter("metadata->>type", "eq", "ai_nightly_analysis")
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  const scores = (reports || []).map(r => ({
    date: r.created_at?.slice(0, 10),
    overall_score: (r.metadata as { overall_score?: number })?.overall_score ?? null,
    channel_scores: (r.metadata as { channel_scores?: Record<string, number> })?.channel_scores || {},
    conversations: (r.metadata as { conversations_analyzed?: number })?.conversations_analyzed ?? 0,
  }));

  // Latest issues + action items (most recent report)
  const latest = reports?.[reports.length - 1];
  const latestMeta = (latest?.metadata as {
    overall_score?: number;
    issues?: { ticket_index: number; type: string; description: string }[];
    action_items?: { priority: string; description: string }[];
    ticket_ids?: string[];
    summary?: string;
  }) || {};
  const latestIssues = (latestMeta.issues || []).map(i => ({
    type: i.type,
    description: i.description,
    ticket_id: latestMeta.ticket_ids?.[i.ticket_index - 1] || null,
  }));

  // ── 2. AI-handled tickets in window ──
  const { data: aiTickets, count: aiTicketCount } = await admin
    .from("tickets")
    .select("id, channel, tags, escalated_at", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .contains("tags", ["ai"])
    .gte("created_at", since);

  // Tag counts (j:*, pb:*, w:*, dunning:*, crisis*, link, wb, ai:fix, agent, jo:*)
  const tagBuckets: Record<string, number> = {};
  let escalated = 0;
  let chatCount = 0;
  let emailCount = 0;
  for (const t of aiTickets || []) {
    if (t.escalated_at) escalated++;
    if (t.channel === "chat") chatCount++;
    else if (t.channel === "email") emailCount++;
    for (const tag of (t.tags as string[]) || []) {
      tagBuckets[tag] = (tagBuckets[tag] || 0) + 1;
    }
  }

  // ── 3. Sonnet decision-type counts (parse system internal notes) ──
  // Pattern: "[System] Sonnet: <action_type> — <reasoning>"
  // Plus "Action completed: <summary>" for actual direct-action runs.
  const ticketIdList = (aiTickets || []).map(t => t.id);
  const decisionCounts: Record<string, number> = {};
  const actionCounts: Record<string, number> = {};

  // Process in chunks to avoid url-length issues
  for (let i = 0; i < ticketIdList.length; i += 100) {
    const chunk = ticketIdList.slice(i, i + 100);
    const { data: notes } = await admin
      .from("ticket_messages")
      .select("body, body_clean")
      .in("ticket_id", chunk)
      .eq("author_type", "system")
      .eq("visibility", "internal");
    for (const n of notes || []) {
      const body = n.body_clean || n.body || "";

      // Sonnet decision types
      const dm = body.match(/\[System\]\s*Sonnet:\s*(\w+)/);
      if (dm) decisionCounts[dm[1]] = (decisionCounts[dm[1]] || 0) + 1;

      // Direct action completions — pull the verb
      const am = body.match(/Action completed:\s*([^—.\n]+)/);
      if (am) {
        // Normalize: just keep the first 1-3 words to bucket cleanly
        const verb = am[1].trim()
          .replace(/^(Applied|Cancelled|Paused|Resumed|Skipped|Swapped|Updated|Created|Issued|Removed|Added|Linked|Redeemed|Refunded|Re[a-z]*|Set|Sent|Generated|Started)\b.*/i, "$1")
          .toLowerCase();
        const key = verb.charAt(0).toUpperCase() + verb.slice(1);
        actionCounts[key || "Other"] = (actionCounts[key || "Other"] || 0) + 1;
      }
    }
  }

  return NextResponse.json({
    days,
    scores,
    latest: {
      score: latestMeta.overall_score ?? null,
      summary: latestMeta.summary || "",
      issues: latestIssues,
      action_items: latestMeta.action_items || [],
      date: latest?.created_at?.slice(0, 10) || null,
    },
    totals: {
      ai_tickets: aiTicketCount || 0,
      escalated,
      escalation_rate_pct: aiTicketCount ? Math.round((escalated / aiTicketCount) * 100) : 0,
      chat: chatCount,
      email: emailCount,
    },
    decisions: decisionCounts,
    actions: actionCounts,
    tags: tagBuckets,
  });
}
