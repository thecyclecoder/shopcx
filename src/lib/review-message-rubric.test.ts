/**
 * Unit tests pinning the pure half of the review-message-rubric SDK
 * (Phase 2 of review-request-sol-session). The `parseRubricRow` shape guard
 * is what protects Sol's self-scoring + the QC session from silently
 * shipping a mis-shaped rubric row, so every rejection reason has a test
 * that asserts the exact throw path.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  formatRubricForPrompt,
  parseRubricRow,
  INITIAL_REVIEW_RUBRIC_CRITERION_COUNT,
  INITIAL_REVIEW_RUBRIC_FLOOR,
  INITIAL_REVIEW_RUBRIC_VERSION,
} from "./review-message-rubric";

// A well-formed row shape that mirrors what `.select("*")` returns from
// `review_message_rubrics` for the seeded v1 row.
const goodRow = {
  id: "00000000-0000-0000-0000-000000000001",
  workspace_id: "10000000-0000-0000-0000-000000000000",
  version: 1,
  floor: 75,
  is_active: true,
  notes: "seed",
  criteria: [
    { key: "ask_is_question", weight: 15, instruction: "…" },
    { key: "named_person_position", weight: 15, instruction: "…" },
    { key: "status_reversal", weight: 15, instruction: "…" },
    { key: "founder_plain_voice", weight: 15, instruction: "…" },
    { key: "earned_identity_priming", weight: 10, instruction: "…" },
    { key: "fact_in_first_two_lines", weight: 10, instruction: "…" },
    { key: "time_cost_no_friction", weight: 10, instruction: "…" },
    { key: "continuity_with_thread", weight: 10, instruction: "…" },
  ],
};

test("initial rubric constants pin the spec's shape", () => {
  assert.equal(INITIAL_REVIEW_RUBRIC_VERSION, 1);
  assert.equal(INITIAL_REVIEW_RUBRIC_FLOOR, 75);
  assert.equal(INITIAL_REVIEW_RUBRIC_CRITERION_COUNT, 8);
});

test("parseRubricRow — a well-formed v1 row parses cleanly", () => {
  const r = parseRubricRow(goodRow);
  assert.equal(r.workspaceId, goodRow.workspace_id);
  assert.equal(r.version, 1);
  assert.equal(r.floor, 75);
  assert.equal(r.criteria.length, 8);
  const total = r.criteria.reduce((n, c) => n + c.weight, 0);
  assert.equal(total, 100);
});

test("parseRubricRow — rejects null/non-object input", () => {
  assert.throws(() => parseRubricRow(null), /not an object/);
  assert.throws(() => parseRubricRow(42 as unknown as object), /not an object/);
});

test("parseRubricRow — rejects a missing id", () => {
  const bad = { ...goodRow, id: "" };
  assert.throws(() => parseRubricRow(bad), /missing id/);
});

test("parseRubricRow — rejects a non-positive version", () => {
  const bad = { ...goodRow, version: 0 };
  assert.throws(() => parseRubricRow(bad), /positive integer/);
});

test("parseRubricRow — rejects a floor outside [0, 100]", () => {
  const bad = { ...goodRow, floor: 120 };
  assert.throws(() => parseRubricRow(bad), /floor/);
});

test("parseRubricRow — rejects an empty criteria array", () => {
  const bad = { ...goodRow, criteria: [] };
  assert.throws(() => parseRubricRow(bad), /non-empty array/);
});

test("parseRubricRow — rejects a criterion whose weight does not sum to 100", () => {
  const bad = { ...goodRow, criteria: goodRow.criteria.slice(0, 7) }; // 90, not 100
  assert.throws(() => parseRubricRow(bad), /sum to 90/);
});

test("parseRubricRow — rejects a criterion with a missing instruction", () => {
  const bad = {
    ...goodRow,
    criteria: goodRow.criteria.map((c, i) =>
      i === 0 ? { ...c, instruction: "" } : c,
    ),
  };
  assert.throws(() => parseRubricRow(bad), /missing instruction/);
});

test("parseRubricRow — rejects a criterion with a non-positive weight", () => {
  const bad = {
    ...goodRow,
    criteria: goodRow.criteria.map((c, i) =>
      i === 0 ? { ...c, weight: 0 } : c,
    ),
  };
  assert.throws(() => parseRubricRow(bad), /non-positive weight/);
});

test("formatRubricForPrompt — the rendered block quotes the version + floor + every criterion", () => {
  const r = parseRubricRow(goodRow);
  const text = formatRubricForPrompt(r);
  assert.ok(text.includes("v1"));
  assert.ok(text.includes("floor 75"));
  for (const c of r.criteria) {
    assert.ok(text.includes(c.key), `missing key ${c.key}`);
    assert.ok(text.includes(`(${c.weight})`), `missing weight ${c.weight}`);
  }
});
