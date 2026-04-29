// Nightly AI Agent Performance Analysis
// Analyzes all AI-handled tickets from the past 24 hours
// Scores accuracy, detects frustration, identifies issues
// Creates action items for low-scoring conversations

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

export const aiNightlyAnalysis = inngest.createFunction(
  {
    id: "ai-nightly-analysis",
    retries: 1,
    triggers: [{ cron: "0 6 * * *" }], // 6am UTC daily
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // Step 1: Find all workspaces with nightly analysis enabled
    const workspaces = await step.run("find-workspaces", async () => {
      const { data } = await admin
        .from("ai_channel_config")
        .select("workspace_id")
        .eq("enabled", true);
      return [...new Set((data || []).map(d => d.workspace_id))];
    });

    let totalAnalyzed = 0;

    for (const workspaceId of workspaces) {
      const results = await step.run(`analyze-${workspaceId}`, async () => {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        // Get tickets with 'ai' tag from last 24 hours
        const { data: tickets } = await admin
          .from("tickets")
          .select("id, subject, channel, ai_turn_count, escalation_reason, status")
          .eq("workspace_id", workspaceId)
          .contains("tags", ["ai"])
          .gte("updated_at", yesterday);

        if (!tickets?.length) return { analyzed: 0 };

        // For each ticket, get the conversation. Critically, restrict
        // messages to the last 24h: long-history tickets and auto-merged
        // chains (Sarah Young's had 194 messages pulled forward across
        // 17 days) would otherwise dominate the prompt and let Claude
        // grade the AI on pre-fix conversations from days earlier.
        const conversations: {
          ticketId: string;
          channel: string;
          subject: string;
          turns: number;
          escalated: boolean;
          hasPriorHistory: boolean;
          messages: { role: string; body: string }[];
        }[] = [];

        for (const ticket of tickets.slice(0, 50)) { // Cap at 50 per workspace
          // Quick check: does this ticket have ANY external messages
          // before the analysis window? Used to flag tickets where we're
          // intentionally only showing Claude a slice of the thread.
          const { count: priorCount } = await admin
            .from("ticket_messages")
            .select("id", { count: "exact", head: true })
            .eq("ticket_id", ticket.id)
            .eq("visibility", "external")
            .lt("created_at", yesterday);

          // Only the messages from the last 24 hours
          const { data: msgs } = await admin
            .from("ticket_messages")
            .select("direction, author_type, body, visibility, created_at")
            .eq("ticket_id", ticket.id)
            .eq("visibility", "external")
            .gte("created_at", yesterday)
            .order("created_at", { ascending: true });

          if (!msgs?.length) continue;

          conversations.push({
            ticketId: ticket.id,
            channel: ticket.channel,
            subject: ticket.subject || "",
            turns: ticket.ai_turn_count || 0,
            escalated: !!ticket.escalation_reason,
            hasPriorHistory: (priorCount || 0) > 0,
            messages: msgs.slice(-30).map(m => ({ // also cap to last 30 msgs in window
              role: m.direction === "inbound" ? "customer" : "agent",
              body: (m.body || "").replace(/<[^>]+>/g, " ").trim().slice(0, 300),
            })),
          });
        }

        if (!conversations.length) return { analyzed: 0 };

        // Send batch to Claude for analysis
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return { analyzed: 0, error: "No API key" };

        const analysisPrompt = conversations.map((c, i) => {
          const thread = c.messages.map(m => `${m.role}: ${m.body}`).join("\n");
          const priorTag = c.hasPriorHistory ? ", HAS PRIOR HISTORY (older messages intentionally excluded)" : "";
          return `--- Ticket ${i + 1} (${c.channel}, ${c.turns} AI turns${c.escalated ? ", ESCALATED" : ""}${priorTag}) ---\nSubject: ${c.subject}\n${thread}`;
        }).join("\n\n");

        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2000,
            system: `You are an AI quality analyst reviewing customer support conversations handled by an AI agent.

You will be shown only the messages from the last 24 hours of each ticket. Tickets marked "HAS PRIOR HISTORY" had earlier conversation that was intentionally excluded from this prompt — do NOT penalize the AI for not acknowledging context you can't see, do NOT score those tickets based on assumed prior failures, and do NOT count loops/repetition that may have happened before this window. Only grade what's in front of you.

Analyze each conversation and provide:
1. Overall score (1-10) for the batch — based ONLY on the messages shown
2. Per-channel breakdown (email, chat, etc.)
3. Issues found: inaccurate responses, robotic tone, customer frustration, missed opportunities — only when visible in the messages shown
4. Action items: specific improvements needed

Only grade AI agent messages, not human agent messages. If a ticket has no AI agent messages in this window (e.g. only customer messages or only human agent messages), skip it — do not include it in scoring.

Return JSON:
{
  "overall_score": number,
  "total_conversations": number,
  "channel_scores": { "email": number, "chat": number, ... },
  "issues": [{ "ticket_index": number, "type": "inaccuracy"|"robotic"|"frustration"|"missed_opportunity"|"kb_gap", "description": string }],
  "action_items": [{ "priority": "high"|"medium"|"low", "description": string }],
  "summary": string
}`,
            messages: [{ role: "user", content: `Analyze these ${conversations.length} AI-handled support conversations from the last 24 hours:\n\n${analysisPrompt}` }],
          }),
        });

        if (!res.ok) return { analyzed: conversations.length, error: "Claude API error" };

        const data = await res.json();
        const analysisText = data.content?.[0]?.text || "";

        let analysis;
        try {
          // Extract JSON from response
          const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
          analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        } catch {
          analysis = null;
        }

        if (!analysis) return { analyzed: conversations.length, error: "Failed to parse analysis" };

        // Create notification with results
        const scoreColor = analysis.overall_score >= 8 ? "high" : analysis.overall_score >= 6 ? "medium" : "low";
        const hasIssues = (analysis.issues?.length || 0) > 0;
        const highPriorityActions = (analysis.action_items || []).filter((a: { priority: string }) => a.priority === "high");

        await admin.from("dashboard_notifications").insert({
          workspace_id: workspaceId,
          type: "system",
          title: `AI Agent Daily Report: ${analysis.overall_score}/10`,
          body: `${analysis.total_conversations} conversations analyzed. ${analysis.issues?.length || 0} issues found. ${highPriorityActions.length} high-priority actions.${analysis.summary ? " " + analysis.summary : ""}`,
          link: "/dashboard/settings/ai",
          metadata: {
            type: "ai_nightly_analysis",
            overall_score: analysis.overall_score,
            channel_scores: analysis.channel_scores,
            issues: analysis.issues,
            action_items: analysis.action_items,
            conversations_analyzed: conversations.length,
            // Ordered ticket ids — index N (1-based) in this array maps to the
            // "Ticket N" / "Conversation N" labels Claude returns in `issues`.
            ticket_ids: conversations.map(c => c.ticketId),
            date: new Date().toISOString().split("T")[0],
          },
        });

        // If score is low, create high-priority notification
        if (analysis.overall_score < 6 || highPriorityActions.length > 0) {
          for (const action of highPriorityActions) {
            await admin.from("dashboard_notifications").insert({
              workspace_id: workspaceId,
              type: "system",
              title: `AI Action Required: ${action.description.slice(0, 60)}`,
              body: action.description,
              link: "/dashboard/settings/ai",
              metadata: { type: "ai_action_item", priority: action.priority },
            });
          }
        }

        return { analyzed: conversations.length, score: analysis.overall_score };
      });

      totalAnalyzed += results.analyzed || 0;
    }

    return { workspaces: workspaces.length, totalAnalyzed };
  }
);
