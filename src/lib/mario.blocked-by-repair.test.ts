/**
 * Unit tests for the Phase-2 `blocked_by_repair` verb — mario-blocked-by-repair Phase 2. Pins the
 * verification bullets that are unit-testable without a live Supabase (the reopen-to-Vale re-read
 * is an integration assertion; the mode + loop-guard gates are inline in `applyBoxMario` and covered
 * by inspection):
 *
 *   1. a `blocked_by_repair` verdict `{ spec_slug, add_blocked_by:['foo'] }` yields a merged
 *      `blocked_by` that UNIONs `foo` in (no removal).
 *   2. a verdict with EMPTY `add_blocked_by` is REJECTED at the predicate (no write).
 *   3. a normalizer with an empty `add_blocked_by` (or empty spec_slug) returns null — the mutator
 *      never sees a partial payload.
 *   4. a normalizer strips `../specs/` prefixes / `.md` suffixes so a wikilink-shaped input matches
 *      the bare-slug expectation on `specs.blocked_by`.
 *   5. a merged set NEVER drops an existing blocker (additive-only invariant).
 *
 * Run:
 *   npx tsx --test src/lib/mario.blocked-by-repair.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeBlockedByForRepair, normalizeMarioVerdict } from "./mario";

test("Bullet 1 — add_blocked_by:['foo'] against existing:[] UNIONs foo in", () => {
  const decision = mergeBlockedByForRepair({ existing: [], add: ["foo"] });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.deepEqual(decision.merged, ["foo"]);
});

test("Bullet 1 (positive) — add_blocked_by:['foo'] against existing:['bar'] merges to ['bar','foo'] (existing preserved first)", () => {
  const decision = mergeBlockedByForRepair({ existing: ["bar"], add: ["foo"] });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.deepEqual(decision.merged, ["bar", "foo"]);
});

test("Bullet 1 (positive) — an entry already in existing is NOT double-added (de-duped)", () => {
  const decision = mergeBlockedByForRepair({ existing: ["foo", "bar"], add: ["foo", "baz"] });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.deepEqual(decision.merged, ["foo", "bar", "baz"]);
});

test("Bullet 2 — empty add_blocked_by is REJECTED at the predicate (no write)", () => {
  const decision = mergeBlockedByForRepair({ existing: ["foo"], add: [] });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "empty_add");
});

test("Bullet 2 — an add-list of ONLY whitespace strings is treated as empty (no phantom write)", () => {
  const decision = mergeBlockedByForRepair({ existing: ["foo"], add: ["   ", ""] });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "empty_add");
});

test("Bullet 5 — additive-only invariant: EVERY existing entry is present in the merged set", () => {
  const decision = mergeBlockedByForRepair({ existing: ["foo", "bar", "baz"], add: ["qux"] });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    for (const s of ["foo", "bar", "baz", "qux"]) assert.ok(decision.merged.includes(s), `merged missing ${s}`);
  }
});

test("Bullet 3 — normalizeMarioVerdict returns blocked_by_repair=null when add_blocked_by is empty", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "",
    blocked_by_repair: { spec_slug: "some-spec", add_blocked_by: [], reasoning: "empty" },
  });
  assert.ok(v !== null);
  assert.equal(v?.blocked_by_repair, null);
});

test("Bullet 3 — normalizeMarioVerdict returns blocked_by_repair=null when spec_slug is empty", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "",
    blocked_by_repair: { spec_slug: "", add_blocked_by: ["foo"], reasoning: "no slug" },
  });
  assert.ok(v !== null);
  assert.equal(v?.blocked_by_repair, null);
});

test("Bullet 3 — normalizeMarioVerdict passes a well-formed blocked_by_repair through", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "root",
    blocked_by_repair: {
      spec_slug: "some-spec",
      add_blocked_by: ["foo", "bar"],
      reasoning: "body names them but the column omits both",
    },
  });
  assert.ok(v !== null);
  assert.ok(v?.blocked_by_repair !== null);
  assert.equal(v?.blocked_by_repair?.spec_slug, "some-spec");
  assert.deepEqual(v?.blocked_by_repair?.add_blocked_by, ["foo", "bar"]);
});

test("Bullet 4 — normalizeMarioVerdict strips `../specs/` prefix and `.md` suffix (wikilink-shaped input)", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "root",
    blocked_by_repair: {
      spec_slug: "some-spec",
      add_blocked_by: ["../specs/foo.md", "  bar  "],
      reasoning: "wikilinky",
    },
  });
  assert.ok(v?.blocked_by_repair !== null);
  assert.deepEqual(v?.blocked_by_repair?.add_blocked_by, ["foo", "bar"]);
});

test("Bullet 3 — normalizeMarioVerdict de-dupes add_blocked_by entries", () => {
  const v = normalizeMarioVerdict({
    trigger_accurate: true,
    escalate: false,
    reasoning: "root",
    blocked_by_repair: { spec_slug: "some-spec", add_blocked_by: ["foo", "foo", "bar"], reasoning: "" },
  });
  assert.ok(v?.blocked_by_repair !== null);
  assert.deepEqual(v?.blocked_by_repair?.add_blocked_by, ["foo", "bar"]);
});
