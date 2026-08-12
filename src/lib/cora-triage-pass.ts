/**
 * Cora cheap triage pass — the low-cost tier that runs in front of the full `ticket-analyze`
 * box session (💬 June / Cora). On a busy day the analyzer used to spawn ONE Max session per
 * closed ticket; most tickets are handled fine and a full grading session on them tells us
 * nothing new. This is a single inline Haiku call (no box session, no tools) that:
 *
 *   1. writes a LIGHTWEIGHT grade to `ticket_analyses` for every clean ticket (so the CSAT /
 *      score coverage the Sol cost-vs-baseline measurement needs is preserved), and
 *   2. decides `needs_review` — only tickets that trip it spawn the expensive deep session.
 *
 * Layering (locked with the founder): the cheap pass NEVER escalates to June. Its only escalation
 * is to enqueue a Cora deep session; June is reached solely from inside that deep session
 * (`decideEscalationAction` → triage-escalations → cs-director-call). Two hops, never one.
 *
 * It runs on the SAME candidate set as the deep analyzer — closed + Sol-handled + settled ≥30 min,
 * gated by the same guards in [[ticket-analyzer]] `enqueueTicketAnalyzeJob` (it's called from
 * there, after those guards + the in-flight dedup pass, on the `auto_close` trigger only; a
 * `manual` rescore always forces the deep grade).
 *
 * TERMINAL-STATE PRINCIPLE (same as `hasResolvedActionClose` in [[ticket-analyzer]]): the pass
 * flags only END-state problems — a customer left unresolved/frustrated, a promise made and not
 * kept, an out-of-policy remedy offered, a false claim of an outcome. A messy-but-recovered middle
 * (a turn-1 stumble the agent later fixed) is NOT a trip; escalation keys on whether we got it
 * wrong at the END, not mid-turn. The gate is RECALL-biased — an unparseable / low-confidence
 * result fails OPEN to a deep review, never silently clears.
 *
 * See [[../lifecycles/ai-analysis]] and the deep grader in [[ticket-analyzer]].
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { HAIKU_MODEL } from "@/lib/ai-models";
import { cleanEmailBody } from "@/lib/email-cleaner";
import { insertAnalysis } from "@/lib/ticket-analyses-table";
import { normalizeMessyTurnSignals, recordSolMessyTurns } from "@/lib/sol-coaching-signal";

type Admin = ReturnType<typeof createAdminClient>;

/** The terminal-state failure modes the cheap pass may flag. A recovered mid-journey stumble is
 *  deliberately NOT here — that's coaching signal for the rollup, not an escalation trip. */
export const TRIAGE_SIGNALS = [
  "customer_unresolved",      // customer's ask was not resolved by the end
  "customer_frustrated_end",  // customer is angry/dissatisfied in their LAST message
  "unkept_promise",           // AI promised an outcome that was not delivered
  "out_of_policy_offer",      // AI offered/promised a remedy policy disallows
  "false_outcome_claim",      // AI claimed an action happened that did not
  "wrong_outcome",            // the resolution shipped was the wrong one
] as const;

export interface TriageResult {
  /** True → spawn a Cora deep session. Recall-biased: unsure/unparseable → true. */
  needsReview: boolean;
  /** Terminal-state failure-mode tags (subset of TRIAGE_SIGNALS, plus "parse_error" on fallback). */
  signals: string[];
  /**
   * MESSY-MIDDLE (recovered) patterns — a subset of [[sol-coaching-signal]] `SOL_MESSY_TURN_SIGNALS`.
   * These describe stumbles that were RECOVERED by the end (so they never drive escalation); they feed
   * June's coaching aggregation via `recordSolMessyTurns` on the clean-close path. Distinct from
   * `signals` (terminal failures that DO escalate).
   */
  coachingSignals: string[];
  /** Coarse 1–10 grade for measurement continuity (the deep session refines it when it runs). */
  score: number;
  /** One-line human-readable rationale. */
  summary: string;
}

export interface TriageRun {
  triage: TriageResult;
  windowStart: string;
  windowEnd: string;
  aiMessageCount: number;
  inputTokens: number;
  outputTokens: number;
}

const MAX_TRANSCRIPT_MESSAGES = 40;

/**
 * Build the (system, user) prompt for the triage classifier. Pure + deterministic so the prompt
 * shape is unit-tested without an Anthropic call. `transcript` is the pre-rendered conversation.
 */
export function buildTriagePrompt(transcript: string): { system: string; user: string } {
  const system = [
    "You are Cora's fast triage classifier for a customer-support conversation that has already CLOSED.",
    "Your ONLY job: decide whether this ticket needs a deeper human-style review, and give a coarse quality score.",
    "",
    "The transcript may open with a SUBJECT: line — the email subject. Treat it as part of the customer's",
    "request: email customers often put the ENTIRE ask in the subject ('PLEASE Cancel my Subscription!!!')",
    "and leave a footer-only body. An AI reply that correctly addresses the SUBJECT is CORRECT even if the",
    "body itself had no request — do NOT score it low as a non-sequitur.",
    "",
    "Judge the TERMINAL STATE — how the ticket ENDED — not the messy middle. Support is a process:",
    "customers describe things messily and agents legitimately state a reasonable-but-wrong interim",
    "position, then correct as facts arrive. A stumble on turn 1 that was RECOVERED by the end is NOT",
    "a problem — do not flag it. Only flag when the ENDING itself is wrong.",
    "",
    "Set needs_review = true ONLY for a terminal-state problem:",
    "- customer_unresolved: the customer's actual ask was not resolved by the end",
    "- customer_frustrated_end: the customer is clearly angry/dissatisfied in their LAST message",
    "- unkept_promise: the AI promised an outcome (refund, label, callback) that was never delivered",
    "- out_of_policy_offer: the AI offered/promised a remedy the policy disallows",
    "- false_outcome_claim: the AI claimed an action happened (e.g. 'I've refunded you') that did not",
    "- wrong_outcome: the resolution actually shipped was the wrong one",
    "",
    "If the ticket ended resolved and the customer is not left hanging, needs_review = false even if",
    "the path was bumpy. When you are genuinely UNSURE, set needs_review = true (better to over-review).",
    "",
    "SEPARATELY, note any MESSY-MIDDLE stumbles that were RECOVERED by the end — the ending was fine, but",
    "the path had a fixable slip. These NEVER change needs_review (the customer was fine); they are pure",
    "coaching signal so a recurring Sol gap can be fixed at the source. Use coaching_signals, a subset of:",
    "- contradiction_recovered: stated a wrong/contradictory position, then corrected it",
    "- policy_misstate_recovered: mis-stated a policy mid-turn, then got it right",
    "- slow_resolution: took materially more turns than the ask warranted",
    "- repeated_clarification: re-asked for info the customer had already given",
    "- wrong_tool_recovered: took the wrong action/tool first, then the right one",
    "- tone_miss_recovered: an empathy/tone miss that didn't sink the outcome",
    "Leave coaching_signals empty when the path was clean. A recovered stumble goes ONLY in coaching_signals,",
    "never in signals (signals is exclusively for BAD ENDINGS).",
    "",
    "Reply with ONLY a JSON object, no prose:",
    '{"needs_review": boolean, "signals": string[], "coaching_signals": string[], "score": integer 1-10, "summary": "one sentence"}',
    "signals must be a subset of the six terminal-failure names above (empty array when needs_review is false).",
  ].join("\n");

  const user = `Closed support conversation (oldest → newest):\n\n${transcript}\n\nClassify it.`;
  return { system, user };
}

/**
 * Parse the classifier's raw text into a TriageResult. RECALL-BIASED: any parse failure, missing
 * field, or malformed shape returns needs_review=true with a "parse_error" signal — the pass never
 * silently clears a ticket it couldn't read. Score is clamped to 1–10; an omitted score defaults to
 * a middling 5 (which, with needs_review, routes to the deep session anyway).
 */
export function parseTriageResult(text: string): TriageResult {
  const fallback: TriageResult = {
    needsReview: true,
    signals: ["parse_error"],
    coachingSignals: [],
    score: 5,
    summary: "triage output could not be parsed — failing open to a deep review",
  };
  if (!text) return fallback;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return fallback;
  }
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  if (typeof o.needs_review !== "boolean") return fallback;

  const allowed = new Set<string>([...TRIAGE_SIGNALS]);
  const signals = Array.isArray(o.signals)
    ? o.signals.filter((s): s is string => typeof s === "string" && allowed.has(s))
    : [];
  // coaching_signals are the recovered-mid-turn patterns — normalized against the shared vocab; an
  // unknown tag is dropped, never a parse failure (they don't affect the escalation decision).
  const coachingSignals = normalizeMessyTurnSignals(
    Array.isArray(o.coaching_signals) ? (o.coaching_signals as unknown[]).map(String) : [],
  );
  const scoreNum = typeof o.score === "number" && Number.isFinite(o.score) ? Math.round(o.score) : 5;
  const score = Math.min(10, Math.max(1, scoreNum));
  const summary = typeof o.summary === "string" && o.summary.trim() ? o.summary.trim() : "(no summary)";

  // A needs_review=true with no signals is still a valid trip (the model wasn't sure which bucket);
  // a needs_review=false with terminal signals is contradictory → fail open. coaching_signals never
  // make it contradictory (they are explicitly the "ended fine but messy" case).
  if (o.needs_review === false && signals.length > 0) return fallback;

  return { needsReview: o.needs_review, signals, coachingSignals, score, summary };
}

/**
 * PRE-PURCHASE STILL-BLOCKED override — deterministic terminal-state check the cheap classifier
 * cannot be trusted to run on its own. Ticket 3dd271be (mdengberg2, Mixed Berry 60-day sub) was
 * the recorded failure: the customer's LAST message still said she couldn't buy, the AGENT had
 * looped 3× on cache-clear + invented a "30/60/90 Day Supply card" UI that doesn't exist, and
 * Haiku still returned `needs_review=false, score=9`. This scanner runs on the SAME transcript
 * the classifier sees and forces `needsReview=true` + a `customer_unresolved` signal when both
 * halves hit:
 *   (1) the LAST customer message says they still can't buy / order / check out / select / add,
 *       and
 *   (2) some AGENT message told them to clear cache / try incognito / try a different browser
 *       / hard refresh (the storefront-block loop) — the specific pattern the fast-default
 *       [[assisted-purchase-direction]] `assertSolFastDefaultToConcierge` guard also blocks.
 * On a cheap-pass override, the returned signal is `customer_unresolved` (a known TRIAGE_SIGNALS
 * entry) so the recall-biased gate in `runCheapTriagePass` routes the ticket to the deep session
 * exactly the way any terminal-state trip does.
 *
 * Pure — no DB, no network, safe to unit-test with the same transcript strings the tests build.
 */
export interface PrePurchaseStillBlockedContext {
  msgs: Array<{ direction: string; author_type: string; visibility: string; body: string | null; body_clean: string | null }>;
}

const STILL_BLOCKED_LAST_CUSTOMER_PATTERNS: RegExp[] = [
  /\bstill\s+(?:can(?:'?t|not)|un(?:able|able\s+to))\s+(?:buy|order|check\s*out|complete|select|choose|subscribe|add|pay)\b/i,
  /\bit\s+(?:still\s+)?(?:doesn'?t|does\s+not|won'?t|will\s+not)\s+(?:work|let\s+me|allow\s+me)\b/i,
  /\bnothing(?:'?s|\s+is)?\s+(?:working|changed|helped)\b/i,
  /\b(?:tried|did)\s+that\s+(?:and\s+it|,?\s+it)?\s+(?:still\s+)?(?:didn'?t|does\s+not|doesn'?t|won'?t)\s+(?:work|help|let\s+me)\b/i,
  /\bi\s+(?:still\s+)?can(?:'?t|not)\s+(?:get|figure\s+out\s+how\s+to)\s+(?:it|this|the\s+\w+)\s+(?:into|to|in)\s+(?:my\s+)?cart\b/i,
];

const AGENT_CACHE_LOOP_PATTERNS: RegExp[] = [
  // Cache/cookies clear — required prefix (imperative / suggestion / sentence-start).
  /(?:^|[.!?]\s+|please\s+|could\s+you\s+|can\s+you\s+|would\s+you\s+|you\s+(?:could|can|might|should|need\s+to)\s+|try(?:\s+to)?\s+)clear(?:ing)?\s+(?:your|the)\s+(?:browser\s+)?(?:cache|cookies)\b/i,
  // Try incognito / private — `try` alone is enough (won't match "tried").
  /\btry(?:\s+(?:using|in|with))?\s+(?:an?\s+)?(?:incognito|private)(?:\s+(?:mode|browsing|window|tab))?\b/i,
  // Try a different browser.
  /\btry(?:\s+(?:using|in|with))?\s+(?:an?\s+)?(?:different|another)\s+browser\b/i,
  // Hard refresh — required prefix.
  /(?:^|[.!?]\s+|please\s+|could\s+you\s+|can\s+you\s+|you\s+(?:could|can|might|should|need\s+to)\s+|try(?:\s+to|\s+a)?\s+|do\s+a\s+|perform\s+a\s+)hard(?:\s+|-)refresh\b/i,
];

export interface PrePurchaseStillBlockedVerdict {
  /** True when the override fires (both halves matched). */
  hit: boolean;
  /** The verbatim reason string safe to stamp into a triage signal / analysis row. */
  reason?: string;
}

export function detectPrePurchaseStillBlocked(
  ctx: PrePurchaseStillBlockedContext,
): PrePurchaseStillBlockedVerdict {
  const msgs = ctx.msgs || [];
  if (!msgs.length) return { hit: false };

  const clean = (s: string | null | undefined) =>
    (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

  // (1) the LAST inbound customer message must still describe being blocked.
  const customerMsgs = msgs
    .filter((m) => m.visibility !== "internal" && m.direction === "inbound")
    .map((m) => clean(m.body_clean || m.body));
  const lastCustomer = customerMsgs[customerMsgs.length - 1];
  if (!lastCustomer) return { hit: false };
  const stillBlocked = STILL_BLOCKED_LAST_CUSTOMER_PATTERNS.some((p) => p.test(lastCustomer));
  if (!stillBlocked) return { hit: false };

  // (2) some agent (AI or human) reply must have looped on the storefront-block dead-ends.
  const agentMsgs = msgs
    .filter((m) => m.visibility !== "internal" && (m.author_type === "ai" || m.author_type === "agent"))
    .map((m) => clean(m.body_clean || m.body));
  const looped = agentMsgs.some((body) => AGENT_CACHE_LOOP_PATTERNS.some((p) => p.test(body)));
  if (!looped) return { hit: false };

  return {
    hit: true,
    reason:
      "pre-purchase still-blocked override: last customer message still describes being blocked from buying AND an agent reply told them to clear cache / try incognito / different browser / hard refresh (the ticket 3dd271be loop)",
  };
}

/**
 * Render the customer/AI conversation into a compact transcript for the classifier. Internal system
 * notes are dropped (they're not the customer-facing exchange); bodies are cleaned of quoted history
 * + signatures. Capped to the most recent MAX_TRANSCRIPT_MESSAGES to keep the call cheap.
 */
export function renderTranscript(
  msgs: Array<{ direction: string; author_type: string; visibility: string; body: string | null; body_clean: string | null }>,
  subject?: string | null,
): string {
  const convo = msgs.filter(
    (m) => m.visibility !== "internal" && (m.direction === "inbound" || m.author_type === "ai"),
  );
  const recent = convo.slice(-MAX_TRANSCRIPT_MESSAGES);
  const body = recent
    .map((m) => {
      const who = m.direction === "inbound" ? "CUSTOMER" : "AGENT";
      const text = (m.body_clean || cleanEmailBody(m.body || "")).replace(/\s+/g, " ").trim();
      return `${who}: ${text}`;
    })
    .filter((l) => l.length > `CUSTOMER: `.length)
    .join("\n");
  // Email customers routinely put the ENTIRE ask in the subject line ("PLEASE Cancel my Subscription!!!")
  // and leave a footer-only body. Render the subject as the first line so the grader sees the request —
  // otherwise a correct reply (Sol reads the subject, sends the cancel journey) looks like a non-sequitur
  // and grades ~1. See subject-blind-grader fix.
  const subj = (subject || "").replace(/\s+/g, " ").trim();
  return subj ? `SUBJECT: ${subj}${body ? `\n${body}` : ""}` : body;
}

/**
 * Run the cheap triage pass for one closed ticket. Loads the conversation, calls Haiku once, and
 * returns the parsed verdict + the window/token metadata the caller needs to record a lightweight
 * grade. Returns null on a HARD error (no API key, transport failure, no gradeable messages) so the
 * caller fails OPEN to a deep review — the pass never suppresses a ticket it couldn't actually read.
 */
export async function runCheapTriagePass(admin: Admin, ticketId: string): Promise<TriageRun | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null; // fail open — no cheap tier available, let the deep session run

  const { data: ticket } = await admin
    .from("tickets")
    .select("created_at, closed_at, sol_handled_at, ai_turn_count, subject")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) return null;

  const { data: rows } = await admin
    .from("ticket_messages")
    .select("direction, author_type, visibility, body, body_clean, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  const msgs = rows || [];
  const transcript = renderTranscript(msgs, (ticket as { subject?: string | null }).subject);
  if (!transcript) return null; // nothing gradeable — fail open

  const { system, user } = buildTriagePrompt(transcript);

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 300,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
  } catch (err) {
    console.warn("[cora-triage-pass] Haiku fetch failed (fail open to deep review):", err);
    return null;
  }
  if (!res.ok) {
    console.warn("[cora-triage-pass] Haiku HTTP", res.status, "(fail open to deep review)");
    return null;
  }
  const data = (await res.json()) as {
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content || []).map((c) => c.text || "").join("");
  const parsed = parseTriageResult(text);

  // Deterministic pre-purchase-still-blocked override — even if Haiku returned a clean
  // needs_review=false, force a deep review + a customer_unresolved signal when the ticket
  // 3dd271be pattern is present (last customer message still describes being blocked from
  // buying AND some agent reply looped on cache-clear / incognito / different browser /
  // hard refresh). Prepended to signals so the deep session sees the deterministic trip
  // first.
  const override = detectPrePurchaseStillBlocked({ msgs });
  const triage: TriageResult = override.hit
    ? {
        ...parsed,
        needsReview: true,
        signals: parsed.signals.includes("customer_unresolved")
          ? parsed.signals
          : ["customer_unresolved", ...parsed.signals],
        summary: `[pre-purchase-still-blocked] ${parsed.summary}`,
      }
    : parsed;

  const windowStart = (ticket.sol_handled_at as string | null) || (ticket.created_at as string);
  const windowEnd = (ticket.closed_at as string | null) || (msgs[msgs.length - 1]?.created_at as string) || windowStart;
  const aiMessageCount = msgs.filter((m) => m.author_type === "ai" && m.visibility !== "internal").length;

  return {
    triage,
    windowStart,
    windowEnd,
    aiMessageCount: (ticket.ai_turn_count as number | null) ?? aiMessageCount,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}

const HAIKU_INPUT_PER_MTOK_CENTS = 100; // $1.00 / 1M input tokens (Haiku 4.5)
const HAIKU_OUTPUT_PER_MTOK_CENTS = 500; // $5.00 / 1M output tokens

/**
 * Record the CLEAN cheap-pass verdict as a lightweight `ticket_analyses` row and stamp
 * `last_analyzed_at` so the cron treats this handling as graded and won't re-select it. Called only
 * when `needsReview === false` — a trip enqueues the deep session instead (which writes its own,
 * authoritative row), so we never double-write a ticket.
 */
export async function recordCheapPassClean(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
  run: TriageRun,
  trigger: string,
): Promise<void> {
  const costCents = Math.round(
    (run.inputTokens / 1_000_000) * HAIKU_INPUT_PER_MTOK_CENTS +
      (run.outputTokens / 1_000_000) * HAIKU_OUTPUT_PER_MTOK_CENTS,
  );
  await insertAnalysis({
    workspaceId,
    ticketId,
    windowStart: run.windowStart,
    windowEnd: run.windowEnd,
    score: run.triage.score,
    // Signals are carried as issues for the coaching rollup; a clean pass usually has none.
    issues: run.triage.signals.map((s) => ({ type: s, description: `cheap-pass signal: ${s}` })),
    actionItems: [],
    summary: `[cheap-pass] ${run.triage.summary}`,
    model: HAIKU_MODEL,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costCents,
    trigger,
    aiMessageCount: run.aiMessageCount,
    apiBilled: true, // the cheap pass runs inline on the paid API, never the Max box lane
  });

  await admin
    .from("tickets")
    .update({ last_analyzed_at: new Date().toISOString() })
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId);

  // Clean ENDING, but did Haiku see recovered mid-turn stumbles? Emit ONE coaching signal so June can
  // digest repeat patterns — the cheap pass owns this ticket (it did not flag it for a deep session),
  // so Cora will never also emit for it (no double-count). No-op when the path was clean. See
  // [[sol-coaching-signal]].
  await recordSolMessyTurns(admin, {
    workspaceId,
    ticketId,
    tier: "cheap",
    signals: run.triage.coachingSignals,
    score: run.triage.score,
    summary: run.triage.summary,
  });
}
