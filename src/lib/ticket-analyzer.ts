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
import { SONNET_MODEL } from "@/lib/ai-models";

type Admin = ReturnType<typeof createAdminClient>;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GRADER_MODEL = SONNET_MODEL;

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

  const { currentDateContext } = await import("@/lib/ai-date-context");

  return `You are an AI Quality Analyst grading customer-support conversations handled by an AI agent named Suzie/Julie.

${currentDateContext()}

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
 * Build a "playbook context" block for the grader. When a ticket has an
 * active playbook running, the grader needs to know that the AI's
 * behavior is constrained by the playbook's documented step sequence
 * — otherwise it penalizes legitimate playbook execution as if the AI
 * were just dodging the customer's actual ask.
 *
 * Returns null if no playbook is active.
 */
async function buildPlaybookContextForGrader(
  admin: Admin,
  ticket: { active_playbook_id: string | null; playbook_step: number | null; playbook_context: Record<string, unknown> | null; tags: string[] | null },
): Promise<string | null> {
  if (!ticket.active_playbook_id) return null;

  const { data: playbook } = await admin.from("playbooks")
    .select("name, slug, description")
    .eq("id", ticket.active_playbook_id)
    .maybeSingle();
  if (!playbook) return null;

  const tags = (ticket.tags as string[]) || [];
  const pbTag = tags.find(t => t.startsWith("pb:")) || `pb:${playbook.slug || "unknown"}`;

  // Playbook-specific context. Some playbooks have intentional "do
  // something before the obvious ask" steps that the grader needs to
  // understand. Add per-playbook context as we encounter false-penalty
  // patterns.
  const playbookHints: Record<string, string> = {
    "pb:refund": `The refund playbook is designed to NOT immediately offer a refund. Step 1 is to launch a cancel journey (or, if the sub is already paused, a pause-confirmation message), because sometimes giving the customer control over their subscription resolves their underlying complaint without needing a refund. So if the AI sent a "manage subscription" link or a "would you like to keep your subscription paused" question as its first response to a refund ask, that is the CORRECT playbook step and should NOT be graded as "didn't address the refund." The playbook proceeds to refund handling after the save attempt resolves.`,
    "pb:replacement_order": `The replacement playbook asks clarifying questions ("did you receive your order? was something missing or damaged?") before issuing a replacement. Those questions are intentional verification steps, not stalling.`,
    "pb:return_request": `The return-request playbook walks the customer through return eligibility before issuing a label. Questions about order number and product condition are intentional verification steps.`,
  };

  const hint = playbookHints[pbTag] || `The ticket is following the "${playbook.name}" playbook. Its steps are intentional — don't penalize the AI for executing the playbook's documented behavior.`;

  // Context state from the playbook execution
  const ctx = (ticket.playbook_context || {}) as Record<string, unknown>;
  const stateLines: string[] = [];
  if (ctx.paused_for_cancel) stateLines.push("- Currently waiting for customer to complete the cancel journey");
  if (ctx.paused_for_pause_confirmation) stateLines.push("- Currently waiting for customer to confirm whether to keep their subscription paused");
  if (ctx.cancel_journey_completed) stateLines.push("- Cancel journey already completed");
  if (ctx.cancel_handled) stateLines.push("- Cancel/save step already resolved; refund discussion is the current focus");
  if (ctx.exception_offered) stateLines.push("- Exception offer already made; waiting on customer acceptance");
  if (ctx.offer_accepted) stateLines.push("- Customer accepted the exception offer; return is being processed");

  return [
    `Active playbook: ${playbook.name} (${pbTag}), currently at step ${ticket.playbook_step ?? "?"}.`,
    hint,
    stateLines.length ? "\nCurrent playbook state:\n" + stateLines.join("\n") : "",
  ].filter(Boolean).join("\n");
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
    .select("id, workspace_id, status, channel, tags, ai_turn_count, escalation_reason, last_analyzed_at, created_at, customer_id, active_playbook_id, playbook_step, playbook_context, do_not_reply")
    .eq("id", ticketId).maybeSingle();
  if (!ticket) return { ok: false, reason: "ticket_not_found" };

  // do_not_reply tickets don't get analyzed — the AI intentionally
  // didn't reply (wrong company, spam, etc), so grading the absent
  // response would always score poorly and re-escalate, which is the
  // opposite of what we want.
  if (ticket.do_not_reply) {
    return { ok: false, reason: "do_not_reply" };
  }

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

  // ── Playbook context ──
  // When a ticket is mid-playbook, the AI's behavior is constrained by
  // the playbook's documented steps. The grader needs to know what step
  // the playbook is on so it doesn't penalize "didn't directly address
  // the refund ask" when sending the cancel-journey link is the actual
  // first step of the refund playbook by design.
  const playbookContext = await buildPlaybookContextForGrader(admin, ticket);

  const userMsg = `Grade this conversation window. The window covers ${windowStart} → ${windowEnd}.${playbookContext ? `\n\n--- PLAYBOOK CONTEXT ---\n${playbookContext}` : ""}\n\n--- CONVERSATION ---\n${conversation}\n\nReturn the JSON only.`;

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

  // ── Deterministic post-grader checks ──
  // The AI grader sees the conversation transcript but can't query the
  // DB. Some failures are only visible if you cross-reference what the
  // AI claimed in the thread against current state. Run those here and
  // inject findings into `analysis.issues` + cap the score so severity
  // routing catches them.
  const cancelCheck = await detectUnfulfilledCancelClaim(admin, ticket.id, ticket.customer_id, msgs);
  if (cancelCheck) {
    analysis.issues = [cancelCheck, ...(analysis.issues || [])];
    analysis.score = Math.min(analysis.score, 3); // catastrophic — broken cancel promise
    if (analysis.summary && !/cancel/i.test(analysis.summary)) {
      analysis.summary = `Cancel journey reported success but subscription remains active. ${analysis.summary}`;
    } else if (!analysis.summary) {
      analysis.summary = "Cancel journey reported success but subscription remains active — agent must manually cancel.";
    }
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
 * Did the system tell the customer their subscription was cancelled
 * while the underlying contract is still active in our DB? This bug
 * pattern (cancel journey claims success, Appstle was never called)
 * burned 15+ customers in mid-May 2026 — see commit 5e879e2 for the
 * underlying fix. This detector catches it post-hoc on any new ticket
 * so it can't recur silently.
 *
 * Cross-references:
 *   - The conversation has a "cancel completed" indicator (from
 *     either the journey or the AI)
 *   - The customer's intended target sub (resolved via journey session
 *     or by single-active fallback) is still status='active'
 *
 * Returns a `broken_action` issue when fired; null otherwise.
 */
async function detectUnfulfilledCancelClaim(
  admin: Admin,
  ticketId: string,
  customerId: string | null,
  msgs: MessageRow[],
): Promise<{ type: string; description: string } | null> {
  if (!customerId) return null;

  // Look for cancel-claim signals in the window
  const cancelClaimSignals = [
    /Your subscription has been cancelled/i,
    /Cancel journey completed/i,
    /\bI(?:'ve|\s+have)\s+cancelled?\s+your\s+subscription/i,
    /\bsubscription\s+(?:is\s+now\s+|has\s+been\s+)?cancelled\b/i,
  ];
  const hasClaim = (msgs || []).some(m => {
    const txt = (m.body || "").replace(/<[^>]+>/g, " ");
    return cancelClaimSignals.some(rx => rx.test(txt));
  });
  if (!hasClaim) return null;

  // Find the cancel journey session for this ticket (most recent)
  const { data: sessions } = await admin.from("journey_sessions")
    .select("id, subscription_id, responses, config_snapshot, outcome")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false });

  let intendedContractId: string | null = null;
  let intendedSubId: string | null = null;
  for (const s of sessions || []) {
    const jt = (s.config_snapshot as Record<string, unknown> | null)?.journeyType as string | undefined;
    if (jt && /cancel/i.test(jt) && s.outcome === "cancelled") {
      // Strategy 1: select_subscription response
      const sel = (s.responses as Record<string, { value?: string }> | null)?.select_subscription?.value;
      if (sel) {
        intendedSubId = sel;
        const { data: sub } = await admin.from("subscriptions").select("shopify_contract_id").eq("id", sel).maybeSingle();
        if (sub) intendedContractId = sub.shopify_contract_id;
      }
      // Strategy 2: session.subscription_id
      if (!intendedSubId && s.subscription_id) {
        intendedSubId = s.subscription_id;
        const { data: sub } = await admin.from("subscriptions").select("shopify_contract_id").eq("id", s.subscription_id).maybeSingle();
        if (sub) intendedContractId = sub.shopify_contract_id;
      }
      break;
    }
  }

  // Resolve the customer's linked group
  const linkedIds = [customerId];
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).maybeSingle();
  if (link?.group_id) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    for (const g of grp || []) if (!linkedIds.includes(g.customer_id)) linkedIds.push(g.customer_id);
  }

  // Strategy 3: if no intended target known, fall back to "customer has exactly one active sub"
  if (!intendedSubId) {
    const { data: active } = await admin.from("subscriptions")
      .select("id, shopify_contract_id, status").in("customer_id", linkedIds).eq("status", "active");
    if ((active || []).length === 1) {
      intendedSubId = active![0].id;
      intendedContractId = active![0].shopify_contract_id;
    } else if ((active || []).length > 1) {
      // Ambiguous — but if a cancel claim was made AND the customer has multiple active subs,
      // that's also suspicious. Flag it as ambiguous so an agent reviews.
      return {
        type: "broken_action",
        description: `Cancel completion message was sent but the target subscription is ambiguous — customer has ${active!.length} active subs and the journey session has no resolved target. Possible silent no-op from the pre-5e879e2 cancel handler bug. Agent must verify the intended sub was cancelled.`,
      };
    } else {
      // No active subs left — cancel probably worked through some other path
      return null;
    }
  }

  // Check if the intended target is still active
  if (intendedSubId) {
    const { data: sub } = await admin.from("subscriptions")
      .select("status, shopify_contract_id").eq("id", intendedSubId).maybeSingle();
    if (sub?.status === "active") {
      return {
        type: "broken_action",
        description: `Customer was told their subscription was cancelled, but contract ${sub.shopify_contract_id || intendedContractId} is still active in our DB. The Appstle cancel call did not fire (or did fire but the webhook hasn't synced). This is the cancel-journey silent-no-op pattern fixed in commit 5e879e2 — but verify in case it recurred.`,
      };
    }
  }

  return null;
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

  // ── Respect human-agent closure ──
  // If a human agent already handled this ticket (agent_intervened) or
  // an agent manually closed/resolved it after their review, the
  // analyzer should NOT re-open. The agent's review is the source of
  // truth — auto-reopening overrides their judgment, frustrates them,
  // and creates churn (close → analyze → reopen → close again loop).
  const { data: tBefore } = await admin.from("tickets")
    .select("agent_intervened, status, closed_at, resolved_at")
    .eq("id", ticketId).single();
  if (tBefore?.agent_intervened) {
    // Log the would-be escalation as a system note but don't actually
    // re-open the ticket. The agent already weighed in; if there's a
    // real issue they can flag it manually.
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[Auto-Analysis] Score ${score}/10 — would have ${action === "escalate_with_message" ? "re-opened + escalated" : "re-opened silently"}, but skipped because an agent already handled this ticket. ${analysisId ? `Analysis ${analysisId}.` : ""}`,
    });
    return;
  }

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
