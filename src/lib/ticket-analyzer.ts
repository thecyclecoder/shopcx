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
import { cleanEmailBody } from "@/lib/email-cleaner";
import { SKIP_TAGS } from "@/lib/ticket-tags";
import { emitInlineAgentHeartbeat } from "@/lib/control-tower/heartbeat";
import { INLINE_AGENT_IDS } from "@/lib/control-tower/registry";

type Admin = ReturnType<typeof createAdminClient>;

// The grader now runs as a supervised box-session agent under 💬 June (CS Director) — see
// docs/brain/specs/ticket-analyzer-becomes-box-agent-under-june.md § Phase 1. The direct Anthropic
// fetch that used to live in analyzeTicketInner is gone; a `ticket-analyze` agent_jobs row is
// enqueued instead and the box's runTicketAnalyzeJob runs the grader session on Max (flat-rate),
// then hands the parsed verdict back to applyAnalyzerVerdict for the deterministic insert +
// severity actions. GRADER_MODEL stays exported so ticket_analyses.model still carries the
// canonical grader model tag (the box path also records the actual per-run model on the row via
// applyAnalyzerVerdict when the box lane knows it).
const GRADER_MODEL = SONNET_MODEL;

// "Severe issue" types that force escalation regardless of overall score
const SEVERE_ISSUE_TYPES = new Set(["inaccuracy", "false_promise", "broken_action"]);

// The system note emitted on a clean AI positive close
// (src/lib/inngest/unified-ticket-handler.ts:1593). The real note appends
// "Active playbook cleared." — we match the stable prefix as a substring so
// the detection survives future trailing-text tweaks.
const POSITIVE_CLOSE_NOTE = "[System] Positive close. Ticket closed.";

// Markers that uniquely identify an analyzer RE-OPEN note (as opposed to a
// "would have re-opened … but skipped" note, which does NOT reactivate the
// ticket). Used to confirm a positive close is the most recent lifecycle
// event. See applySeverityActions noteBody variants below.
const REOPEN_NOTE_MARKERS = [
  "[Auto-Analysis] Re-opened + escalated silently",
  "this ticket needs another look",
];

/**
 * Deterministically decide whether the ticket's CURRENT, most-recent
 * lifecycle state is a clean positive close. Scans the FULL message history
 * (not just the analysis window — the close note often predates it) for the
 * positive-close system note and confirms nothing has reactivated the ticket
 * since: no re-open/escalation note after it, and no UNANSWERED inbound
 * customer message after it. A ticket that was re-opened then re-closed
 * (e.g. 9a6e53d9, which had a prior score-3 reopen) is classified by its
 * LATEST close, so it still counts as positively closed.
 *
 * Deliberately NOT keyed on tickets.status/closed_at/resolved_at: the
 * analyzer only runs on closed tickets, so status='closed' is near-universal
 * and would suppress the override globally.
 */
async function hasCleanPositiveClose(admin: Admin, ticketId: string): Promise<boolean> {
  const { data: all } = await admin.from("ticket_messages")
    .select("direction, author_type, body, visibility, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (!all || all.length === 0) return false;

  // Most recent positive-close system note timestamp.
  let closeAt: string | null = null;
  for (const m of all) {
    if ((m.body || "").includes(POSITIVE_CLOSE_NOTE)) closeAt = m.created_at;
  }
  if (!closeAt) return false;

  for (const m of all) {
    if (m.created_at <= closeAt) continue;
    // A re-open / escalation note after the close means the ticket was
    // reactivated since — not cleanly closed.
    if (REOPEN_NOTE_MARKERS.some(marker => (m.body || "").includes(marker))) return false;
    // An inbound (customer) message after the close that no outbound has
    // answered is a live, unanswered turn — not cleanly closed.
    if (m.direction === "inbound") {
      const answered = all.some(o => o.direction === "outbound" && o.created_at > m.created_at);
      if (!answered) return false;
    }
  }
  return true;
}

/**
 * Map analyzer issue types to research recipe slugs that can verify
 * whether the AI's claim matches reality. Keep this conservative —
 * only fire recipes whose result might unlock an auto-heal. Misses are
 * cheap (admin can still run manually) but false-positive runs cost
 * Anthropic calls + Shopify queries.
 */
function selectResearchRecipes(issues: Array<{ type: string; description: string }>): string[] {
  const slugs = new Set<string>();
  for (const issue of issues) {
    const text = (issue.description || "").toLowerCase();
    const severe = issue.type === "false_promise" || issue.type === "broken_action" || issue.type === "inaccuracy";
    if (!severe) continue;

    if (text.includes("coupon") || text.includes("loyalty") || text.includes("reward") || text.includes("discount")) {
      slugs.add("verify_coupon_promises");
    }
    // Wide net for any subscription-mutation claim. Cheap to run when the
    // analyzer already flagged a likely issue — recipe itself is idempotent
    // and bails fast if no claims are extracted.
    if (
      text.includes("subscription") || text.includes("subscribe") ||
      text.includes("paus") || text.includes("resum") ||
      text.includes("skip") || text.includes("skipped") ||
      text.includes("swap") || text.includes("swit") ||  // switch/switched/swap
      text.includes("cancel") || text.includes("cancell") ||
      text.includes("flavor") || text.includes("variant") ||
      text.includes("frequen") || text.includes("interval") ||
      text.includes("next order") || text.includes("next billing") || text.includes("next ship") ||
      text.includes("delivery date") || text.includes("billing date") || text.includes("ship date") ||
      text.includes("removed") || text.includes("added") ||
      text.includes("price") || text.includes("$")
    ) {
      slugs.add("verify_subscription_changes");
    }
    // Proactive pricing-drift detection. Fires on any severe issue
    // mentioning pricing — the recipe itself compares the customer's
    // current sub prices to their historical order pattern and emits
    // a gap only when there's a meaningful drift. No AI claim required.
    if (
      text.includes("price") || text.includes("pricing") || text.includes("$") ||
      text.includes("charge") || text.includes("expensive") ||
      text.includes("grandfather") || text.includes("used to pay") ||
      text.includes("more than") || text.includes("went up") ||
      text.includes("raised") || text.includes("higher") ||
      text.includes("cost")
    ) {
      slugs.add("verify_grandfathered_pricing");
    }
    // Future recipes wire in here:
    //   - verify_replacement_promises — replacement order claims
    //   - verify_refund_issued — refund claims
  }
  return Array.from(slugs);
}

// Customer-message keywords that force escalation regardless of score
const CUSTOMER_ESCALATION_KEYWORDS = [
  "lawyer", "attorney", "bbb", "better business bureau",
  "chargeback", "dispute charge", "credit card company",
  "social media", "facebook", "twitter", "tiktok", "instagram",
  "report you", "fraud", "scam",
];

// Benign phrases that contain a threat keyword but indicate the customer
// is cooperating (e.g. reporting a bank-side fraud alert). When a phrase
// in this denylist appears in the body, the matching keyword is excluded
// from the threat check. Seen on ticket a613e06e: "they Fraud Alert me"
// from a customer cooperating with us substring-matched "fraud" and
// force-escalated despite a positive close.
const ESCALATION_KEYWORD_DENYLIST: Record<string, string[]> = {
  fraud: ["fraud alert", "fraud team", "flagged for fraud", "bank fraud", "fraud department", "fraud protection"],
};

function matchesEscalationKeyword(loweredText: string, keyword: string): boolean {
  if (!loweredText.includes(keyword)) return false;
  const denylist = ESCALATION_KEYWORD_DENYLIST[keyword];
  if (denylist?.some(phrase => loweredText.includes(phrase))) return false;
  return true;
}

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
  body_clean: string | null;
  created_at: string;
  visibility: string | null;
}

/**
 * Build the grader system prompt. Includes the static rubric + any
 * approved grader_prompts (calibration rules learned from admin overrides).
 */
export async function buildGraderSystemPrompt(admin: Admin, workspaceId: string): Promise<string> {
  const [{ data: rules }, { data: policies }] = await Promise.all([
    admin.from("grader_prompts")
      .select("title, content")
      .eq("workspace_id", workspaceId)
      .eq("status", "approved")
      .order("sort_order", { ascending: true }),
    // Active policies — the grader needs these to judge "Rule Compliance"
    // accurately. Without them it might penalize the AI for correctly
    // denying an out-of-policy refund (e.g. a renewal-regret case where
    // policy says "no refund, cancel/pause/skip future only").
    admin.from("policies")
      .select("slug, name, internal_summary")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .is("superseded_by", null)
      .order("slug"),
  ]);

  const rulesBlock = (rules || []).length
    ? "\n\nCALIBRATION RULES (apply these — they are admin-approved adjustments to the rubric):\n\n" +
      (rules || []).map(r => `• ${r.title}\n  ${r.content}`).join("\n\n")
    : "";

  const policyBlock = (policies || []).length
    ? "\n\nCURRENT POLICIES (the AI's behavior should match these — judge Rule Compliance against them):\n\n" +
      (policies || []).map(p => `## ${p.name} (slug: ${p.slug})\n${p.internal_summary}`).join("\n\n")
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
  inaccuracy, robotic, frustration, missed_opportunity, kb_gap, broken_action, false_promise, drift, rule_violation${rulesBlock}${policyBlock}

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
export function formatMessagesForGrading(msgs: MessageRow[]): string {
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
  analysis_id?: string;
  cost_cents?: number;
  ai_message_count?: number;
}

/**
 * Everything the box's ticket-analyze lane needs to run one grader turn — precomputed on the
 * feeder side (skip gates, window resolution, msg pull, guidance + playbook context, prompt
 * string) so the box session has zero DB judgment to make and can just emit a JSON verdict.
 * See the runTicketAnalyzeJob runner in scripts/builder-worker.ts. Kept as a serializable shape
 * on purpose — the runner rebuilds it from ticket_id via prepareAnalyzerRun, never over the
 * wire; this interface is the returned handle it hands to applyAnalyzerVerdict.
 */
export interface PreparedAnalyzerRun {
  workspaceId: string;
  ticketId: string;
  trigger: AnalyzeTrigger;
  windowStart: string;
  windowEnd: string;
  msgs: MessageRow[];
  guidanceBlock: string;
  aiMessageCount: number;
  customerId: string | null;
  /** The grader system prompt (rubric + calibration rules + policies), built at prep time. */
  system: string;
  /** The formatted user turn (conversation + guidance + playbook context + window banner). */
  userMsg: string;
}

export type AnalyzeTrigger = "auto_close" | "manual_close" | "reopen_close" | "manual";

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

  // Load playbook + its full step sequence + stand-firm cadence config. The
  // grader needs ALL of this to correctly judge a mid-flow snapshot: it has
  // to know what step the AI just executed (and what that step is documented
  // to do), what steps come after, and how many stand-firm rounds are
  // expected before exceptions are offered. Without this the grader
  // penalizes correct behavior at apply_policy / stand_firm steps as
  // "didn't address the customer's ask."
  //
  // Previously this used a static dictionary of hand-written hints that
  // drifted as the playbooks evolved (the pb:refund hint described a flow
  // that no longer existed and made the grader miss real failures while
  // dinging correct executions of the new flow). Now we read from the DB.
  const [{ data: playbook }, { data: allSteps }] = await Promise.all([
    admin.from("playbooks")
      .select("name, exception_limit, stand_firm_max, stand_firm_before_exceptions, stand_firm_between_tiers")
      .eq("id", ticket.active_playbook_id)
      .maybeSingle(),
    admin.from("playbook_steps")
      .select("step_order, type, name, instructions")
      .eq("playbook_id", ticket.active_playbook_id)
      .order("step_order"),
  ]);
  if (!playbook) return null;

  const tags = (ticket.tags as string[]) || [];
  const pbTag = tags.find(t => t.startsWith("pb:")) || `pb:${(playbook.name || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  const currentStep = ticket.playbook_step ?? 0;
  const steps = (allSteps || []) as { step_order: number; type: string; name: string; instructions: string | null }[];
  const stepHere = steps.find(s => s.step_order === currentStep);

  // Render the full step sequence so the grader sees where we are in the
  // flow — what's done, what's next.
  const stepLines = steps.map(s => {
    const marker = s.step_order < currentStep ? "✓ done"
      : s.step_order === currentStep ? "▶ CURRENT"
      : "○ pending";
    return `  ${s.step_order}. ${s.name} (${s.type}) — ${marker}`;
  }).join("\n");

  // Cadence breakdown — critical for grading offer_exception / stand_firm
  // steps correctly. The Refund playbook is configured with
  // stand_firm_before_exceptions=2, which means the AI MUST deny twice
  // before offering Tier 1. Penalizing the AI for "not offering an
  // exception yet" at this point is the inverse of correct grading.
  const cadenceLines = [
    `  • exception_limit: ${playbook.exception_limit ?? "n/a"}`,
    `  • stand_firm_max: ${playbook.stand_firm_max ?? "n/a"}`,
    `  • stand_firm_before_exceptions: ${playbook.stand_firm_before_exceptions ?? "n/a"} (deny policy this many times before offering Tier 1 exception)`,
    `  • stand_firm_between_tiers: ${playbook.stand_firm_between_tiers ?? "n/a"} (deny this many times between offering Tier 1 and Tier 2)`,
  ].join("\n");

  // Per-step grading guidance. Each step type has documented "what the AI
  // is supposed to do here" — grading should match the step's intent, not
  // an idealized "resolve the customer's ultimate ask in one turn" framing.
  const stepGuidance: Record<string, string> = {
    identify_order: "AI's job at this step is to identify which order the customer is referencing. Asking for an order number or confirming one is correct behavior. Not offering a refund yet is correct.",
    identify_subscription: "AI is gathering subscription context. Stating subscription facts ('created X, renewed N times') is correct. Not yet engaging the refund ask is correct.",
    check_other_subscriptions: "AI is proactively naming other active subscriptions so the customer isn't surprised later. Not engaging refund yet is correct.",
    apply_policy: "AI is explaining the policy outcome ('this order does/does not qualify, here's why'). It is documented to NOT hint at exceptions or alternatives at this step — that comes after stand-firm rounds. Penalizing 'didn't offer a refund' here is incorrect grading.",
    offer_exception: "AI is offering a Tier 1 (store credit) or Tier 2 (cash refund) exception, framed as a special approval. This is only reached after stand_firm_before_exceptions rounds of policy denial.",
    initiate_return: "AI is creating the return after customer accepted an exception offer. Should produce a label, set expectations on refund timing.",
    cancel_subscription: "AI is confirming subscription cancellation. Should NOT re-open negotiation or offer additional alternatives at this point.",
    stand_firm: "AI is restating the current position (policy or current offer) without escalating. NEVER hinting at future options is correct behavior. Penalizing 'didn't offer anything new' is incorrect.",
  };

  const stepHint = stepHere
    ? `\nCURRENT STEP DETAIL (${stepHere.type} — "${stepHere.name}"):\n${stepGuidance[stepHere.type] || "(no specific guidance for this step type)"}\nDocumented instructions: ${(stepHere.instructions || "").slice(0, 400)}`
    : "";

  // Context state from the playbook execution
  const ctx = (ticket.playbook_context || {}) as Record<string, unknown>;
  const stateLines: string[] = [];
  if (ctx.paused_for_cancel) stateLines.push("- Currently waiting for customer to complete the cancel journey");
  if (ctx.paused_for_pause_confirmation) stateLines.push("- Currently waiting for customer to confirm whether to keep their subscription paused");
  if (ctx.cancel_journey_completed) stateLines.push("- Cancel journey already completed");
  if (ctx.cancel_handled) stateLines.push("- Cancel/save step already resolved");
  if (ctx.exception_offered) stateLines.push(`- Exception offer already made: ${ctx.exception_offered} (${ctx.resolution_type || "?"})`);
  if (ctx.offer_accepted) stateLines.push("- Customer accepted the exception offer; return is being processed");
  if (ctx.exception_stand_firm_count != null) stateLines.push(`- Stand-firm rounds completed at current tier: ${ctx.exception_stand_firm_count}`);
  if (ctx.current_exception_tier != null) stateLines.push(`- Current exception tier: ${ctx.current_exception_tier}`);
  if (ctx.exception_exhausted) stateLines.push("- All exception tiers exhausted; only stand-firm remains");

  return [
    `Active playbook: ${playbook.name} (${pbTag}). The ticket is MID-FLOW — grade the AI's response against the documented behavior of its current step, NOT against an idealized "resolve everything in one turn" framing.`,
    `\nStep sequence:\n${stepLines}`,
    `\nCadence config:\n${cadenceLines}`,
    stepHint,
    stateLines.length ? `\nCurrent playbook state:\n${stateLines.join("\n")}` : "",
    `\nGRADING RULE: at the current step, if the AI executed the documented behavior — even if that means not yet addressing the customer's ultimate ask (e.g., not offering a refund at apply_policy) — score it normally. Only penalize when the AI deviated from the step's documented behavior (e.g., offered an exception too early, made up a refund amount, closed the ticket mid-flow, etc.).`,
  ].filter(Boolean).join("\n");
}

/**
 * Public entry for callers that want to trigger a grade on a specific ticket — the analyzer no
 * longer runs Anthropic in-process (Phase 1 of ticket-analyzer-becomes-box-agent-under-june).
 * It enqueues a `ticket-analyze` agent_jobs row that the box (scripts/builder-worker.ts →
 * runTicketAnalyzeJob) picks up as a supervised session under 💬 June (CS Director) on Max, and
 * that session's parsed verdict runs through applyAnalyzerVerdict on the box, which does the
 * deterministic insert + severity actions. The one loop_heartbeats beat this feeder emits
 * (`ai:ticket-analyzer` in the Control Tower registry) still reports the enqueue result — the
 * ACTUAL grade runs on `agent:ticket-analyze` (an agent-kind loop with its own liveness).
 *
 * Returns ok:false with a `reason` for every non-enqueue outcome (skip / already-in-flight /
 * missing_ticket / enqueue_failed) so the cron's stamp-on-slip behavior (mark last_analyzed_at
 * so we don't re-check the same row every 30 min) still works. The rescore action in
 * improve-plan-executor.ts already handles a scoreless result string ("Re-analysis triggered").
 */
export async function analyzeTicket(
  ticketId: string,
  trigger: AnalyzeTrigger = "auto_close",
): Promise<AnalyzeResult> {
  const startedAt = Date.now();
  let result: AnalyzeResult | null = null;
  let threw: unknown = null;
  try {
    result = await enqueueTicketAnalyzeJob(ticketId, trigger);
    return result;
  } catch (e) {
    threw = e;
    throw e;
  } finally {
    // The FEEDER beat: it reports whether the enqueue itself worked, not whether the grade
    // succeeded (that beats on `agent:ticket-analyze` when the box runs it). ok:false only
    // on an actual enqueue failure (thrown exception / enqueue_failed reason).
    const isError = !!threw || (!!result && !result.ok && (result.reason || "").startsWith("enqueue_failed"));
    const produced = threw
      ? { error: "exception" }
      : result && result.ok
      ? { queued: true }
      : { skipped: result?.reason ?? "unknown" };
    await emitInlineAgentHeartbeat(INLINE_AGENT_IDS.ticketAnalyzer, {
      ok: !isError,
      produced,
      detail: threw ? `threw: ${threw instanceof Error ? threw.message : String(threw)}` : result?.reason ?? undefined,
      durationMs: Date.now() - startedAt,
    });
  }
}

/**
 * Enqueue a `ticket-analyze` box job for this ticket — deduped on an already-in-flight row for
 * the SAME ticket (queued/queued_resume/claimed/building/needs_input) so the cron re-selecting
 * the same ticket while a prior grade is still in flight doesn't stack duplicate work.
 * Returns ok:false for the dedup miss so callers stamp `last_analyzed_at` and move on.
 *
 * Exported so tests + the cron can enqueue directly without going through analyzeTicket (the
 * feeder heartbeat + wrapper only matters for the manual/rescore path).
 */
export async function enqueueTicketAnalyzeJob(
  ticketId: string,
  trigger: AnalyzeTrigger,
): Promise<AnalyzeResult> {
  const admin = createAdminClient();
  // Resolve the ticket's workspace first — the agent_jobs row is workspace-scoped, so the
  // ownerFunctionForKind('ticket-analyze')='cs' resolution + the box lane's per-workspace claim
  // can pick it up. A missing ticket → skip (the same shape the prior gate emitted, so the
  // cron's stamp-on-slip path still lands on it).
  const { data: t } = await admin
    .from("tickets")
    .select("id, workspace_id, do_not_reply, ai_disabled, analyzer_locked, merged_into, tags")
    .eq("id", ticketId)
    .maybeSingle();
  if (!t) return { ok: false, reason: "ticket_not_found" };

  // Early skip gates — mirror the box's prepareAnalyzerRun gates so we never spend an enqueue on
  // a ticket the runner would just refuse. The runner re-checks these (compare-and-set against
  // the current row) so a race between enqueue and grade still fail-safes there.
  if (t.merged_into) return { ok: false, reason: "merged_into_other" };
  if ((t as { ai_disabled?: boolean }).ai_disabled) return { ok: false, reason: "ai_disabled" };
  if ((t as { analyzer_locked?: boolean }).analyzer_locked) return { ok: false, reason: "analyzer_locked" };
  if (t.do_not_reply) return { ok: false, reason: "do_not_reply" };
  const tags = (t.tags as string[]) || [];
  if (tags.some((tag) => SKIP_TAGS.has(tag))) return { ok: false, reason: "skip_tag" };

  // One-in-flight dedup — same shape enqueueSpecReviewIfDue uses. spec_slug carries the ticket
  // id so the box's per-slug queue view surfaces one row per ticket.
  const { data: inflight } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", t.workspace_id)
    .eq("kind", "ticket-analyze")
    .eq("spec_slug", ticketId)
    .in("status", ["queued", "queued_resume", "claimed", "building", "needs_input"])
    .limit(1);
  if (inflight && inflight.length) return { ok: false, reason: "already_in_flight" };

  const { error } = await admin.from("agent_jobs").insert({
    workspace_id: t.workspace_id,
    spec_slug: ticketId,
    kind: "ticket-analyze",
    status: "queued",
    instructions: JSON.stringify({ ticket_id: ticketId, trigger }),
    created_by: null,
  });
  if (error) return { ok: false, reason: `enqueue_failed: ${error.message}` };
  return { ok: true };
}

/**
 * Feeder-side gates + context build for the box's ticket-analyze runner. Returns { ok:false,
 * reason } for every skip (do_not_reply / ai_disabled / analyzer_locked / merged / skip_tag /
 * no_messages / no_ai_messages / ticket_not_found) — same reason strings the prior
 * analyzeTicketInner emitted, so the cron's stamp-on-slip behavior is unchanged. On ok:true the
 * `prepared` bundle carries the exact prompt + system + windowed messages the box session runs
 * against and applyAnalyzerVerdict consumes.
 *
 * This is the pure prep step — no Anthropic call, no side effects, no writes. The runner in
 * scripts/builder-worker.ts calls this, hands `prepared.userMsg` + `prepared.system` to a Max
 * `claude -p` session, then routes the parsed JSON verdict + prepared bundle into
 * applyAnalyzerVerdict for the ticket_analyses insert + severity actions.
 */
export async function prepareAnalyzerRun(
  ticketId: string,
  trigger: AnalyzeTrigger = "auto_close",
): Promise<{ ok: false; reason: string } | { ok: true; prepared: PreparedAnalyzerRun }> {
  const admin = createAdminClient();

  const { data: ticket } = await admin.from("tickets")
    .select("id, workspace_id, status, channel, tags, ai_turn_count, escalation_reason, last_analyzed_at, created_at, customer_id, active_playbook_id, playbook_step, playbook_context, do_not_reply, merged_into, ai_disabled, analyzer_locked")
    .eq("id", ticketId).maybeSingle();
  if (!ticket) return { ok: false, reason: "ticket_not_found" };

  // Skip merged-source stubs — the conversation lives on the target
  // ticket now. Grading the stub would either repeat work or judge an
  // empty shell. The target gets analyzed on its own close cycle.
  if (ticket.merged_into) {
    return { ok: false, reason: "merged_into_other" };
  }

  // Human directive — AI disabled on this ticket. Skip analysis AND
  // escalation. Same reason as do_not_reply below: grading an absent
  // reply always scores poorly and would re-escalate, which is the
  // opposite of what the human directive asked for.
  if ((ticket as unknown as { ai_disabled?: boolean }).ai_disabled) {
    return { ok: false, reason: "ai_disabled" };
  }

  // Human veto — analyzer_locked. The cron's find-tickets already
  // excludes these at the source, but a race is possible: a human
  // toggles the lock AFTER the tick's SELECT ran. Bail here too so the
  // caller's skip branch stamps last_analyzed_at and a later
  // updated_at bump can't re-select the row (Phase 2 of
  // human-directives-hard-gates-over-ticket-ai).
  if ((ticket as unknown as { analyzer_locked?: boolean }).analyzer_locked) {
    return { ok: false, reason: "analyzer_locked" };
  }

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
    .select("direction, author_type, body, body_clean, visibility, created_at")
    .eq("ticket_id", ticketId)
    .gte("created_at", windowStart)
    .lte("created_at", windowEnd)
    .order("created_at", { ascending: true });

  // Agent-pinned AI guidance — always pulled regardless of window so
  // a guidance note pinned long before the analysis window still
  // governs the grader's expectations (e.g. "stand firm on this
  // policy — do not escalate even if customer pushes back").
  const { data: guidanceRaw } = await admin.from("ticket_messages")
    .select("body, body_clean, created_at")
    .eq("ticket_id", ticketId)
    .eq("is_ai_guidance", true)
    .order("created_at", { ascending: true });
  const guidanceBlock = (guidanceRaw || [])
    .map((g: { body?: string; body_clean?: string }) =>
      `- ${((g.body_clean || g.body || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2000))}`,
    )
    .filter((s) => s.length > 2)
    .join("\n");

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

  const userMsg = `Grade this conversation window. The window covers ${windowStart} → ${windowEnd}.${guidanceBlock ? `\n\n--- AGENT GUIDANCE (binding directives from a human agent for this ticket — the AI was expected to follow these; grade with these as the ground truth, not your default judgment) ---\n${guidanceBlock}` : ""}${playbookContext ? `\n\n--- PLAYBOOK CONTEXT ---\n${playbookContext}` : ""}\n\n--- CONVERSATION ---\n${conversation}\n\nReturn the JSON only.`;

  return {
    ok: true,
    prepared: {
      workspaceId: ticket.workspace_id,
      ticketId,
      trigger,
      windowStart,
      windowEnd,
      msgs,
      guidanceBlock,
      aiMessageCount,
      customerId: ticket.customer_id,
      system,
      userMsg,
    },
  };
}

/**
 * Optional token-usage snapshot from the box lane's Max session (so the ticket_analyses row +
 * ai_token_usage row still carry input/output token counts + a per-ticket cost estimate). The
 * flat-rate box lane already meters at the fleet level via meterAgentJob; the per-ticket copy
 * here keeps the historical analytics shape and per-ticket cost line still queryable.
 */
export interface AnalyzerBoxRunUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  model?: string | null;
}

/**
 * Deterministic apply step for the box's ticket-analyze runner — post-grader cancel-claim
 * detection, cap-and-annotate on hits, insert the ticket_analyses row, bump
 * tickets.last_analyzed_at, and route through applySeverityActions (which still owns
 * do_not_reply / ai_disabled / analyzer_locked / agent_intervened / active_playbook_id
 * force-suppress gates via compare-and-set against the current row). Called on the box after
 * the Max session returns a parsed AnalysisResult; kept in this file so the ONE place that
 * knows how to insert a ticket_analyses row + fire severity actions stays authoritative.
 */
export async function applyAnalyzerVerdict(
  prepared: PreparedAnalyzerRun,
  analysis: AnalysisResult,
  usage?: AnalyzerBoxRunUsage | null,
): Promise<{ ok: true; analysis: AnalysisResult; analysis_id: string | undefined; cost_cents: number; ai_message_count: number }> {
  const admin = createAdminClient();

  // ── Deterministic post-grader checks ──
  // The AI grader sees the conversation transcript but can't query the DB. Some failures are
  // only visible if you cross-reference what the AI claimed in the thread against current
  // state. Run those here and inject findings into `analysis.issues` + cap the score so
  // severity routing catches them.
  const cancelCheck = await detectUnfulfilledCancelClaim(admin, prepared.ticketId, prepared.customerId, prepared.msgs);
  if (cancelCheck) {
    analysis.issues = [cancelCheck, ...(analysis.issues || [])];
    analysis.score = Math.min(analysis.score, 3); // catastrophic — broken cancel promise
    if (analysis.summary && !/cancel/i.test(analysis.summary)) {
      analysis.summary = `Cancel journey reported success but subscription remains active. ${analysis.summary}`;
    } else if (!analysis.summary) {
      analysis.summary = "Cancel journey reported success but subscription remains active — agent must manually cancel.";
    }
  }

  // Per-ticket cost snapshot — the box lane's Max session is flat-rate, but the historical
  // per-ticket cost line + ai_token_usage row shape stays intact. Use the box's actual run
  // model when known (usage.model) so ticket_analyses.model reflects reality; fall back to the
  // canonical GRADER_MODEL constant. usageCostCents is only queried when we have tokens to bill.
  const model = usage?.model ?? GRADER_MODEL;
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const costCents = inputTokens || outputTokens
    ? usageCostCents(model, {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_tokens: usage?.cache_creation_tokens ?? 0,
        cache_read_tokens: usage?.cache_read_tokens ?? 0,
      })
    : 0;

  await logAiUsage({
    workspaceId: prepared.workspaceId,
    model,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: usage?.cache_creation_tokens ?? 0,
      cache_read_input_tokens: usage?.cache_read_tokens ?? 0,
    },
    purpose: "ticket_analysis",
    ticketId: prepared.ticketId,
  });

  // Insert the analysis row
  const { data: inserted } = await admin.from("ticket_analyses").insert({
    workspace_id: prepared.workspaceId,
    ticket_id: prepared.ticketId,
    window_start: prepared.windowStart,
    window_end: prepared.windowEnd,
    score: analysis.score,
    issues: analysis.issues || [],
    action_items: analysis.action_items || [],
    summary: analysis.summary || null,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_cents: costCents,
    trigger: prepared.trigger,
    ai_message_count: prepared.aiMessageCount,
  }).select("id").single();

  // Update ticket.last_analyzed_at
  await admin.from("tickets")
    .update({ last_analyzed_at: prepared.windowEnd })
    .eq("id", prepared.ticketId);

  // Severity actions — pass guidanceBlock so an explicit human "do not escalate" directive can
  // HARD-SUPPRESS force-escalation, even when a severe-issue type or a customer-threat keyword
  // is present. Phase 3 of docs/brain/specs/human-directives-hard-gates-over-ticket-ai.md.
  await applySeverityActions(
    admin,
    prepared.ticketId,
    prepared.workspaceId,
    prepared.customerId,
    analysis,
    prepared.msgs,
    prepared.guidanceBlock,
    inserted?.id,
  );

  return {
    ok: true,
    analysis,
    analysis_id: inserted?.id ?? undefined,
    cost_cents: costCents,
    ai_message_count: prepared.aiMessageCount,
  };
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
 *
 * Exception (ticket 9a6e53d9): when the ONLY severe trigger is 'inaccuracy'
 * (no false_promise / broken_action), there's no customer threat, the score
 * is ≥7, and the ticket is cleanly positively closed, the inaccuracy
 * force-escalate is suppressed and logged as a non-actionable note instead.
 */
// Detect an explicit no-escalate directive in the agent-pinned guidance
// block. Phase 3 of docs/brain/specs/human-directives-hard-gates-over-ticket-ai.md
// — a directive from a real human BEATS the severe-issue / customer-threat
// force-escalate overrides. Deliberately strict: this must ONLY match a
// clear operator command like "do not escalate" / "no reopen" / "don't
// re-open this" — not a customer's threat text quoted into a note, and
// not a passing mention like "the customer asked us not to escalate". A
// false positive here would silently suppress a real severe-issue reopen.
const NO_ESCALATE_DIRECTIVE = /\b(?:don'?t|do\s+not|never|no)\s+(?:re[-\s]?)?(?:escalat\w*|open\w*|reopen\w*)\b/i;
function guidanceHasNoEscalateDirective(guidanceBlock: string): boolean {
  if (!guidanceBlock) return false;
  return NO_ESCALATE_DIRECTIVE.test(guidanceBlock);
}

async function applySeverityActions(
  admin: Admin,
  ticketId: string,
  workspaceId: string,
  customerId: string | null,
  analysis: AnalysisResult,
  msgs: MessageRow[],
  guidanceBlock: string,
  analysisId?: string,
): Promise<void> {
  const score = analysis.score;
  const issues = analysis.issues || [];

  // ── Human veto: analyzer_locked ──
  // Checked BEFORE the forceEscalate math (below) so a severe-issue
  // type or a customer-threat keyword can't punch through the veto.
  // Compare-and-set against a fresh row read — a human may have
  // toggled the lock AFTER analyzeTicketInner's initial select. On hit
  // we log a non-actionable audit note and return; NO tickets update,
  // NO reopen, NO escalate. Phase 2 of
  // human-directives-hard-gates-over-ticket-ai. Companion: the cron's
  // find-tickets .eq("analyzer_locked", false) filter.
  const { data: lockCheck } = await admin.from("tickets")
    .select("analyzer_locked")
    .eq("id", ticketId).maybeSingle();
  if ((lockCheck as unknown as { analyzer_locked?: boolean } | null)?.analyzer_locked) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[Auto-Analysis] Score ${score}/10 — analyzer is LOCKED on this ticket by human directive; skipping any reopen/escalate (severe-type + customer-threat overrides all suppressed). ${analysisId ? `Analysis ${analysisId}.` : ""}`,
    });
    return;
  }

  const severeTypes = new Set(issues.map(i => i.type).filter(t => SEVERE_ISSUE_TYPES.has(t)));
  const hasSevereIssue = severeTypes.size > 0;
  const customerThreat = msgs.some(m => {
    if (m.direction !== "inbound") return false;
    // Scan the CLEANED body, not the raw one. Inbound email replies quote
    // the message they're replying to — including our own order-confirmation
    // footer ("Join our Facebook group!"), whose "facebook" substring-matched
    // a threat keyword and force-escalated a positively-closed ticket
    // (Melissa Sachs, ticket 246163b4, score 9). body_clean already strips
    // quoted history + signatures; fall back to live-cleaning for rows /
    // channels without it.
    const txt = (m.body_clean || cleanEmailBody(m.body || "")).toLowerCase();
    return CUSTOMER_ESCALATION_KEYWORDS.some(k => matchesEscalationKeyword(txt, k));
  });

  // ── Inaccuracy-only positive-close override (ticket 9a6e53d9) ──
  // A grader can tag a harmless closing phrase (e.g. "your loyalty points
  // stay intact") as an 'inaccuracy' even on a 7+ ticket the customer closed
  // happily. The rubric already caps REAL factual errors at score ≤5, so an
  // inaccuracy-typed issue surviving on a ≥7, cleanly-positively-closed
  // ticket is cosmetic phrasing — re-opening + escalating it to a human is
  // the same churn the customerThreat path already avoids (Melissa Sachs
  // 246163b4). Suppress the force-escalate ONLY when the inaccuracy type is
  // the SOLE severe trigger. false_promise / broken_action still escalate
  // exactly as before (no heal-verification gating — verify_refund_issued is
  // an unimplemented future recipe, so gating those would be a silent-drop
  // hole). customerThreat still always escalates.
  const onlyInaccuracySevere =
    severeTypes.has("inaccuracy") &&
    !severeTypes.has("false_promise") &&
    !severeTypes.has("broken_action");
  let suppressInaccuracyEscalation = false;
  if (hasSevereIssue && onlyInaccuracySevere && !customerThreat && score >= 7) {
    suppressInaccuracyEscalation = await hasCleanPositiveClose(admin, ticketId);
  }

  // ── Human directive beats the overrides ──
  // A pinned agent guidance note containing an explicit "do not escalate"
  // instruction hard-suppresses the force-escalate path, even when a
  // severe-issue type or customer-threat keyword is present. Directives
  // from a real human are the ground truth; the overrides exist to catch
  // failures no one has weighed in on yet. Once someone HAS weighed in,
  // their call wins. Audit-note the suppression so the trail is
  // reviewable. Phase 3 of human-directives-hard-gates-over-ticket-ai.
  const directiveSuppressesEscalation =
    guidanceHasNoEscalateDirective(guidanceBlock) && (hasSevereIssue || customerThreat);
  if (directiveSuppressesEscalation) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[Auto-Analysis] Score ${score}/10 — a pinned agent guidance directive says "do not escalate"; force-escalate suppressed (would have fired from ${hasSevereIssue ? `severe-issue: ${[...severeTypes].join(", ")}` : ""}${hasSevereIssue && customerThreat ? " + " : ""}${customerThreat ? "customer-threat keyword" : ""}). Directive beats the override. ${analysisId ? `Analysis ${analysisId}.` : ""}`,
    });
  }

  const forceEscalate =
    !directiveSuppressesEscalation &&
    ((hasSevereIssue && !suppressInaccuracyEscalation) || customerThreat);

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

  // ── Research & Heal hook ──
  // Severe issues (false_promise / broken_action) are the prime case for
  // auto-recovery. Fire a research request to verify what's broken; if a
  // recipe finds a healable gap, the admin can one-click heal from the
  // ticket detail page (Phase 1) or it auto-heals from the allowlist
  // (Phase 2). Recipes are inferred from the issue types. Safe to fire
  // regardless of escalation action — research+heal is non-destructive
  // until the heal step explicitly runs.
  const recipesToRun = selectResearchRecipes(issues);
  if (recipesToRun.length > 0) {
    try {
      const { inngest } = await import("@/lib/inngest/client");
      await inngest.send({
        name: "ticket/research.requested",
        data: {
          ticket_id: ticketId,
          recipes: recipesToRun.map(slug => ({ slug })),
          source_analysis_id: analysisId,
          triggered_by: "ai_analysis",
        },
      });
    } catch (err) {
      console.warn("[ticket-analyzer] research.requested send failed:", err);
    }
  }

  // Log a non-actionable note when we suppressed the inaccuracy-only
  // force-escalate, so the decision is auditable. Worded so it can NEVER be
  // mistaken for a re-open note (no REOPEN_NOTE_MARKERS) or a positive-close
  // note (no POSITIVE_CLOSE_NOTE) by a later hasCleanPositiveClose() scan.
  if (suppressInaccuracyEscalation) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[Auto-Analysis] Score ${score}/10 — an 'inaccuracy'-typed issue would normally force-escalate, but skipped: it was the only severe-issue trigger (no false_promise/broken_action), the score is ≥7, and the ticket is cleanly positively closed. Not re-opening a happy, well-resolved ticket over cosmetic phrasing. Regression guard for ticket 9a6e53d9. ${analysisId ? `Analysis ${analysisId}.` : ""}`,
    });
  }

  if (action === "none") return;

  // ── Respect human-agent closure ──
  // If a human agent already handled this ticket (agent_intervened) or
  // an agent manually closed/resolved it after their review, the
  // analyzer should NOT re-open. The agent's review is the source of
  // truth — auto-reopening overrides their judgment, frustrates them,
  // and creates churn (close → analyze → reopen → close again loop).
  const { data: tBefore } = await admin.from("tickets")
    .select("agent_intervened, status, closed_at, resolved_at, active_playbook_id, playbook_step, ai_disabled")
    .eq("id", ticketId).single();
  // Re-check ai_disabled here — a human may have toggled it AFTER the
  // analyzeTicketInner() row-read. Same hard rule as the early guard:
  // an explicit human "off" beats any severe-issue / threat-keyword
  // force-escalate below. Compare-and-set against the current row.
  if ((tBefore as unknown as { ai_disabled?: boolean } | null)?.ai_disabled) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[Auto-Analysis] Score ${score}/10 — would have ${action === "escalate_with_message" ? "re-opened + escalated" : "re-opened silently"}, but skipped because AI is disabled on this ticket by human directive. ${analysisId ? `Analysis ${analysisId}.` : ""}`,
    });
    return;
  }
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

  // ── Respect in-flight playbooks ──
  // A playbook running its stand-firm / exception tiers is BY DESIGN
  // terse, policy-anchored, and intentionally doesn't address every
  // tangential claim the customer raises. The grader, evaluating each
  // message on its own merits, will score these in the 5-6 range and
  // try to escalate (see Jennifer e4ac25cd: refund playbook at tier 0
  // pre-exception stand-firm, scored 6 for "didn't address customer's
  // notification claim"). That's the playbook working correctly, not
  // an AI failure — so unless we hit a severe issue type or customer
  // threat language (which we always escalate regardless), let the
  // playbook continue and log the analysis as a non-actionable note.
  if (tBefore?.active_playbook_id && !hasSevereIssue && !customerThreat) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[Auto-Analysis] Score ${score}/10 — would have ${action === "escalate_with_message" ? "re-opened + escalated" : "re-opened silently"}, but skipped because a playbook is actively handling this ticket (step ${tBefore.playbook_step ?? "?"}). The playbook's stand-firm/exception path is the expected behavior. ${analysisId ? `Analysis ${analysisId}.` : ""}`,
    });
    return;
  }

  // Re-open + escalate
  const escReason = forceEscalate
    ? `Auto-flag: ${hasSevereIssue ? "severe issue type" : "customer threat language"} (score ${score})`
    : `Low quality score: ${score}/10 — ${(analysis.summary || "see issues").slice(0, 200)}`;

  // Escalate to the AI Routine (escalated_at set + escalated_to = null). The
  // idle-triage cron picks it up next tick (solver→skeptic→quorum); its
  // no-quorum path is what hands up to a real human. We deliberately don't
  // round-robin to a person or pre-assign assigned_to here.
  await admin.from("tickets").update({
    status: "open",
    escalated_to: null,
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
