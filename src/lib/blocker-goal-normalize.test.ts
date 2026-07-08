/**
 * one-off-spec-depending-on-goal-work-blocks-on-the-goal-not-the-member-spec Phase 1 —
 * pins the NAMED failing state from the Phase 1 verification: a standalone spec whose `blocked_by`
 * entry names a spec that is a MEMBER of goal G (where the standalone spec is NOT in G) must report
 * an EFFECTIVE blocker on G — not on the member spec. A goal-mate dependency (dependent + blocker in
 * the SAME goal) is UNCHANGED (the intra-goal serializer handles it).
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/blocker-goal-normalize.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveEffectiveBlocker,
  deriveEffectiveBlockers,
  type GoalMembership,
} from "./blocker-goal-normalize";

const goalG: GoalMembership = { goalSlug: "goal-g", goalTitle: "Goal G", mainMergeSha: null };
const goalH: GoalMembership = { goalSlug: "goal-h", goalTitle: "Goal H", mainMergeSha: null };
const goalGShipped: GoalMembership = { goalSlug: "goal-g", goalTitle: "Goal G", mainMergeSha: "abc123" };

// A workspace whose goals G and H each own two member specs.
const goalMap: ReadonlyMap<string, GoalMembership> = new Map<string, GoalMembership>([
  ["g-member-a", goalG],
  ["g-member-b", goalG],
  ["h-member-a", goalH],
]);

test("Phase 1 verification: outside dependent blocked by a goal-member reports the goal as the effective blocker", () => {
  const eff = deriveEffectiveBlocker(
    "g-member-a",
    { slug: "outside-standalone", goalSlug: null },
    goalMap,
  );
  assert.equal(eff.kind, "goal");
  if (eff.kind === "goal") {
    assert.equal(eff.slug, "goal-g");
    assert.equal(eff.title, "Goal G");
    assert.equal(eff.memberSpecSlug, "g-member-a", "the ORIGINAL spec slug is preserved for the re-author write-back");
    assert.equal(eff.mainMergeSha, null, "Phase 2's clear predicate reads this; null while the goal has not landed on main");
  }
});

test("Phase 1 verification: dependent in a DIFFERENT goal (H) blocked by a member of G reports G as the effective blocker (not a goal-mate)", () => {
  const eff = deriveEffectiveBlocker(
    "g-member-a",
    { slug: "h-member-a", goalSlug: "goal-h" },
    goalMap,
  );
  assert.equal(eff.kind, "goal");
  if (eff.kind === "goal") assert.equal(eff.slug, "goal-g");
});

test("goal-mate dependency is UNCHANGED: both dependent + blocker in G → the blocker stays a spec blocker (the intra-goal serializer handles it)", () => {
  const eff = deriveEffectiveBlocker(
    "g-member-a",
    { slug: "g-member-b", goalSlug: "goal-g" },
    goalMap,
  );
  assert.equal(eff.kind, "spec");
  if (eff.kind === "spec") assert.equal(eff.slug, "g-member-a");
});

test("a one-off blocker (blocker is NOT a goal-member) stays a spec blocker for any dependent", () => {
  const eff = deriveEffectiveBlocker(
    "one-off-blocker",
    { slug: "outside-standalone", goalSlug: null },
    goalMap,
  );
  assert.equal(eff.kind, "spec");
  if (eff.kind === "spec") assert.equal(eff.slug, "one-off-blocker");
});

test("mainMergeSha threads through to the effective goal blocker so Phase 2 can key the cleared predicate on it", () => {
  const shippedMap = new Map<string, GoalMembership>([["g-member-a", goalGShipped]]);
  const eff = deriveEffectiveBlocker(
    "g-member-a",
    { slug: "outside-standalone", goalSlug: null },
    shippedMap,
  );
  assert.equal(eff.kind, "goal");
  if (eff.kind === "goal") assert.equal(eff.mainMergeSha, "abc123");
});

test("batched: two blockers that are BOTH members of the same goal collapse to ONE goal blocker for an outside dependent", () => {
  const list = deriveEffectiveBlockers(
    ["g-member-a", "g-member-b"],
    { slug: "outside-standalone", goalSlug: null },
    goalMap,
  );
  assert.equal(list.length, 1, "two edges to the same goal collapse to one");
  assert.equal(list[0].kind, "goal");
  if (list[0].kind === "goal") assert.equal(list[0].slug, "goal-g");
});

test("batched: goal-mate + external-goal-member mix → goal-mate stays a spec blocker, external goal-member becomes a goal blocker (order preserved)", () => {
  const list = deriveEffectiveBlockers(
    ["g-member-b", "h-member-a"],
    { slug: "g-member-a", goalSlug: "goal-g" },
    goalMap,
  );
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, "spec", "goal-mate g-member-b stays spec");
  if (list[0].kind === "spec") assert.equal(list[0].slug, "g-member-b");
  assert.equal(list[1].kind, "goal", "external h-member-a normalizes to goal H");
  if (list[1].kind === "goal") assert.equal(list[1].slug, "goal-h");
});

test("batched: two distinct one-off spec blockers do NOT dedup — they name different specs", () => {
  const list = deriveEffectiveBlockers(
    ["one-off-a", "one-off-b"],
    { slug: "outside-standalone", goalSlug: null },
    goalMap,
  );
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, "spec");
  assert.equal(list[1].kind, "spec");
});

test("batched: empty / non-string entries are silently dropped (never throws, never emits a bogus blocker)", () => {
  const list = deriveEffectiveBlockers(
    ["", "g-member-a"] as unknown as readonly string[],
    { slug: "outside-standalone", goalSlug: null },
    goalMap,
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "goal");
});

test("self-block (a spec blocking itself) stays a spec blocker — the read path is lenient; the author-time diagnoser flags it upstream", () => {
  const eff = deriveEffectiveBlocker(
    "outside-standalone",
    { slug: "outside-standalone", goalSlug: null },
    goalMap,
  );
  assert.equal(eff.kind, "spec");
});
