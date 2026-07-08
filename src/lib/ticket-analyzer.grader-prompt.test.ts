/**
 * Pins the Phase 1 invariant of
 * docs/brain/specs/cora-grades-against-ai-data-surface-no-false-fabrication-on-unseen-facts.md:
 * the grader system prompt must distinguish a claim that CONTRADICTS the
 * surfaced facts (a real inaccuracy — HARD CAPS apply) from a claim that
 * is simply ABSENT from the analyzer's own surface (unverified,
 * low-confidence note that does NOT cap the score and is NOT flagged as
 * `inaccuracy` / fabrication). The prompt is the whole predicate the grader
 * runs on, so these assertions are the closest testable seam for the
 * behavioural change; a regression that removes any of these clauses
 * silently re-introduces the "false fabrication on unseen facts" bug that
 * capped a correct-per-product-record variant claim to a low score and
 * force-escalated the ticket.
 *
 * Run:
 *   npx tsx --test src/lib/ticket-analyzer.grader-prompt.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SEVERE_ISSUE_TYPES,
  UNVERIFIED_FROM_SURFACE_ISSUE_TYPE,
  buildGraderSystemPrompt,
} from "./ticket-analyzer";

// Minimal admin stub — buildGraderSystemPrompt only reads grader_prompts +
// policies via the .from(t).select().eq().eq()[.is()].order() chain,
// and the policies query also tacks on .is('superseded_by', null).
// Every terminal awaited call resolves to { data: [] } so the prompt
// renders with empty rulesBlock + policyBlock — the invariants we're
// pinning live in the STATIC scaffold, not the dynamic blocks.
function stubEmptyAdmin() {
  const terminal = Promise.resolve({ data: [] as unknown[] });
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.is = () => chain;
  chain.order = () => terminal;
  return {
    from: () => chain,
  } as unknown as Parameters<typeof buildGraderSystemPrompt>[0];
}

test("grader prompt introduces the SURFACE-BOUNDED GRADING section (contradicts vs absent)", async () => {
  const prompt = await buildGraderSystemPrompt(stubEmptyAdmin(), "ws_test");
  assert.match(
    prompt,
    /SURFACE-BOUNDED GRADING/,
    "prompt must include the SURFACE-BOUNDED GRADING section by name so the grader keys on it",
  );
  assert.match(
    prompt,
    /CONTRADICTS your surface/i,
    "prompt must define the contradicts-your-surface bucket (real inaccuracy)",
  );
  assert.match(
    prompt,
    /ABSENT from your surface/i,
    "prompt must define the absent-from-your-surface bucket (unverified — not a fabrication)",
  );
});

test("grader prompt names `unverified_from_surface` as a first-class issue type distinct from `inaccuracy`", async () => {
  const prompt = await buildGraderSystemPrompt(stubEmptyAdmin(), "ws_test");
  assert.match(
    prompt,
    /unverified_from_surface/,
    "the new issue type must be enumerated in the ISSUE TYPES line so the grader emits it",
  );
  assert.equal(
    UNVERIFIED_FROM_SURFACE_ISSUE_TYPE,
    "unverified_from_surface",
    "the exported constant must match the string the grader is instructed to emit",
  );
});

test("HARD CAPS only apply to surface-contradicting inaccuracy; absent-from-surface claims do not cap", async () => {
  const prompt = await buildGraderSystemPrompt(stubEmptyAdmin(), "ws_test");
  // The cap line must explicitly say SURFACE-CONTRADICTING so an
  // uninformed reading (any inaccuracy → cap) can't slip through.
  assert.match(
    prompt,
    /SURFACE-CONTRADICTING factual inaccuracy/,
    "the score cap must be scoped to surface-contradicting inaccuracies",
  );
  // And the absent bucket must state the negative rule — it does NOT cap.
  assert.match(
    prompt,
    /does NOT cap the score/i,
    "prompt must state that unverified/absent-from-surface claims do NOT cap the score",
  );
  // Regression pin against the pre-Phase-1 wording, which capped on any
  // "factual inaccuracy" without the surface-contradicting qualifier.
  assert.doesNotMatch(
    prompt,
    /Any factual inaccuracy \(wrong code/,
    "the un-qualified 'Any factual inaccuracy' cap wording must not survive Phase 1",
  );
});

test("grader prompt explicitly forbids calling an absent-from-surface claim `inaccuracy` or a fabrication", async () => {
  const prompt = await buildGraderSystemPrompt(stubEmptyAdmin(), "ws_test");
  assert.match(
    prompt,
    /NEVER call it an `inaccuracy`/,
    "prompt must forbid tagging an absent-from-surface claim as inaccuracy",
  );
  assert.match(
    prompt,
    /NEVER call it a fabrication\/hallucination/,
    "prompt must forbid the fabrication/hallucination framing for absent-from-surface claims",
  );
});

test("SEVERE_ISSUE_TYPES does NOT include `unverified_from_surface` (so an unverified note cannot force-escalate)", () => {
  assert.equal(
    SEVERE_ISSUE_TYPES.has(UNVERIFIED_FROM_SURFACE_ISSUE_TYPE),
    false,
    "unverified_from_surface must never be treated as a severe issue — Phase 2 rides on this invariant",
  );
  // Contradicting inaccuracies still force-escalate — the change is narrow.
  assert.equal(
    SEVERE_ISSUE_TYPES.has("inaccuracy"),
    true,
    "surface-contradicting inaccuracy must still be a severe issue type",
  );
});
