/**
 * Unit tests for the upsertSpec runtime gate (harden-spec-submission). Pins the PURE decision half
 * (`computeUpsertAuthoringProblems`) — the floor that turns "author through author-spec.ts" from a
 * convention into an enforced invariant. A raw upsertSpec that would land a phase with empty
 * verification/why/what (the 2026-07 needs_fix batch class) is caught here.
 *
 * Pure helper — no I/O, no DB. Run:
 *   npx tsx --test src/lib/specs-table.upsert-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeUpsertAuthoringProblems,
  type ExistingPhaseForGate,
} from "@/lib/specs-table";

const full = { verification: "On /x expect 200", why: "w", what: "c" };
type PhaseOver = Partial<{ verification: string | null; why: string | null; what: string | null; title: string }>;
const phase = (position: number, over: PhaseOver = {}) => ({
  position,
  title: over.title ?? `Phase ${position}`,
  verification: "verification" in over ? (over.verification as string | null) : full.verification,
  why: "why" in over ? (over.why as string | null) : full.why,
  what: "what" in over ? (over.what as string | null) : full.what,
});
const NO_EXISTING = new Map<number, ExistingPhaseForGate>();

test("fully-authored fresh spec → no problems", () => {
  const problems = computeUpsertAuthoringProblems({ why: "w", what: "c" }, [phase(1), phase(2)], null, NO_EXISTING);
  assert.deepEqual(problems, []);
});

test("null verification on a fresh phase → flagged (the raw-upsertSpec bypass)", () => {
  const problems = computeUpsertAuthoringProblems(
    { why: "w", what: "c" },
    [phase(1, { verification: null })],
    null,
    NO_EXISTING,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /phase 1 .* has no verification/);
});

test("the 4-spec class: all phases null verification → one verification problem per phase", () => {
  const problems = computeUpsertAuthoringProblems(
    { why: "w", what: "c" },
    [phase(1, { verification: null }), phase(2, { verification: null })],
    null,
    NO_EXISTING,
  );
  // Only verification is a per-phase floor; per-phase why/what is NOT enforced (markdown lanes omit it).
  assert.equal(problems.length, 2);
  assert.ok(problems.every((p) => /has no verification/.test(p)));
});

test("per-phase why/what null is ALLOWED (markdown author path leaves phase intent NULL)", () => {
  const problems = computeUpsertAuthoringProblems(
    { why: "w", what: "c" },
    [phase(1, { why: null, what: null })], // verification present, phase intent absent
    null,
    NO_EXISTING,
  );
  assert.deepEqual(problems, []);
});

test("empty spec-level why/what → flagged", () => {
  const problems = computeUpsertAuthoringProblems({ why: "  ", what: "" }, [phase(1)], null, NO_EXISTING);
  assert.ok(problems.some((p) => /spec `why`/.test(p)));
  assert.ok(problems.some((p) => /spec `what`/.test(p)));
});

test("zero phases → flagged", () => {
  const problems = computeUpsertAuthoringProblems({ why: "w", what: "c" }, [], null, NO_EXISTING);
  assert.ok(problems.some((p) => /no phases/.test(p)));
});

test("preserve-update: OMITTED verification reads through to the stored non-empty value → no problem", () => {
  const existing = new Map<number, ExistingPhaseForGate>([
    [1, { verification: "On /x expect 200", why: "w", what: "c" }],
  ]);
  // Caller omits verification/why/what (undefined) on a status-only re-author of an already-gated phase.
  const problems = computeUpsertAuthoringProblems(
    { why: "w", what: "c" },
    [{ position: 1, title: "Phase 1", verification: undefined, why: undefined, what: undefined }],
    { why: "w", what: "c" },
    existing,
  );
  assert.deepEqual(problems, []);
});

test("preserve-update: OMITTED verification but the stored value is ALSO empty → still flagged (no false pass)", () => {
  const existing = new Map<number, ExistingPhaseForGate>([[1, { verification: null, why: null, what: null }]]);
  const problems = computeUpsertAuthoringProblems(
    { why: "w", what: "c" },
    [{ position: 1, title: "Phase 1", verification: undefined, why: undefined, what: undefined }],
    { why: "w", what: "c" },
    existing,
  );
  assert.equal(problems.length, 1); // only verification is a per-phase floor
  assert.match(problems[0], /has no verification/);
});

test("explicit null CLEARS even when a stored value exists → flagged (null ≠ preserve)", () => {
  const existing = new Map<number, ExistingPhaseForGate>([
    [1, { verification: "On /x expect 200", why: "w", what: "c" }],
  ]);
  const problems = computeUpsertAuthoringProblems(
    { why: "w", what: "c" },
    [{ position: 1, title: "Phase 1", verification: null, why: "w", what: "c" }],
    { why: "w", what: "c" },
    existing,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has no verification/);
});
