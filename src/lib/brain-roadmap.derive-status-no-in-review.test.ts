/**
 * Phase 2 of [[../../docs/brain/specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]] —
 * pin the retirement invariant: `deriveSpecCardStatus` MUST NEVER emit `in_review`. A fresh, phased,
 * well-formed spec derives `planned` / `in_progress` via the phase rollup — no matter what `vale_pass`
 * / `vale_review_passed_at` look like on the DB row (the LLM lane is gone; those columns are legacy
 * residue and not read as a status signal anymore).
 *
 * Also pins that `deferred` / `folded` overrides survive Phase 2 (they are first-class lifecycle states,
 * not derived from Vale).
 *
 * Run:
 *   npm run test:derive-status-no-in-review
 *   (= tsx --test src/lib/brain-roadmap.derive-status-no-in-review.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveSpecCardStatus, type SpecPhase } from "./brain-roadmap";
import type { SpecRow } from "./specs-table";

/** Minimal SpecRow builder — populate only what deriveSpecCardStatus reads; rest as legit nulls. */
function makeRow(overrides: Partial<SpecRow> = {}): SpecRow {
  const now = "2026-07-11T00:00:00Z";
  return {
    id: "row-1",
    workspace_id: "ws-1",
    slug: "my-spec",
    title: "My Spec",
    summary: null,
    owner: "platform",
    parent: "[[../functions/platform]]",
    parent_kind: null,
    parent_ref: null,
    blocked_by: [],
    priority: null,
    deferred: false,
    intended_status: "planned",
    intended_status_set_by: null,
    status: null,
    repair_signature: null,
    regression_of_slug: null,
    regression_signature: null,
    related_spec: null,
    auto_build: true,
    milestone_id: null,
    merged_pr: null,
    last_merge_sha: null,
    goal_branch_sha: null,
    vale_pass: null,
    vale_review_passed_at: null,
    ada_disposition: null,
    vale_disposition: null,
    vale_disposition_reason: null,
    why: "why text",
    what: "what text",
    created_at: now,
    updated_at: now,
    phases: [],
    ...overrides,
  };
}

test("Phase 2 invariant — a fresh phased spec derives `planned`, NEVER `in_review`", () => {
  const row = makeRow({ vale_review_passed_at: null, vale_pass: null });
  const phases: SpecPhase[] = [
    { title: "Phase 1", status: "planned" },
    { title: "Phase 2", status: "planned" },
  ];
  const derived = deriveSpecCardStatus(row, phases);
  assert.equal(derived, "planned", `expected planned, got: ${derived}`);
});

test("Phase 2 invariant — a spec with any in_progress phase derives `in_progress`, NEVER `in_review`", () => {
  const row = makeRow({ vale_review_passed_at: null, vale_pass: null });
  const phases: SpecPhase[] = [
    { title: "Phase 1", status: "in_progress" },
    { title: "Phase 2", status: "planned" },
  ];
  const derived = deriveSpecCardStatus(row, phases);
  assert.equal(derived, "in_progress");
});

test("Phase 2 invariant — a one-shot spec with no phases + no merge derives `planned`, NEVER `in_review`", () => {
  const row = makeRow({ vale_review_passed_at: null, vale_pass: null, merged_pr: null, last_merge_sha: null });
  const derived = deriveSpecCardStatus(row, []);
  assert.equal(derived, "planned");
});

test("`deferred` override still fires (not retired)", () => {
  const row = makeRow({ deferred: true });
  const derived = deriveSpecCardStatus(row, [{ title: "Phase 1", status: "planned" }]);
  assert.equal(derived, "deferred");
});

test("`folded` override still projects to `shipped` (not retired)", () => {
  const row = makeRow({ status: "folded" });
  const derived = deriveSpecCardStatus(row, [{ title: "Phase 1", status: "planned" }]);
  assert.equal(derived, "shipped");
});

test("A shipped one-shot spec (merged_pr set, no phases) derives `shipped`", () => {
  const row = makeRow({ merged_pr: 1234, vale_review_passed_at: null, vale_pass: null });
  const derived = deriveSpecCardStatus(row, []);
  assert.equal(derived, "shipped");
});
