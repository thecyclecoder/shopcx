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
import { checkRepairBlockedByScope, mergeBlockedByForRepair, normalizeMarioVerdict } from "./mario";

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

/**
 * scope-mario-blocked-by-repair-target Phase 1 — the security gate. The pure `checkRepairBlockedByScope`
 * predicate is the exact boundary the applier (`repairSpecBlockedBy`) throws on before calling
 * `authorSpecRowStructured` — an `ok: false` verdict is what the applier's catch stamps to
 * `mario_fired.metadata.blocked_by_repair_error` without a write. The three verification bullets pin the
 * security invariants: (1) a slug-mismatched verdict is rejected before any read/write side-effect (the
 * LLM can't retarget the repair to a sibling spec), (2) an add_blocked_by entry outside the derived
 * missing set (current body `**Blocked-by:**` prerequisites minus current `specs.blocked_by`) is rejected
 * (the LLM can't invent a prerequisite the spec body never declared), and (3) a valid same-slug repair
 * whose add-list is exactly a currently missing body-declared blocker passes the gate and the additive
 * `mergeBlockedByForRepair` still merges it (the same-slug positive path — re-authoring via
 * `authorSpecRowStructured` re-opens the spec to Vale through `markSpecCardBackToReview`, which is an
 * integration-level assertion inspected in the applier).
 */
const NOW = 100_000_000;
const OVER_GRACE = 60 * 60 * 1000 + 1;
const validSpec = (over: Partial<Parameters<typeof checkRepairBlockedByScope>[0]["spec"]> = {}) => ({
  status: "in_review" as string | null,
  updated_at: new Date(NOW - OVER_GRACE).toISOString(),
  body: "Title\n\n**Blocked-by:** [[foo]], [[bar]]\n\n## Phase 1 — do the thing",
  blocked_by: ["bar"], // foo is the currently-MISSING body-declared prerequisite
  phases: [{ kind: "phase" as string, verification: "run npx tsc --noEmit" as string | null }],
  ...over,
});

test("SECURITY Bullet 1 — spec_slug mismatch is rejected BEFORE any write side-effect", () => {
  const scope = checkRepairBlockedByScope({
    jobSpecSlug: "the-surfaced-spec",
    repair: { spec_slug: "some-other-spec", add_blocked_by: ["foo"], reasoning: "unrelated" },
    spec: validSpec(),
    graceMs: 60 * 60 * 1000,
    now: NOW,
  });
  assert.equal(scope.ok, false);
  if (!scope.ok) assert.match(scope.reason, /^spec_slug_mismatch:/);
});

test("SECURITY Bullet 2 — add_blocked_by entry NOT in the current body Blocked-by line is rejected", () => {
  const scope = checkRepairBlockedByScope({
    jobSpecSlug: "the-surfaced-spec",
    repair: { spec_slug: "the-surfaced-spec", add_blocked_by: ["invented-prereq"], reasoning: "fabricated" },
    spec: validSpec(),
    graceMs: 60 * 60 * 1000,
    now: NOW,
  });
  assert.equal(scope.ok, false);
  if (!scope.ok) assert.match(scope.reason, /^add_not_in_missing_set: invented-prereq$/);
});

test("SECURITY Bullet 2 — add_blocked_by entry named in the body but ALREADY present on the row (not missing) is rejected", () => {
  // 'bar' is in the body Blocked-by line AND already on `specs.blocked_by` → NOT in the derived missing set.
  const scope = checkRepairBlockedByScope({
    jobSpecSlug: "the-surfaced-spec",
    repair: { spec_slug: "the-surfaced-spec", add_blocked_by: ["bar"], reasoning: "already there" },
    spec: validSpec(),
    graceMs: 60 * 60 * 1000,
    now: NOW,
  });
  assert.equal(scope.ok, false);
  if (!scope.ok) assert.match(scope.reason, /^add_not_in_missing_set: bar$/);
});

test("SECURITY Bullet 3 — valid same-slug repair with add_blocked_by matching a currently missing body-declared blocker PASSES the gate + still merges", () => {
  const spec = validSpec();
  const scope = checkRepairBlockedByScope({
    jobSpecSlug: "the-surfaced-spec",
    repair: { spec_slug: "the-surfaced-spec", add_blocked_by: ["foo"], reasoning: "body declares foo but row omits it" },
    spec,
    graceMs: 60 * 60 * 1000,
    now: NOW,
  });
  assert.equal(scope.ok, true);
  if (scope.ok) assert.deepEqual(scope.missingSet, ["foo"]);
  // The additive merge still fires — the applier calls `mergeBlockedByForRepair` after the scope gate
  // passes, and the merged set is what `authorSpecRowStructured` writes; the re-author is what re-opens
  // the spec to Vale via `markSpecCardBackToReview`.
  const merged = mergeBlockedByForRepair({ existing: spec.blocked_by, add: ["foo"] });
  assert.equal(merged.ok, true);
  if (merged.ok) assert.deepEqual(merged.merged, ["bar", "foo"]);
});

test("SECURITY — folded/deferred spec: scope predicate rejects (out-of-class) even with a valid same-slug add", () => {
  const scope = checkRepairBlockedByScope({
    jobSpecSlug: "the-surfaced-spec",
    repair: { spec_slug: "the-surfaced-spec", add_blocked_by: ["foo"], reasoning: "already-folded" },
    spec: validSpec({ status: "folded" }),
    graceMs: 60 * 60 * 1000,
    now: NOW,
  });
  assert.equal(scope.ok, false);
  if (!scope.ok) assert.equal(scope.reason, "not_missing_blocker_class");
});

test("SECURITY — missing spec (spec: null): scope predicate rejects with spec_not_found (LLM can't invent a target)", () => {
  const scope = checkRepairBlockedByScope({
    jobSpecSlug: "the-surfaced-spec",
    repair: { spec_slug: "the-surfaced-spec", add_blocked_by: ["foo"], reasoning: "" },
    spec: null,
    graceMs: 60 * 60 * 1000,
    now: NOW,
  });
  assert.equal(scope.ok, false);
  if (!scope.ok) assert.match(scope.reason, /^spec_not_found: the-surfaced-spec$/);
});

test("SECURITY — spec whose body has no `**Blocked-by:**` line: scope predicate rejects (nothing declared → nothing to repair)", () => {
  const scope = checkRepairBlockedByScope({
    jobSpecSlug: "the-surfaced-spec",
    repair: { spec_slug: "the-surfaced-spec", add_blocked_by: ["foo"], reasoning: "" },
    spec: validSpec({ body: "Title\n\n## Phase 1 — do the thing" }),
    graceMs: 60 * 60 * 1000,
    now: NOW,
  });
  assert.equal(scope.ok, false);
  if (!scope.ok) assert.equal(scope.reason, "not_missing_blocker_class");
});
