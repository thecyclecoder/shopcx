/**
 * spec-drift tests — the reverse-drift reconciler's REVERT decision for director-flipped suspects
 * ([[../specs/ada-director-spec-status-cards]] Phase 3). Pure-logic tests over the most-recent-first
 * spec_status_history rows so we can prove the reversibility backstop without a live Supabase.
 *
 * Run: npx tsx --test src/lib/spec-drift.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideDirectorRevertFromRows, parsePhasesWithLines } from "./spec-drift";

test("decideDirectorRevertFromRows reverts a director-stamped planned → shipped flip back to planned", () => {
  const decision = decideDirectorRevertFromRows([
    { actor: "director:platform", from_value: '"planned"', to_value: '"shipped"' },
  ]);
  assert.deepEqual(decision, { revertTo: "planned", directorActor: "director:platform" });
});

test("decideDirectorRevertFromRows falls back to in_progress when the prior value is missing", () => {
  const decision = decideDirectorRevertFromRows([
    { actor: "director:platform", from_value: null, to_value: '"shipped"' },
  ]);
  assert.deepEqual(decision, { revertTo: "in_progress", directorActor: "director:platform" });
});

test("decideDirectorRevertFromRows does NOT revert a merge-stamped shipped flip (build merge is trusted)", () => {
  const decision = decideDirectorRevertFromRows([
    { actor: "merge:abc1234", from_value: '"in_progress"', to_value: '"shipped"' },
  ]);
  assert.equal(decision, null);
});

test("decideDirectorRevertFromRows does NOT revert when the most recent director flip targeted non-shipped", () => {
  const decision = decideDirectorRevertFromRows([
    { actor: "director:platform", from_value: '"planned"', to_value: '"in_progress"' },
  ]);
  assert.equal(decision, null);
});

test("decideDirectorRevertFromRows does NOT revert when an owner flip is the most recent status row", () => {
  const decision = decideDirectorRevertFromRows([
    { actor: "owner:00000000-0000-0000-0000-000000000000", from_value: '"in_progress"', to_value: '"shipped"' },
  ]);
  assert.equal(decision, null);
});

test("decideDirectorRevertFromRows returns null on empty history", () => {
  assert.equal(decideDirectorRevertFromRows([]), null);
});

test("decideDirectorRevertFromRows ignores earlier director flips when the most recent row is a merge", () => {
  // Order is most-recent-first. The merge is trusted, even though a prior director flip exists.
  const decision = decideDirectorRevertFromRows([
    { actor: "merge:def5678", from_value: '"planned"', to_value: '"shipped"' },
    { actor: "director:platform", from_value: '"planned"', to_value: '"shipped"' },
  ]);
  assert.equal(decision, null);
});

// ── parsePhasesWithLines — boundary-aware H3 phase detection (skip-verification-subsections) ─────────
// PR #557 added H3 acceptance for the `## Phases\n### Phase N` wrapper but had no scope guard, so any
// `### Phase N` under `## Verification`, `## Safety / invariants`, etc. was double-counted as a real
// phase — stranding shipped specs (e.g. bounce-escalation-back-to-director) with phantom ⏳ phases.
// These fixtures lock the new boundary rule in.

test("parsePhasesWithLines (canonical shape) counts only the 3 H2 phases — H3 verification subheaders skipped", () => {
  const raw = [
    "# Test spec",
    "",
    "## Phase 1 — endpoint",
    "- src/app/api/foo/route.ts",
    "",
    "## Phase 2 — UI",
    "- src/app/dashboard/foo/page.tsx",
    "",
    "## Phase 3 — handler",
    "- src/lib/foo-handler.ts",
    "",
    "## Verification",
    "### Phase 1 — endpoint",
    "- check the endpoint",
    "### Phase 2 — UI",
    "- check the UI",
    "### Phase 3 — handler",
    "- check the handler",
  ].join("\n");
  const phases = parsePhasesWithLines(raw);
  assert.equal(phases.length, 3);
  assert.deepEqual(
    phases.map((p) => [p.index, p.title]),
    [
      [0, "Phase 1 — endpoint"],
      [1, "Phase 2 — UI"],
      [2, "Phase 3 — handler"],
    ],
  );
});

test("parsePhasesWithLines (wrapper shape — PR #557's case) still counts 3 H3 phases under `## Phases`", () => {
  const raw = [
    "# Test spec",
    "",
    "## Phases",
    "### Phase 1 — endpoint",
    "- src/app/api/foo/route.ts",
    "### Phase 2 — UI",
    "- src/app/dashboard/foo/page.tsx",
    "### Phase 3 — handler",
    "- src/lib/foo-handler.ts",
  ].join("\n");
  const phases = parsePhasesWithLines(raw);
  assert.equal(phases.length, 3);
  assert.deepEqual(
    phases.map((p) => [p.index, p.title]),
    [
      [0, "Phase 1 — endpoint"],
      [1, "Phase 2 — UI"],
      [2, "Phase 3 — handler"],
    ],
  );
});

test("parsePhasesWithLines skips an H3 `### Phase N` under `## Safety / invariants`", () => {
  const raw = [
    "# Test spec",
    "",
    "## Phase 1 — real",
    "- src/lib/real.ts",
    "",
    "## Safety / invariants",
    "### Phase 1 — invariant-only mention",
    "- something about phase 1",
  ].join("\n");
  const phases = parsePhasesWithLines(raw);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].title, "Phase 1 — real");
});

test("parsePhasesWithLines skips an H3 `### Phase N` under `## Background`", () => {
  const raw = [
    "# Test spec",
    "",
    "## Background",
    "### Phase 1 — historical note",
    "- prose mentioning Phase 1",
    "",
    "## Phase 1 — real",
    "- src/lib/real.ts",
    "## Phase 2 — real",
    "- src/lib/real-2.ts",
  ].join("\n");
  const phases = parsePhasesWithLines(raw);
  assert.equal(phases.length, 2);
  assert.deepEqual(
    phases.map((p) => p.title),
    ["Phase 1 — real", "Phase 2 — real"],
  );
});

test("parsePhasesWithLines (regression — bounce-escalation-back-to-director shape) returns exactly 3 phases", () => {
  // 3 real H2 phases + 3 H3 verification subheaders. Pre-fix this parsed as 6, which stranded the
  // spec at planned/in_progress with phantom phases no build could satisfy.
  const raw = [
    "# bounce-escalation-back-to-director",
    "",
    "## Phase 1 — bounce-detection",
    "- src/lib/escalation-bounce.ts",
    "",
    "## Phase 2 — bounce-handler",
    "- src/lib/inngest/bounce-handler.ts",
    "",
    "## Phase 3 — board surface",
    "- src/app/dashboard/control-tower/page.tsx",
    "",
    "## Verification",
    "### Phase 1 — bounce-detection",
    "- verify detector",
    "### Phase 2 — bounce-handler",
    "- verify handler",
    "### Phase 3 — board surface",
    "- verify surface",
  ].join("\n");
  const phases = parsePhasesWithLines(raw);
  assert.equal(phases.length, 3);
  assert.deepEqual(
    phases.map((p) => p.title),
    ["Phase 1 — bounce-detection", "Phase 2 — bounce-handler", "Phase 3 — board surface"],
  );
});

// ── parsePhasesWithLines — fenced-code-block skip (skip-fenced-code-blocks) ──────────────────────────
// PR #562 fixed the H3 boundary case, but `## Phase` / `### Phase` lines INSIDE a ``` / ~~~ fenced
// code block still counted as real phases — any spec embedding a canonical-shape EXAMPLE in
// `## Background` / `## Anti-pattern` inflated its phase count. These fixtures lock the by-fence
// skip in, both for ``` and ~~~ delimiters.

test("parsePhasesWithLines skips a fenced `## Phase N` example, counts only the real H2 phase", () => {
  const raw = [
    "# Test spec",
    "",
    "## Phase 1 — real ⏳",
    "- src/lib/real.ts",
    "",
    "## Background",
    "Example canonical shape — must not be counted:",
    "```",
    "## Phase 1 — example",
    "- src/lib/example.ts",
    "```",
  ].join("\n");
  const phases = parsePhasesWithLines(raw);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].title, "Phase 1 — real");
});

test("parsePhasesWithLines (regression — folded-sibling `## Background` block) returns exactly 2 real phases", () => {
  // The folded sibling's `## Background` documented the parser with a fenced canonical-shape
  // example: 3 fenced H2 + 3 fenced H3 lines. Pre-fix that parsed as 6 phantom phases on top
  // of the 2 real H2 phases (+ a `## Verification` block with H3 subheaders the PR #562 rule
  // already drops). The new parser drops the fenced lines AND the verification subheaders →
  // exactly 2 real phases survive.
  const raw = [
    "# folded-sibling-shape",
    "",
    "## Background",
    "The canonical-shape example we used to document the parser was:",
    "```",
    "## Phase 1 — endpoint",
    "## Phase 2 — UI",
    "## Phase 3 — handler",
    "### Phase 1 — endpoint",
    "### Phase 2 — UI",
    "### Phase 3 — handler",
    "```",
    "",
    "## Phase 1 — parser",
    "- src/lib/spec-drift.ts",
    "",
    "## Phase 2 — backfill",
    "- scripts/_audit-spec-phase-overcount.ts",
    "",
    "## Verification",
    "### Phase 1 — parser",
    "- check the parser",
    "### Phase 2 — backfill",
    "- check the audit",
  ].join("\n");
  const phases = parsePhasesWithLines(raw);
  assert.equal(phases.length, 2);
  assert.deepEqual(
    phases.map((p) => p.title),
    ["Phase 1 — parser", "Phase 2 — backfill"],
  );
});

test("parsePhasesWithLines still counts `### Phase` under a real `## Phases` wrapper when NOT inside a fence", () => {
  // PR #557 / PR #562 wrapper case must continue to work — fence skipping must not regress it.
  const raw = [
    "# wrapper-with-background-fence",
    "",
    "## Background",
    "```",
    "### Phase 1 — fenced example",
    "### Phase 2 — fenced example",
    "```",
    "",
    "## Phases",
    "### Phase 1 — real-endpoint",
    "- src/app/api/foo/route.ts",
    "### Phase 2 — real-UI",
    "- src/app/dashboard/foo/page.tsx",
    "### Phase 3 — real-handler",
    "- src/lib/foo-handler.ts",
  ].join("\n");
  const phases = parsePhasesWithLines(raw);
  assert.equal(phases.length, 3);
  assert.deepEqual(
    phases.map((p) => p.title),
    ["Phase 1 — real-endpoint", "Phase 2 — real-UI", "Phase 3 — real-handler"],
  );
});

test("parsePhasesWithLines treats a ~~~ fence identically to a ``` fence", () => {
  const raw = [
    "# tilde-fence-spec",
    "",
    "## Phase 1 — real",
    "- src/lib/real.ts",
    "",
    "## Background",
    "~~~",
    "## Phase 1 — example",
    "## Phase 2 — example",
    "~~~",
  ].join("\n");
  const phases = parsePhasesWithLines(raw);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].title, "Phase 1 — real");
});
