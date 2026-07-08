import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { usageCostCents } from "@/lib/ai-usage";

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
    issues?: { ticket_index: number; ticket_id?: string; type: string; description: string }[];
    action_items?: { priority: string; description: string }[];
    ticket_ids?: string[];
    summary?: string;
  }) || {};
  const latestIssues = (latestMeta.issues || []).map(i => ({
    type: i.type,
    description: i.description,
    // New reports embed ticket_id directly. Older reports only have
    // ticket_index — fall back to the ordered array.
    ticket_id: i.ticket_id || latestMeta.ticket_ids?.[i.ticket_index - 1] || null,
  }));

  // ── 2. AI-handled tickets in window ──
  // Phase 1 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
  // Prior code fetched every AI ticket + tallied tags / channel / escalation in
  // JS — PostgREST's 1000-row cap silently truncated the source set, so every
  // sub-bucket was wrong on any busy workspace. Server-side aggregate now.
  const { data: aiAggRows } = await admin.rpc("ai_ticket_analytics", {
    p_workspace: workspaceId,
    p_since: since,
  });
  const aiAgg = (Array.isArray(aiAggRows) ? aiAggRows[0] : aiAggRows) as {
    ai_ticket_count: number | string | null;
    escalated: number | string | null;
    chat_count: number | string | null;
    email_count: number | string | null;
    tag_buckets: Record<string, number> | null;
    ticket_ids: string[] | null;
  } | null;
  const numOrZero = (v: number | string | null | undefined) =>
    v === null || v === undefined ? 0 : Number(v) || 0;
  const aiTicketCount = numOrZero(aiAgg?.ai_ticket_count);
  const escalated = numOrZero(aiAgg?.escalated);
  const chatCount = numOrZero(aiAgg?.chat_count);
  const emailCount = numOrZero(aiAgg?.email_count);
  const tagBuckets: Record<string, number> = {};
  for (const [k, v] of Object.entries(aiAgg?.tag_buckets ?? {})) {
    tagBuckets[k] = Number(v) || 0;
  }

  // ── 3. Sonnet decision-type counts (parse system internal notes) ──
  // Pattern: "[System] Sonnet: <action_type> — <reasoning>"
  // Plus "Action completed: <summary>" for actual direct-action runs.
  const ticketIdList = aiAgg?.ticket_ids ?? [];
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

  // ── 4. Token usage / cost ──
  // Group by model + day. Compute total cost, per-ticket cost, and the
  // Opus-vs-Sonnet split via the `purpose` prefix written by the orchestrator.
  // ai_token_usage routinely exceeds PostgREST's 1000-row cap for a 30-90d
  // window. Without pagination the query silently returned only the OLDEST
  // 1000 rows — undercounting cost AND excluding the most recent days (so
  // today/yesterday would read zero). Page through all rows. (Same 1000-row
  // cap class the storefront-funnel fix addressed.)
  type UsageRow = {
    model: string; input_tokens: number | null; output_tokens: number | null;
    cache_creation_tokens: number | null; cache_read_tokens: number | null;
    purpose: string | null; ticket_id: string | null; created_at: string | null;
  };
  const usageRows: UsageRow[] = [];
  const USAGE_PAGE = 1000;
  for (let from = 0; ; from += USAGE_PAGE) {
    const { data: page } = await admin
      .from("ai_token_usage")
      .select("model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, purpose, ticket_id, created_at")
      .eq("workspace_id", workspaceId)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, from + USAGE_PAGE - 1);
    if (!page || page.length === 0) break;
    usageRows.push(...(page as UsageRow[]));
    if (page.length < USAGE_PAGE) break;
  }

  const byModel: Record<string, { tokens: number; cost_cents: number; calls: number }> = {};
  const byDay: Record<string, { cost_cents: number; tokens: number }> = {};
  const byPurpose: Record<string, { cost_cents: number; tokens: number; calls: number }> = {};
  let totalCostCents = 0;
  let totalTokens = 0;
  const ticketCostMap = new Map<string, number>();
  let opusCalls = 0;
  let sonnetOrchestratorCalls = 0;
  let opusTickets = 0;
  let sonnetTickets = 0;
  const ticketModelMap = new Map<string, "opus" | "sonnet">();

  // Cache utilization — the lever the orchestrator pre-context split targets.
  // A healthy cache shows most input-side tokens as cheap cache READS, not
  // re-paid creation/raw input.
  let rawInputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0, outputTokens = 0;

  // Today vs yesterday, in Central time (matches the ROAS / ad dashboards).
  const ctDate = (d: string | number): string =>
    new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const todayCT = ctDate(Date.now());
  const yesterdayCT = ctDate(Date.now() - 24 * 60 * 60 * 1000);
  type Period = { cost: number; rawIn: number; cacheCreate: number; cacheRead: number; output: number; tickets: Map<string, number>; model: Map<string, "opus" | "sonnet"> };
  const mkPeriod = (): Period => ({ cost: 0, rawIn: 0, cacheCreate: 0, cacheRead: 0, output: 0, tickets: new Map(), model: new Map() });
  const periodAcc: Record<"today" | "yesterday", Period> = { today: mkPeriod(), yesterday: mkPeriod() };

  for (const r of usageRows || []) {
    const tokens = (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_creation_tokens || 0) + (r.cache_read_tokens || 0);
    const cost = usageCostCents(r.model, {
      input_tokens: r.input_tokens || 0,
      output_tokens: r.output_tokens || 0,
      cache_creation_tokens: r.cache_creation_tokens || 0,
      cache_read_tokens: r.cache_read_tokens || 0,
    });
    totalCostCents += cost;
    totalTokens += tokens;
    rawInputTokens += r.input_tokens || 0;
    cacheCreationTokens += r.cache_creation_tokens || 0;
    cacheReadTokens += r.cache_read_tokens || 0;
    outputTokens += r.output_tokens || 0;

    const rowDay = ctDate(r.created_at || Date.now());
    const period = rowDay === todayCT ? periodAcc.today : rowDay === yesterdayCT ? periodAcc.yesterday : null;
    if (period) {
      period.cost += cost;
      period.rawIn += r.input_tokens || 0;
      period.cacheCreate += r.cache_creation_tokens || 0;
      period.cacheRead += r.cache_read_tokens || 0;
      period.output += r.output_tokens || 0;
      if (r.ticket_id) period.tickets.set(r.ticket_id, (period.tickets.get(r.ticket_id) || 0) + cost);
      if (r.purpose?.startsWith("orchestrator-decision:") && r.ticket_id && !period.model.has(r.ticket_id)) {
        period.model.set(r.ticket_id, r.purpose.startsWith("orchestrator-decision:opus") ? "opus" : "sonnet");
      }
    }

    const m = byModel[r.model] || { tokens: 0, cost_cents: 0, calls: 0 };
    m.tokens += tokens; m.cost_cents += cost; m.calls += 1;
    byModel[r.model] = m;

    const day = r.created_at?.slice(0, 10) || "unknown";
    const d = byDay[day] || { cost_cents: 0, tokens: 0 };
    d.cost_cents += cost; d.tokens += tokens;
    byDay[day] = d;

    // Bucket purpose down to its first segment (e.g. "orchestrator-decision")
    const pBucket = (r.purpose || "other").split(":")[0];
    const p = byPurpose[pBucket] || { cost_cents: 0, tokens: 0, calls: 0 };
    p.cost_cents += cost; p.tokens += tokens; p.calls += 1;
    byPurpose[pBucket] = p;

    if (r.ticket_id) {
      ticketCostMap.set(r.ticket_id, (ticketCostMap.get(r.ticket_id) || 0) + cost);
    }

    // Opus / Sonnet orchestrator split — only count orchestrator-decision rows
    if (r.purpose?.startsWith("orchestrator-decision:")) {
      const isOpus = r.purpose.startsWith("orchestrator-decision:opus");
      if (isOpus) opusCalls += 1;
      else sonnetOrchestratorCalls += 1;
      if (r.ticket_id && !ticketModelMap.has(r.ticket_id)) {
        ticketModelMap.set(r.ticket_id, isOpus ? "opus" : "sonnet");
      }
    }
  }
  for (const m of ticketModelMap.values()) {
    if (m === "opus") opusTickets += 1; else sonnetTickets += 1;
  }

  const ticketCount = ticketCostMap.size;
  const avgPerTicketCents = ticketCount ? totalCostCents / ticketCount : 0;

  const inputSideTotal = rawInputTokens + cacheCreationTokens + cacheReadTokens;
  const cacheReadRatioPct = inputSideTotal ? Math.round((cacheReadTokens / inputSideTotal) * 100) : 0;

  const summarizePeriod = (p: Period) => {
    const tickets = p.tickets.size;
    const inputSide = p.rawIn + p.cacheCreate + p.cacheRead;
    let opusT = 0, sonnetT = 0;
    for (const m of p.model.values()) { if (m === "opus") opusT++; else sonnetT++; }
    return {
      cost_cents: Math.round(p.cost * 100) / 100,
      tickets,
      avg_per_ticket_cents: tickets ? Math.round((p.cost / tickets) * 100) / 100 : 0,
      raw_input_tokens: p.rawIn,
      cache_creation_tokens: p.cacheCreate,
      cache_read_tokens: p.cacheRead,
      output_tokens: p.output,
      cache_read_ratio_pct: inputSide ? Math.round((p.cacheRead / inputSide) * 100) : 0,
      opus_tickets: opusT,
      sonnet_tickets: sonnetT,
    };
  };
  const dailyCosts = Object.entries(byDay)
    .map(([date, v]) => ({ date, cost_cents: Math.round(v.cost_cents * 100) / 100, tokens: v.tokens }))
    .sort((a, b) => a.date.localeCompare(b.date));

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
      ai_tickets: aiTicketCount,
      escalated,
      escalation_rate_pct: aiTicketCount ? Math.round((escalated / aiTicketCount) * 100) : 0,
      chat: chatCount,
      email: emailCount,
    },
    decisions: decisionCounts,
    actions: actionCounts,
    tags: tagBuckets,
    cost: {
      total_cents: Math.round(totalCostCents * 100) / 100,
      total_tokens: totalTokens,
      tickets_with_usage: ticketCount,
      avg_per_ticket_cents: Math.round(avgPerTicketCents * 100) / 100,
      by_model: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, { ...v, cost_cents: Math.round(v.cost_cents * 100) / 100 }])),
      by_purpose: Object.fromEntries(Object.entries(byPurpose).map(([k, v]) => [k, { ...v, cost_cents: Math.round(v.cost_cents * 100) / 100 }])),
      daily: dailyCosts,
      cache: {
        raw_input_tokens: rawInputTokens,
        cache_creation_tokens: cacheCreationTokens,
        cache_read_tokens: cacheReadTokens,
        output_tokens: outputTokens,
        read_ratio_pct: cacheReadRatioPct,
      },
      orchestrator_split: {
        opus_calls: opusCalls,
        sonnet_calls: sonnetOrchestratorCalls,
        opus_tickets: opusTickets,
        sonnet_tickets: sonnetTickets,
        opus_pct: (opusTickets + sonnetTickets) ? Math.round((opusTickets / (opusTickets + sonnetTickets)) * 100) : 0,
      },
    },
    periods: {
      today: summarizePeriod(periodAcc.today),
      yesterday: summarizePeriod(periodAcc.yesterday),
    },
  });
}
