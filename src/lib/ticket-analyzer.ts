/**
 * Per-ticket AI analysis. Replaces the nightly batch.
 *
 * Flow:
 *   1. Find closed tickets needing analysis (cron, every 30 min)
 *   2. For each ticket, pull messages since last_analyzed_at (or ticket creation)
 *   3. Skip if no AI messages in window (don't waste a call)
 *   4. Skip if ticket is spam/outreach/auto-reply (low-value)
 *   5. Send to Sonnet with the rubric + approved grader_prompts
 *   6. Insert ticket_analyses row + ai_token_usage row tagged with ticket_id
 *   7. Apply severity actions: ≤5 → escalate + notify customer; 6 → escalate silently;
 *      7+ → log only. Plus issue-type overrides.
 *
 * See discussion 2026-05-06 with Dylan.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { logAiUsage, usageCostCents } from "@/lib/ai-usage";

type Admin = ReturnType<typeof createAdminClient>;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GRADER_MODEL = "claude-sonnet-4-20250514";

// Tickets we don't waste a Sonnet call on
const SKIP_TAGS = new Set(["spam:bot", "outreach", "cls:outreach"]);

// "Severe issue" types that force escalation regardless of overall score
const SEVERE_ISSUE_TYPES = new Set(["inaccuracy", "false_promise", "broken_action"]);

// Customer-message keywords that force escalation regardless of score
const CUSTOMER_ESCALATION_KEYWORDS = [
  "lawyer", "attorney", "bbb", "better business bureau",
  "chargeback", "dispute charge", "credit card company",
  "social media", "facebook", "twitter", "tiktok", "instagram",
  "report you", "fraud", "scam",
];

interface AnalysisResult {
  score: number;
  issues: Array<{ type: string; description: string }>;
  action_items: Array<{ priority: string; description: string }>;
  summary: string;
}

interface MessageRow {
  direction: string | null;
  author_type: string | null;
  body: string | null;
  created_at: string;
  visibility: string | null;
}

/**
 * Build the grader system prompt. Includes the static rubric + any
 * approved grader_prompts (calibration rules learned from admin overrides).
 */
async function buildGraderSystemPrompt(admin: Admin, workspaceId: string): Promise<string> {
  const { data: rules } = await admin.from("grader_prompts")
    .select("title, content")
    .eq("workspace_id", workspaceId)
    .eq("status", "approved")
    .order("sort_order", { ascending: true });

  const rulesBlock = (rules || []).length
    ? "\n\nCALIBRATION RULES (apply these — they are admin-approved adjustments to the rubric):\n\n" +
      (rules || []).map(r => `• ${r.title}\n  ${r.content}`).join("\n\n")
    : "";

  return `You are an AI Quality Analyst grading customer-support conversations handled by an AI agent named Suzie/Julie.

You will be shown a window of messages from a single ticket. Grade ONLY the AI agent's behavior in this window. Do not grade human agent messages or system messages.

EVALUATION DIMENSIONS (most damaging first):
  1. Action ↔ Message Consistency — did the AI claim it did something it didn't actually do? (e.g. "I cancelled your subscription" with no cancel action attached)
  2. Accuracy — did the AI give wrong information, hallucinate codes/dates/policies, or fabricate facts?
  3. Intent Resolution — did the AI actually solve what the customer asked, or sidestep / route them elsewhere unnecessarily?
  4. Rule Compliance — did the AI follow our internal routing rules (cancels go to journey, LOYALTY codes use apply_loyalty_coupon, no phone callback promises, etc.)?
  5. Tone / Empathy — robotic boilerplate, sales-y framing, reflexive apologies for things we communicated upfront, repeating context unnecessarily?
  6. Conversation Drift / Loops — did the AI repeat itself, ask for info already in the thread, forget earlier turns?
  7. Escalation Appropriateness — escalated when capable / kept trying past competence / handled correctly?
  8. Customer Signal — positive close ("thanks!") = good. Frustration markers / repeat asks / "speak to human" / threats = bad.
  9. Context Respect — did the AI honor grandfathered pricing / VIP status / agent-intervened threads / crisis enrollment?
  10. Resolution Efficiency — simple ask in 1 turn vs 5 turns?

SCORING (1-10):
  10 — flawless: accurate, actions matched, problem solved, customer happy
  8-9 — solid: minor tone/efficiency issues but resolved correctly
  6-7 — acceptable: handled but some friction or minor gaps
  4-5 — mediocre: noticeable issues, partial resolution, customer unsure
  2-3 — bad: wrong info, broken promise, or customer clearly upset
  1 — catastrophic: the AI lied, broke a major promise, or insulted the customer

HARD CAPS:
  • Any factual inaccuracy (wrong code, wrong date, wrong policy, hallucinated info) = max score 5
  • Any unkept promise ("I'll process your refund") with no matching action = max score 4
  • Any repeated identical response (>2 times) = max score 5

ISSUE TYPES (use these exact strings):
  inaccuracy, robotic, frustration, missed_opportunity, kb_gap, broken_action, false_promise, drift, rule_violation${rulesBlock}

OUTPUT (JSON only, no prose around it):
{
  "score": <integer 1-10>,
  "issues": [{"type": "<one of the issue types above>", "description": "<concrete, specific>"}],
  "action_items": [{"priority": "high|medium|low", "description": "<actionable improvement>"}],
  "summary": "<1-2 sentences>"
}`;
}

/**
 * Format ticket messages for grading. Strips HTML, distinguishes AI from
 * human-agent messages by author_type.
 */
function formatMessagesForGrading(msgs: MessageRow[]): string {
  return msgs.map(m => {
    const role = m.direction === "inbound"
      ? "customer"
      : m.author_type === "ai"
      ? "ai"
      : m.author_type === "agent"
      ? "human_agent"
      : m.author_type === "system"
      ? "system"
      : "system";
    const cleaned = (m.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const body = cleaned.length > 1500 ? cleaned.slice(0, 1500) + " […trimmed]" : cleaned;
    return `${role}: ${body}`;
  }).join("\n");
}

interface AnalyzeResult {
  ok: boolean;
  reason?: string;
  analysis?: AnalysisResult;
  cost_cents?: number;
  ai_message_count?: number;
}

/**
 * Analyze a single ticket. Returns ok=false with a reason when we
 * intentionally skip (no AI messages, spam tags, etc.) — caller should
 * still mark `last_analyzed_at` so we don't re-check.
 */
export async function analyzeTicket(
  ticketId: string,
  trigger: "auto_close" | "manual_close" | "reopen_close" | "manual" = "auto_close",
): Promise<AnalyzeResult> {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };

  const admin = createAdminClient();

  const { data: ticket } = await admin.from("tickets")
    .select("id, workspace_id, status, channel, tags, ai_turn_count, escalation_reason, last_analyzed_at, created_at, customer_id")
    .eq("id", ticketId).maybeSingle();
  if (!ticket) return { ok: false, reason: "ticket_not_found" };

  // Skip spam / outreach / B2B
  const tags = (ticket.tags as string[]) || [];
  if (tags.some(t => SKIP_TAGS.has(t))) {
    return { ok: false, reason: "skip_tag" };
  }

  // Latest analysis defines the start of the next window
  const { data: prevAnalysis } = await admin.from("ticket_analyses")
    .select("window_end")
    .eq("ticket_id", ticketId)
    .order("window_end", { ascending: false })
    .limit(1)
    .maybeSingle();

  const windowStart = prevAnalysis?.window_end || ticket.created_at;
  const windowEnd = new Date().toISOString();

  // Pull messages in the window
  const { data: msgsRaw } = await admin.from("ticket_messages")
    .select("direction, author_type, body, visibility, created_at")
    .eq("ticket_id", ticketId)
    .gte("created_at", windowStart)
    .lte("created_at", windowEnd)
    .order("created_at", { ascending: true });

  // Strip out our own holding-message replies. The auto-analyzer inserts
  // a "we're taking another look" message tagged with an HTML sentinel
  // when it re-opens a ticket — grading that as if it were an AI turn
  // double-counts our own intervention.
  const msgs = (msgsRaw || []).filter(m => !(m.body || "").includes("AUTO_ANALYSIS_HOLDING"));

  if (!msgs.length) return { ok: false, reason: "no_messages_in_window" };

  // Don't grade if there are no AI messages — nothing to analyze
  const aiMessageCount = msgs.filter(m =>
    m.direction === "outbound" && m.author_type === "ai" && m.visibility === "external"
  ).length;
  if (aiMessageCount === 0) {
    return { ok: false, reason: "no_ai_messages_in_window" };
  }

  const system = await buildGraderSystemPrompt(admin, ticket.workspace_id);
  const conversation = formatMessagesForGrading(msgs);

  const userMsg = `Grade this conversation window. The window covers ${windowStart} → ${windowEnd}.\n\n--- CONVERSATION ---\n${conversation}\n\nReturn the JSON only.`;

  // Call Sonnet
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GRADER_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!res.ok) {
    return { ok: false, reason: `grader_http_${res.status}` };
  }

  const data = await res.json();
  const text = (data.content?.[0] as { text?: string })?.text?.trim() || "";
  const usage = data.usage;

  // Log token usage tagged to this ticket
  const costCents = usage
    ? usageCostCents(GRADER_MODEL, {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_tokens: usage.cache_read_input_tokens || 0,
      })
    : 0;

  await logAiUsage({
    workspaceId: ticket.workspace_id,
    model: GRADER_MODEL,
    usage,
    purpose: "ticket_analysis",
    ticketId,
  });

  // Parse JSON response
  let analysis: AnalysisResult | null = null;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) analysis = JSON.parse(jsonMatch[0]) as AnalysisResult;
  } catch { /* fall through */ }

  if (!analysis || typeof analysis.score !== "number") {
    return { ok: false, reason: "parse_failed" };
  }

  // Insert the analysis row
  const { data: inserted } = await admin.from("ticket_analyses").insert({
    workspace_id: ticket.workspace_id,
    ticket_id: ticketId,
    window_start: windowStart,
    window_end: windowEnd,
    score: analysis.score,
    issues: analysis.issues || [],
    action_items: analysis.action_items || [],
    summary: analysis.summary || null,
    model: GRADER_MODEL,
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    cost_cents: costCents,
    trigger,
    ai_message_count: aiMessageCount,
  }).select("id").single();

  // Update ticket.last_analyzed_at
  await admin.from("tickets")
    .update({ last_analyzed_at: windowEnd })
    .eq("id", ticketId);

  // Severity actions
  await applySeverityActions(admin, ticket.id, ticket.workspace_id, ticket.customer_id, analysis, msgs, inserted?.id);

  return { ok: true, analysis, cost_cents: costCents, ai_message_count: aiMessageCount };
}

/**
 * Apply severity actions based on score + overrides.
 *
 *   ≤5  → re-open + escalate + send "we're reviewing" message
 *   6   → re-open + escalate, silent (no customer message)
 *   7+  → log only
 *
 * Overrides (force escalate regardless of score):
 *   - Any 'inaccuracy', 'false_promise', or 'broken_action' issue
 *   - Customer message in window contained chargeback/lawyer/BBB/social-media keywords
 */
async function applySeverityActions(
  admin: Admin,
  ticketId: string,
  workspaceId: string,
  customerId: string | null,
  analysis: AnalysisResult,
  msgs: MessageRow[],
  analysisId?: string,
): Promise<void> {
  const score = analysis.score;
  const issues = analysis.issues || [];

  const hasSevereIssue = issues.some(i => SEVERE_ISSUE_TYPES.has(i.type));
  const customerThreat = msgs.some(m => {
    if (m.direction !== "inbound") return false;
    const txt = (m.body || "").toLowerCase();
    return CUSTOMER_ESCALATION_KEYWORDS.some(k => txt.includes(k));
  });

  const forceEscalate = hasSevereIssue || customerThreat;

  // Decide tier
  // ≤5: escalate + customer message
  // 6 OR forceEscalate at any score: escalate silent (NO customer message)
  // 7+ without force: nothing
  let action: "escalate_with_message" | "escalate_silent" | "none" = "none";
  if (score <= 5) {
    action = "escalate_with_message";
  } else if (score === 6 || forceEscalate) {
    action = "escalate_silent";
  }

  if (action === "none") return;

  // Re-open + escalate
  const escReason = forceEscalate
    ? `Auto-flag: ${hasSevereIssue ? "severe issue type" : "customer threat language"} (score ${score})`
    : `Low quality score: ${score}/10 — ${(analysis.summary || "see issues").slice(0, 200)}`;

  // Round-robin agent (any escalation needs an assignee)
  const { data: members } = await admin.from("workspace_members")
    .select("user_id, role").eq("workspace_id", workspaceId)
    .in("role", ["owner", "admin", "agent"]);
  const assignee = members?.[0]?.user_id || null;

  await admin.from("tickets").update({
    status: "open",
    escalated_to: assignee,
    escalated_at: new Date().toISOString(),
    escalation_reason: escReason,
    updated_at: new Date().toISOString(),
  }).eq("id", ticketId);

  // Single internal-note message describing why the auto-analysis
  // re-opened + escalated this ticket. The note's wording differs
  // based on severity so the agent can triage at a glance — but in
  // every case it stays INTERNAL. We never send a follow-up to the
  // customer; the previous "we're taking another look" outbound was
  // pulled because most low-score tickets had already been resolved
  // by the AI and the message just confused customers.
  const noteBody =
    action === "escalate_with_message"
      ? `[Auto-Analysis] Low score ${score}/10 — this ticket needs another look. ${analysisId ? `Analysis ${analysisId}.` : ""}`
      : `[Auto-Analysis] Re-opened + escalated silently. Score ${score}/10. ${analysisId ? `Analysis ${analysisId}.` : ""}`;
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: noteBody,
  });
}
