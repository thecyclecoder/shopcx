/**
 * needs-attention-classify — classify a parked `agent_jobs` row into the routing class the
 * auto-route-needs-attention sweep dispatches on
 * ([[../../docs/brain/specs/no-parked-specs-auto-route-needs-attention.md]] Phase 0).
 *
 * needs_attention used to be a terminal state — the worker punted, wrote a free-text reason, and
 * waited for a human to triage. This module is the **classification gate**: every park lands in
 * exactly one of five classes so the routers (Phases 1–4) can fold / spec-the-blocker / invite to
 * chat / backstop automatically.
 *
 *   already_shipped — the work the spec describes is already on `main` (a duplicate build, or a
 *                     prior PR that landed before the agent walked in). Routes to AUTO-FOLD.
 *   real_blocker    — a genuine missing prerequisite the agent uncovered (a missing API surface,
 *                     a schema change the spec doesn't declare, a dependency on unshipped code).
 *                     Routes to AUTO-SPEC the blocker.
 *   tooling_failure — the agent itself failed to produce a verdict (security-review stdin timeout,
 *                     parseable-verdict-after-N-attempts fall-through, claude session crash).
 *                     Routes to AUTO-SPEC the tooling fix.
 *   design_change   — the build revealed the spec's design is materially wrong, not a fixable bug.
 *                     Routes to INVITE THE CEO TO CHAT (the only class that surfaces to the human).
 *   unknown         — the classifier couldn't decide. The backstop sweep (Phase 4) forces it
 *                     through a director investigation pass.
 *
 * The classifier is HEURISTIC-FIRST (zero token cost when the park reason is unambiguous) and
 * falls through to a 1-shot Sonnet call when the heuristics are insufficient. Both paths are
 * read-only — only the standing routers mutate `needs_attention_class` (the worker stamps it via
 * `classifyAndStamp` at park time; the backstop re-runs the classifier against rows that landed
 * with no class).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { logAiUsage } from "@/lib/ai-usage";
import { SONNET_MODEL } from "@/lib/ai-models";

type Admin = ReturnType<typeof createAdminClient>;

export type NeedsAttentionClass =
  | "already_shipped"
  | "real_blocker"
  | "tooling_failure"
  | "design_change"
  | "unknown";

export const NEEDS_ATTENTION_CLASSES: NeedsAttentionClass[] = [
  "already_shipped",
  "real_blocker",
  "tooling_failure",
  "design_change",
  "unknown",
];

export interface ClassifyInput {
  jobKind: string;
  specSlug: string | null;
  error: string | null;
  logTail: string | null;
  phases?: { title: string; status: string }[];
  /** the build's last self-reported verdict (parsed status from the agent's JSON, when present). */
  agentSummary?: string | null;
  /**
   * the live `spec_card_state.status` for this spec at classification time. When the board says
   * `shipped` for a build-style kind, that overrides any verdict-string ambiguity → `already_shipped`
   * (park-classifier-trust-board-shipped Phase 1). `classifyAndStamp` looks this up from
   * `spec_card_state` and passes it through; pure-function callers (tests) can set it directly.
   */
  boardStatus?: string | null;
}

/**
 * Build-style `agent_jobs.kind`s that target a spec — the kinds for which "board says shipped"
 * authoritatively means "this work is already done". `build` (the feature build), `regression` (the
 * regression-agent's fix spec build), and `repair` (the repair-agent's fix spec build) all open a PR
 * against a single spec; if that spec's `spec_card_state.status='shipped'`, a parked job against it
 * is by definition `already_shipped`. Other kinds (`plan`, `fold`, `spec-test`, …) don't fit this
 * shape and stay on the verdict-string heuristic + Sonnet pass. (park-classifier-trust-board-shipped)
 */
export const BUILD_STYLE_KINDS: ReadonlySet<string> = new Set(["build", "regression", "repair"]);

export interface ClassifyResult {
  klass: NeedsAttentionClass;
  /** "heuristic" → matched a deterministic rule; "sonnet" → 1-shot LLM; "fallback" → defaulted to unknown. */
  source: "heuristic" | "sonnet" | "fallback";
  reason: string;
}

// ── BOARD-FIRST SHORT-CIRCUIT ─────────────────────────────────────────────────────────────
// The board (`spec_card_state.status`) is the source of truth on whether a spec is shipped. A
// build-style park against a `shipped` spec is by definition `already_shipped` — regardless of the
// verdict-string heuristic or the Sonnet classifier's confidence. This runs BEFORE both, so a
// build whose verdict reads 'Phase 1 was already built end-to-end in #315' (a phrasing the
// heuristic doesn't recognize) never falls through to `class='unknown'` and never sits stuck in
// `needs_attention` waiting on the 60-minute backstop. (park-classifier-trust-board-shipped Phase 1)
export function classifyByBoardState(input: ClassifyInput): ClassifyResult | null {
  if (!BUILD_STYLE_KINDS.has(input.jobKind)) return null;
  if (!input.specSlug) return null;
  if (input.boardStatus !== "shipped") return null;
  return {
    klass: "already_shipped",
    source: "heuristic",
    reason: `spec_card_state.status='shipped' for ${input.specSlug} (board is the source of truth)`,
  };
}

// ── HEURISTICS ────────────────────────────────────────────────────────────────────────────
// Cheap deterministic patterns over the worker's existing park-reason strings. Each pattern is
// keyed off a substring the existing builder-worker / repair / regression / security pipelines
// already emit — adding a new park reason that fits one of these classes is just adding to the
// regex (or letting the Sonnet fallback catch it).

const ALREADY_SHIPPED_PATTERNS: RegExp[] = [
  /already.{0,20}(shipped|merged|on main|landed)/i,
  /spec.{0,10}archived/i,
  /no unsatisfied phase/i,
  /no unsatisfied phases? remain/i,
  /work.{0,10}already.{0,10}(there|done|exists|shipped)/i,
  /merged sibling build/i,
  /code.{0,20}already.{0,10}(present|in main|merged)/i,
];

const TOOLING_FAILURE_PATTERNS: RegExp[] = [
  /no parseable verdict/i,
  /without a recognizable (verdict|status)/i,
  /produced no parseable json/i,
  /stdin (timeout|closed|hang)/i,
  /claude session (crash|died|terminated)/i,
  /worker (restart|crash|orphan)/i,
  /branch pushed but pr creation failed/i,
  /spec commit failed/i,
  /missing spec body/i,
  /malformed instructions/i,
  /apply_model_tier action missing/i,
  // marco-logistics-director-seat Phase 5 fix — the fused pre-merge spec-test session's
  // one-shot envelope-repair retry can still miss on a long/complex diff; the resulting
  // synthesizeMissingEnvelopeStub verdict is a `needs-human` stub whose review string
  // narrates "did not emit a security envelope". That is the LLM failing to produce
  // required structured output — the definition of a tooling_failure — not a genuine
  // missing code prerequisite. Route it to auto-spec-the-tooling-fix, never to spawn a
  // real_blocker Fix phase against the origin (whose diff has no missing prerequisite).
  /did not emit a security envelope/i,
  /no security envelope on the fused spec-test result/i,
  /fused security envelope missing required check/i,
];

const REAL_BLOCKER_PATTERNS: RegExp[] = [
  /needs[- ]human/i,
  /no valid fix spec/i,
  /needs a human merge/i,
  /loop[- ]guard.{0,20}escalat/i,
  /repeatedly didn'?t hold/i,
  /missing (api|surface|table|column|migration)/i,
  /unstated (blocker|prerequisite|dependency)/i,
];

const DESIGN_CHANGE_PATTERNS: RegExp[] = [
  /design.{0,20}(wrong|mismatch|change|review)/i,
  /spec.{0,20}(unsound|fundamentally|materially wrong|premise)/i,
  /scope.{0,20}(unclear|expanded|too large)/i,
  /requires (a |an )?(re-?spec|redesign|architecture)/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  for (const p of patterns) if (p.test(text)) return true;
  return false;
}

/**
 * Heuristic classification — substring match against the worker's existing park-reason vocabulary.
 * Returns null when no rule fires (caller falls through to Sonnet). Order matters: already_shipped
 * wins over tooling_failure when both match (the "spec commit failed because it's already shipped"
 * case routes to auto-fold, not to a tooling spec).
 */
export function classifyByHeuristic(input: ClassifyInput): ClassifyResult | null {
  const blob = `${input.error ?? ""}\n${input.logTail ?? ""}\n${input.agentSummary ?? ""}`.toLowerCase();
  if (matchesAny(blob, ALREADY_SHIPPED_PATTERNS)) {
    return { klass: "already_shipped", source: "heuristic", reason: "matched already-shipped pattern" };
  }
  if (matchesAny(blob, DESIGN_CHANGE_PATTERNS)) {
    return { klass: "design_change", source: "heuristic", reason: "matched design-change pattern" };
  }
  if (matchesAny(blob, TOOLING_FAILURE_PATTERNS)) {
    return { klass: "tooling_failure", source: "heuristic", reason: "matched tooling-failure pattern" };
  }
  if (matchesAny(blob, REAL_BLOCKER_PATTERNS)) {
    return { klass: "real_blocker", source: "heuristic", reason: "matched real-blocker pattern" };
  }
  return null;
}

// ── SONNET FALLBACK ───────────────────────────────────────────────────────────────────────
// One-shot classifier — short prompt, tiny max_tokens, JSON-only. Used when the heuristics don't
// fire (the park reason is novel or ambiguous). The classifier never branches the work — it just
// returns the routing label; the standing sweep then dispatches.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const CLASSIFIER_SYSTEM = `You classify a parked agent_jobs row from the ShopCX build pipeline into ONE routing class.

CLASSES:
- already_shipped: the work the spec describes is already on main (a duplicate build, or a prior PR landed).
- real_blocker: a genuine missing prerequisite the build uncovered (missing API, schema, unshipped dependency).
- tooling_failure: the agent itself failed (no parseable verdict, stdin timeout, session crash, commit/push failure).
- design_change: the build revealed the spec's design is materially wrong — needs a re-spec, not a code fix.
- unknown: insufficient evidence to choose.

OUTPUT (JSON only, no prose around it):
{"klass":"<one of the 5>","reason":"<one short sentence — why this class>"}`;

interface SonnetClassification {
  klass: NeedsAttentionClass;
  reason: string;
}

async function classifyBySonnet(input: ClassifyInput, workspaceId: string | null): Promise<ClassifyResult | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const userMsg = [
    `Job kind: ${input.jobKind}`,
    `Spec slug: ${input.specSlug ?? "(none)"}`,
    `Park reason: ${input.error ?? "(none recorded)"}`,
    input.phases && input.phases.length
      ? `Spec phases (status):\n${input.phases.map((p) => `  - ${p.status} ${p.title}`).join("\n")}`
      : "Spec phases: (none parsed)",
    `Log tail (truncated):\n${(input.logTail ?? "").slice(-1500) || "(none)"}`,
  ].join("\n\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 200,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (!res.ok) {
      console.warn(`[needs-attention-classify] sonnet http ${res.status} — defaulting unknown`);
      return null;
    }
    const data = await res.json();
    const text = (data.content?.[0] as { text?: string })?.text?.trim() || "";
    if (workspaceId) {
      await logAiUsage({ workspaceId, model: SONNET_MODEL, usage: data.usage, purpose: "needs_attention_classify" });
    }
    let parsed: SonnetClassification | null = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]) as SonnetClassification;
    } catch {
      /* fall through */
    }
    if (!parsed) return null;
    const klass = parsed.klass;
    if (!NEEDS_ATTENTION_CLASSES.includes(klass)) return null;
    return { klass, source: "sonnet", reason: (parsed.reason || "").slice(0, 280) };
  } catch (e) {
    console.warn("[needs-attention-classify] sonnet failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Classify a parked job. Heuristic first (free, deterministic); falls back to Sonnet when no rule
 * fires and an API key is available; lands on `unknown` (the backstop's input) when both fail.
 * Read-only — caller is responsible for stamping the result onto the row.
 */
export async function classifyNeedsAttention(input: ClassifyInput, workspaceId: string | null): Promise<ClassifyResult> {
  const board = classifyByBoardState(input);
  if (board) return board;
  const h = classifyByHeuristic(input);
  if (h) return h;
  const s = await classifyBySonnet(input, workspaceId);
  if (s) return s;
  return { klass: "unknown", source: "fallback", reason: "no heuristic match and no Sonnet verdict" };
}

/**
 * Look up the live `spec_card_state.status` for a `(workspace, spec_slug)` pair — the board's
 * shipped/in_progress/planned/rejected rollup, the input to `classifyByBoardState`. Returns null on
 * any miss / DB hiccup (the classifier then falls through to the heuristic + Sonnet path as if the
 * board check was never asked). Best-effort: a Supabase glitch on the board lookup MUST NOT block
 * classification, since the heuristic + Sonnet pass still has a reasonable chance to bucket the row.
 */
async function lookupBoardStatus(admin: Admin, workspaceId: string, specSlug: string): Promise<string | null> {
  try {
    const { data } = await admin
      .from("spec_card_state")
      .select("status")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", specSlug)
      .maybeSingle();
    return ((data as { status?: string } | null)?.status as string | undefined) ?? null;
  } catch (e) {
    console.warn(`[needs-attention-classify] board lookup failed for ${specSlug}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Classify + stamp the column + mirror onto spec_card_state.flags.last_park_class in one call. Used
 * by the worker when it transitions a job to needs_attention, and by the backstop sweep when it
 * (re-)classifies a row that landed with no class. Best-effort: a failed mirror never blocks the
 * underlying classification write (the routers read from agent_jobs, not the card flag).
 */
export async function classifyAndStamp(
  admin: Admin,
  jobId: string,
  input: ClassifyInput & { workspaceId: string },
): Promise<ClassifyResult> {
  // Resolve the live board status for build-style kinds so `classifyByBoardState` can short-circuit
  // a parked build against an already-shipped spec to `already_shipped` before the verdict-string
  // heuristic + Sonnet pass even run. (park-classifier-trust-board-shipped Phase 1)
  let boardStatus: string | null = input.boardStatus ?? null;
  if (boardStatus === null && BUILD_STYLE_KINDS.has(input.jobKind) && input.specSlug) {
    boardStatus = await lookupBoardStatus(admin, input.workspaceId, input.specSlug);
  }
  const result = await classifyNeedsAttention({ ...input, boardStatus }, input.workspaceId);
  try {
    await admin.from("agent_jobs").update({ needs_attention_class: result.klass, updated_at: new Date().toISOString() }).eq("id", jobId);
  } catch (e) {
    console.warn(`[needs-attention-classify] stamp failed for ${jobId}:`, e instanceof Error ? e.message : e);
  }
  // Mirror to the spec card so the board has a routing hint without joining agent_jobs.
  if (input.specSlug) {
    try {
      const { data: existing } = await admin
        .from("spec_card_state")
        .select("flags")
        .eq("workspace_id", input.workspaceId)
        .eq("spec_slug", input.specSlug)
        .maybeSingle();
      const priorFlags = ((existing as { flags?: Record<string, unknown> } | null)?.flags as Record<string, unknown>) ?? {};
      const flags = { ...priorFlags, last_park_class: result.klass };
      await admin
        .from("spec_card_state")
        .upsert(
          { workspace_id: input.workspaceId, spec_slug: input.specSlug, flags, updated_at: new Date().toISOString() },
          { onConflict: "workspace_id,spec_slug" },
        );
    } catch (e) {
      console.warn(`[needs-attention-classify] card mirror failed for ${input.specSlug}:`, e instanceof Error ? e.message : e);
    }
  }
  return result;
}
