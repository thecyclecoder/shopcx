/**
 * Manually re-run the AI nightly analysis on a specific 24h window.
 * Same logic as src/lib/inngest/ai-nightly-analysis.ts (post-3fb853e
 * fix where messages are scoped to last 24h per ticket).
 *
 *   Usage:
 *     npx tsx scripts/rerun-ai-analysis.ts          # rolling 24h ending now
 *     npx tsx scripts/rerun-ai-analysis.ts <ISO>    # 24h window ending at <ISO>
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const endIso = process.argv[2] || new Date().toISOString();
const end = new Date(endIso);
const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

console.log(`Analysis window: ${start.toISOString()}  →  ${end.toISOString()}\n`);

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // Tickets with 'ai' tag updated in the window
  const { data: tickets } = await admin
    .from("tickets")
    .select("id, subject, channel, ai_turn_count, escalation_reason, status")
    .eq("workspace_id", W)
    .contains("tags", ["ai"])
    .gte("updated_at", start.toISOString())
    .lte("updated_at", end.toISOString());

  console.log(`Found ${tickets?.length || 0} AI-tagged tickets in window\n`);
  if (!tickets?.length) return;

  const conversations: {
    ticketId: string;
    channel: string;
    subject: string;
    turns: number;
    escalated: boolean;
    hasPriorHistory: boolean;
    messages: { role: string; body: string }[];
  }[] = [];

  for (const t of tickets.slice(0, 50)) {
    // Prior-history flag — same as production
    const { count: priorCount } = await admin
      .from("ticket_messages")
      .select("id", { count: "exact", head: true })
      .eq("ticket_id", t.id)
      .eq("visibility", "external")
      .lt("created_at", start.toISOString());

    // Only messages from the analysis window
    const { data: msgs } = await admin
      .from("ticket_messages")
      .select("direction, author_type, body, visibility, created_at")
      .eq("ticket_id", t.id)
      .eq("visibility", "external")
      .gte("created_at", start.toISOString())
      .lte("created_at", end.toISOString())
      .order("created_at", { ascending: true });

    if (!msgs?.length) continue;

    conversations.push({
      ticketId: t.id,
      channel: t.channel || "email",
      subject: t.subject || "",
      turns: t.ai_turn_count || 0,
      escalated: !!t.escalation_reason,
      hasPriorHistory: (priorCount || 0) > 0,
      // Use author_type as role so Claude can distinguish AI ("Julie",
      // "Suzie" personas) from real humans. Body clipped to 1500 chars
      // with a [trimmed] marker — see ai-nightly-analysis.ts for the
      // false-positive context.
      messages: msgs.slice(-30).map((m: { direction: string; body: string | null; author_type: string | null }) => {
        const cleaned = (m.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const body = cleaned.length > 1500 ? cleaned.slice(0, 1500) + " […trimmed]" : cleaned;
        return {
          role:
            m.direction === "inbound" ? "customer"
            : m.author_type === "ai" ? "ai"
            : m.author_type === "agent" ? "human_agent"
            : m.author_type === "system" ? "system"
            : "agent",
          body,
        };
      }),
    });
  }

  console.log(`Sending ${conversations.length} conversation(s) to Claude for grading…\n`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error("No ANTHROPIC_API_KEY"); process.exit(1); }

  const analysisPrompt = conversations
    .map((c, i) => {
      const thread = c.messages.map(m => `${m.role}: ${m.body}`).join("\n");
      const priorTag = c.hasPriorHistory ? ", HAS PRIOR HISTORY (older messages intentionally excluded)" : "";
      return `--- Ticket ${i + 1} (${c.channel}, ${c.turns} AI turns${c.escalated ? ", ESCALATED" : ""}${priorTag}) ---\nSubject: ${c.subject}\n${thread}`;
    })
    .join("\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: `You are an AI quality analyst reviewing customer support conversations handled by an AI agent.

You will be shown only the messages from the last 24 hours of each ticket. Tickets marked "HAS PRIOR HISTORY" had earlier conversation that was intentionally excluded from this prompt — do NOT penalize the AI for not acknowledging context you can't see, do NOT score those tickets based on assumed prior failures, and do NOT count loops/repetition that may have happened before this window. Only grade what's in front of you.

ROLE LABELS:
  customer     — inbound from the customer
  ai           — the AI agent (signed with personas like "Julie" or "Suzie" — these are AI personas, NOT human agents)
  human_agent  — actual human team member (e.g. an assigned agent)
  system       — internal status notes (skip these)

Only grade AI agent messages (role=ai). Do NOT grade human_agent or system messages. If a ticket has no role=ai messages in this window, skip it — do not include it in scoring.

A trailing "[…trimmed]" marker on a message means the prompt was clipped for length — the actual sent message was longer and was NOT cut off in production. Do NOT report "[…trimmed]" or any apparent end-of-message-text as an "incomplete response" or "truncation" issue. Only flag truncation if the AI's intent is clearly cut off mid-thought WITHOUT a "[…trimmed]" marker.

Analyze each conversation and provide:
1. Overall score (1-10) for the batch — based ONLY on the AI messages shown
2. Per-channel breakdown (email, chat, etc.)
3. Issues found: inaccurate responses, robotic tone, customer frustration, missed opportunities — only when visible in AI messages
4. Action items: specific improvements needed

Return JSON:
{
  "overall_score": number,
  "total_conversations": number,
  "channel_scores": { "email": number, "chat": number, ... },
  "issues": [{ "ticket_index": number, "type": "inaccuracy"|"robotic"|"frustration"|"missed_opportunity"|"kb_gap", "description": string }],
  "action_items": [{ "priority": "high"|"medium"|"low", "description": string }],
  "summary": string
}`,
      messages: [{ role: "user", content: `Analyze these ${conversations.length} AI-handled support conversations:\n\n${analysisPrompt}` }],
    }),
  });

  if (!res.ok) { console.error("Claude error:", res.status, await res.text()); process.exit(1); }
  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  if (!analysis) { console.error("Failed to parse:", text.slice(0, 500)); process.exit(1); }

  console.log(`──────────────────────────────────────`);
  console.log(`Overall: ${analysis.overall_score}/10  (${analysis.total_conversations} conversations)`);
  console.log(`Channel scores: ${JSON.stringify(analysis.channel_scores)}`);
  console.log(`──────────────────────────────────────\n`);
  console.log(`Summary: ${analysis.summary}\n`);
  console.log(`Issues (${analysis.issues?.length || 0}):`);
  for (const issue of analysis.issues || []) {
    const tid = conversations[issue.ticket_index - 1]?.ticketId || "?";
    console.log(`  [#${issue.ticket_index}] (${issue.type}) ${issue.description}`);
    console.log(`     ↳ ticket: ${tid}`);
  }
  console.log(`\nAction items:`);
  for (const a of analysis.action_items || []) {
    console.log(`  [${a.priority}] ${a.description}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
