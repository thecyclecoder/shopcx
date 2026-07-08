/**
 * inflection-detector — the per-turn "does the Direction still fit?" gate the cheap-execution
 * loop consults BEFORE stampedSend fires ([[../specs/sol-drift-frustration-detector-and-re-session-router]]).
 *
 * detectInflection(input) runs a two-stage classifier:
 *   Stage 1 — regex + counter rules against the newest inbound message and the resolution
 *             history (frustration cues + drift signals). Returns 'none' | 'drift' |
 *             'frustration' | 'maybe'. Frustration always wins when both fire — highest-value
 *             trigger, no confidence override (per spec).
 *   Stage 2 — on ambiguous 'maybe' only, one Haiku call with a strict-JSON envelope, given
 *             Direction.intent + the newest message + the last two turns.
 *
 * Stage 2 is never called on Stage 1 'none' or on a definite 'drift'/'frustration' — the whole
 * point of the rule catalog is that high-signal cases short-circuit before spending a Haiku
 * call. The Haiku transport is injectable so the tests can pin its behavior without a network
 * round-trip.
 *
 * Playbook-active tickets pass `isPlaybookActive: true` — Stage 1 SKIPS the drift path (drift
 * mid-playbook is not meaningful; the playbook step drives the next reply, not the Direction),
 * but frustration cues are still checked so a "refund now" mid-playbook bounces to re-session
 * per the spec.
 */
import { HAIKU_MODEL } from "@/lib/ai-models";

// ── public types ──────────────────────────────────────────────────────────────

export type InflectionKind = "none" | "drift" | "frustration";
type Stage1Kind = InflectionKind | "maybe";

export interface DetectInflectionInput {
  /** Live Direction row (or null if none authored yet). Intent drives drift keyword-mismatch. */
  direction: { intent: string; authored_at: string } | null;
  /** The newest inbound customer message (raw text, un-truncated). */
  newestMessage: string;
  /** Prior ticket_resolution_events.reasoning strings, newest first. Only the last few matter. */
  recentTurns: Array<{ reasoning: string | null }>;
  /** turn_index for the message being handled (1-based from stageResolutionEvent). */
  turnIndex: number;
  /** ai_channel_config.ai_turn_limit for this ticket's channel. */
  aiTurnLimit: number;
  /** True when the current ticket has an active playbook driving replies. */
  isPlaybookActive: boolean;
  /**
   * True when playbook_exceptions_used was incremented after Direction.authored_at.
   * The caller resolves this cheaply from tickets + directions.authored_at.
   */
  playbookExceptionsIncrementedSinceDirection: boolean;
  /** Optional Haiku injector for tests; defaults to the real Anthropic call. */
  haiku?: HaikuVerdictFn;
}

export interface InflectionEvidence {
  stage: 1 | 2;
  reason: string;
  cues?: string[];
  turn_index?: number;
  ai_turn_limit?: number;
  drift_score?: number;
  playbook_exceptions_incremented?: boolean;
  haiku_verdict?: HaikuVerdict | null;
}

export interface InflectionResult {
  kind: InflectionKind;
  evidence: InflectionEvidence;
}

export interface HaikuVerdict {
  kind: InflectionKind;
  reason: string;
}

export type HaikuVerdictFn = (args: {
  intent: string;
  newestMessage: string;
  recentTurns: Array<{ reasoning: string | null }>;
}) => Promise<HaikuVerdict | null>;

// ── Stage 1: rule catalog ─────────────────────────────────────────────────────

/**
 * FRUSTRATION_CUES — high-signal phrases seeded from real support tickets. Ordered by
 * specificity so the first match wins the evidence label. Every entry must be a phrase a
 * calm customer would not reasonably use; false positives here bounce a good session.
 */
const FRUSTRATION_CUES: Array<{ id: string; re: RegExp }> = [
  { id: "refund_now", re: /\brefund\s+(?:me\s+)?(?:now|immediately|asap|right\s+now)\b/i },
  { id: "cancel_everything", re: /\bcancel\s+(?:everything|it\s+all|the\s+whole\s+thing|all\s+of\s+it)\b/i },
  { id: "this_is_ridiculous", re: /\bthis\s+is\s+(?:ridiculous|absurd|insane|unacceptable|outrageous)\b/i },
  { id: "sue_you", re: /\b(?:i(?:'m|\s+am)\s+going\s+to\s+sue|see\s+you\s+in\s+court|small\s+claims)\b/i },
  { id: "chargeback", re: /\b(?:i(?:'m|\s+am)\s+)?(?:going\s+to\s+)?(?:file(?:\s+a)?|do\s+a|dispute\s+with|open\s+a)?\s*charge\s*back(?:s)?\b/i },
  { id: "worst_service", re: /\b(?:worst|terrible|awful|garbage)\s+(?:customer\s+)?(?:service|support|company)\b/i },
  { id: "stop_scamming", re: /\b(?:stop\s+)?(?:scam(?:ming)?|rip(?:ping)?\s+me\s+off|fraud)\b/i },
  { id: "give_up", re: /\b(?:i\s+give\s+up|i(?:'m|\s+am)\s+done|forget\s+it)\b/i },
  { id: "speak_to_human", re: /\b(?:speak|talk)\s+to\s+(?:a\s+)?(?:human|manager|supervisor|real\s+person)\b/i },
  { id: "wtf", re: /\b(?:wtf|what\s+the\s+(?:f\*+|fuck|hell))\b/i },
];

// A caller in ALL CAPS this fraction of the message (letters only) reads as shouting.
const CAPS_RATIO_THRESHOLD = 0.7;
// Below this many letters an ALL-CAPS message is likely an acronym / signature — do not flag.
const CAPS_MIN_LETTERS = 20;
// A repeated stream of !!! or ??? this long is a frustration signal.
const REPEATED_PUNCT_RE = /[!?]{3,}/;

// ── Stage 1: drift heuristics ─────────────────────────────────────────────────

// Rough part-of-speech blacklist — common words carry no intent signal.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "of", "to", "for", "on", "in", "at",
  "by", "with", "from", "is", "am", "are", "was", "were", "be", "been", "being", "do", "does",
  "did", "have", "has", "had", "will", "would", "should", "could", "can", "may", "might", "must",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your",
  "his", "its", "our", "their", "this", "that", "these", "those", "there", "here", "just", "not",
  "no", "yes", "please", "thanks", "thank", "hello", "hi", "hey",
]);

/**
 * Extract a lower-cased set of content tokens (stopwords stripped) from a free-text string.
 * Used to compare Direction.intent against message / recent reasoning content.
 */
function contentTokens(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length < 3) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/**
 * Fraction of Direction.intent content tokens that DO NOT appear anywhere in the newest
 * message + the reasoning of the last two turns. 0 = all intent tokens are still in play;
 * 1 = the conversation has drifted completely off-Direction.
 */
function driftMismatchScore(
  intent: string,
  newestMessage: string,
  recentTurns: Array<{ reasoning: string | null }>,
): number {
  const intentTokens = contentTokens(intent);
  if (intentTokens.size === 0) return 0;
  const haystack = new Set<string>();
  for (const t of contentTokens(newestMessage)) haystack.add(t);
  for (const turn of recentTurns.slice(0, 2)) {
    for (const t of contentTokens(turn.reasoning)) haystack.add(t);
  }
  let missing = 0;
  for (const t of intentTokens) if (!haystack.has(t)) missing++;
  return missing / intentTokens.size;
}

// A content-token miss above this fraction registers as drift. Chosen so a fully-relevant
// follow-up ("what's the tracking number?" on a "shipping-delay" intent) stays under it
// while a topic pivot ("actually I want to change my flavor") clears it.
const DRIFT_MISMATCH_THRESHOLD = 0.8;
// turn_index >= 80% of the channel's ai_turn_limit registers as drift — the conversation
// is running out of room and the current Direction hasn't landed.
const TURN_LIMIT_APPROACH_RATIO = 0.8;

// ── Stage 1: classifier ───────────────────────────────────────────────────────

function detectFrustrationStage1(newestMessage: string): { hit: boolean; cues: string[] } {
  const cues: string[] = [];
  for (const cue of FRUSTRATION_CUES) {
    if (cue.re.test(newestMessage)) cues.push(cue.id);
  }
  if (REPEATED_PUNCT_RE.test(newestMessage)) cues.push("repeated_punct");
  const letters = newestMessage.replace(/[^a-zA-Z]/g, "");
  if (letters.length >= CAPS_MIN_LETTERS) {
    const caps = letters.replace(/[^A-Z]/g, "").length;
    if (caps / letters.length >= CAPS_RATIO_THRESHOLD) cues.push("all_caps");
  }
  return { hit: cues.length > 0, cues };
}

interface Stage1Result {
  kind: Stage1Kind;
  evidence: InflectionEvidence;
}

function stage1Classify(input: DetectInflectionInput): Stage1Result {
  // Frustration cues run first — a "refund now" mid-playbook must still bounce, so we do NOT
  // skip this arm even when isPlaybookActive.
  const frust = detectFrustrationStage1(input.newestMessage);
  if (frust.hit) {
    return {
      kind: "frustration",
      evidence: { stage: 1, reason: "stage1_frustration_cue", cues: frust.cues },
    };
  }

  // Drift signals — SKIP entirely mid-playbook (per spec: drift is not meaningful; the
  // playbook drives the reply and the Direction is deliberately stale).
  if (input.isPlaybookActive) {
    return { kind: "none", evidence: { stage: 1, reason: "playbook_active_skip_drift" } };
  }

  const turnApproach =
    input.aiTurnLimit > 0 && input.turnIndex >= TURN_LIMIT_APPROACH_RATIO * input.aiTurnLimit;
  const driftScore = input.direction
    ? driftMismatchScore(input.direction.intent, input.newestMessage, input.recentTurns)
    : 0;
  const driftKeywordHit = input.direction ? driftScore >= DRIFT_MISMATCH_THRESHOLD : false;
  const anyDrift =
    driftKeywordHit || turnApproach || input.playbookExceptionsIncrementedSinceDirection;

  if (anyDrift) {
    // Two or more drift signals → confident drift; a single signal → 'maybe' for Haiku.
    const signals = [
      driftKeywordHit ? "drift_keyword_mismatch" : null,
      turnApproach ? "turn_limit_approach" : null,
      input.playbookExceptionsIncrementedSinceDirection ? "playbook_exception_incremented" : null,
    ].filter((s): s is string => s !== null);
    if (signals.length >= 2) {
      return {
        kind: "drift",
        evidence: {
          stage: 1,
          reason: "stage1_drift_multi_signal",
          cues: signals,
          turn_index: input.turnIndex,
          ai_turn_limit: input.aiTurnLimit,
          drift_score: driftScore,
          playbook_exceptions_incremented: input.playbookExceptionsIncrementedSinceDirection,
        },
      };
    }
    return {
      kind: "maybe",
      evidence: {
        stage: 1,
        reason: "stage1_drift_single_signal",
        cues: signals,
        turn_index: input.turnIndex,
        ai_turn_limit: input.aiTurnLimit,
        drift_score: driftScore,
        playbook_exceptions_incremented: input.playbookExceptionsIncrementedSinceDirection,
      },
    };
  }

  return { kind: "none", evidence: { stage: 1, reason: "stage1_no_signal" } };
}

// ── Stage 2: Haiku fallback ───────────────────────────────────────────────────

/**
 * The Stage 2 prompt sent to Haiku. Documented verbatim in
 * [[../docs/brain/libraries/inflection-detector.md]] so a future reviewer can pin what the
 * model is actually asked. Strict-JSON output; the caller reads .kind + .reason.
 */
export const STAGE_2_SYSTEM_PROMPT = [
  "You are a support-triage classifier. Given the current ticket Direction's intent, the",
  "newest inbound customer message, and the two most recent orchestrator turns, decide whether",
  "the conversation has DRIFTED off the current intent, whether the customer is showing",
  "FRUSTRATION, or NEITHER. Frustration outweighs drift when both are present.",
  "",
  "Return STRICT JSON only, no prose, matching:",
  '  {"kind": "none" | "drift" | "frustration", "reason": "one short sentence"}',
].join("\n");

function buildStage2UserPrompt(args: {
  intent: string;
  newestMessage: string;
  recentTurns: Array<{ reasoning: string | null }>;
}): string {
  const lastTwo = args.recentTurns
    .slice(0, 2)
    .map((t, i) => `  ${i + 1}. ${t.reasoning ?? "(no reasoning recorded)"}`)
    .join("\n") || "  (no prior turns)";
  return [
    `Direction.intent: ${args.intent || "(unset)"}`,
    "",
    "Last two orchestrator turns (newest first):",
    lastTwo,
    "",
    `Newest customer message: ${args.newestMessage}`,
  ].join("\n");
}

/**
 * The default Haiku transport. One-shot Messages call, strict-JSON response parsed and
 * validated. Returns null on any HTTP/parse/validation failure — the caller falls back to
 * Stage 1's 'maybe' (which is 'none' semantics for the bounce decision) so a transient
 * Anthropic outage never hallucinates a bounce.
 */
async function defaultHaiku(args: {
  intent: string;
  newestMessage: string;
  recentTurns: Array<{ reasoning: string | null }>;
}): Promise<HaikuVerdict | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 200,
        system: STAGE_2_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildStage2UserPrompt(args) }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw: string = (data.content?.[0] as { text: string })?.text?.trim() || "";
    // Strip optional ```json fences the model sometimes adds despite "strict JSON".
    const jsonText = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(jsonText) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as { kind?: string; reason?: string };
    if (p.kind !== "none" && p.kind !== "drift" && p.kind !== "frustration") return null;
    return { kind: p.kind, reason: typeof p.reason === "string" ? p.reason : "" };
  } catch {
    return null;
  }
}

// ── public entrypoint ────────────────────────────────────────────────────────

/**
 * Two-stage inflection classification. Returns one of {'none','drift','frustration'} plus
 * evidence the caller stamps into ticket_resolution_events.reasoning ('sol:inflection-<kind>')
 * and payload for the re-session router.
 */
export async function detectInflection(
  input: DetectInflectionInput,
): Promise<InflectionResult> {
  const stage1 = stage1Classify(input);

  // Definite Stage 1 outcomes never spend a Haiku call.
  if (stage1.kind === "none" || stage1.kind === "drift" || stage1.kind === "frustration") {
    return { kind: stage1.kind, evidence: stage1.evidence };
  }

  // 'maybe' → one Haiku call. Missing Direction (no intent to compare) collapses to 'none'
  // — the model has nothing to reason against and a bounce with no evidence is worse than
  // letting the current session finish.
  if (!input.direction) {
    return {
      kind: "none",
      evidence: { ...stage1.evidence, reason: "maybe_no_direction_fallback_none" },
    };
  }

  const haiku = input.haiku ?? defaultHaiku;
  const verdict = await haiku({
    intent: input.direction.intent,
    newestMessage: input.newestMessage,
    recentTurns: input.recentTurns,
  });

  if (!verdict) {
    // Transient Haiku failure — treat 'maybe' as 'none' (do not bounce on ambiguity we can't
    // resolve). Evidence records the failure so the ledger reflects the classifier state.
    return {
      kind: "none",
      evidence: {
        stage: 2,
        reason: "haiku_unavailable_fallback_none",
        cues: stage1.evidence.cues,
        haiku_verdict: null,
      },
    };
  }

  return {
    kind: verdict.kind,
    evidence: {
      stage: 2,
      reason: `haiku:${verdict.reason || "no_reason"}`,
      cues: stage1.evidence.cues,
      haiku_verdict: verdict,
    },
  };
}
