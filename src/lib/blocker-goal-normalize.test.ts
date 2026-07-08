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
  isReadyForGoalUnblock,
  type DependentCardForGoalUnblock,
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

// ─── Phase 2 — auto-queue-on-goal-unblock predicate (isReadyForGoalUnblock) ───────────────────────

/** Card shape helper — the SpecCard subset the Phase 2 predicate reads. */
function card(
  slug: string,
  overrides: Partial<DependentCardForGoalUnblock> = {},
): DependentCardForGoalUnblock {
  return {
    slug,
    status: "planned",
    blockedBy: [],
    ...overrides,
  };
}

test("Phase 2 verification: a standalone spec blocked on goal G stays blocked while G.main_merge_sha is null (goal blocker not cleared)", () => {
  // The named failing state: every member of G is on the goal branch, but main_merge_sha is null —
  // so resolveBlockedBy leaves the goal blocker `cleared:false`. The predicate MUST refuse the
  // enqueue.
  const dep = card("outside-standalone", {
    blockedBy: [{ slug: "goal-g", cleared: false, kind: "goal" }],
  });
  assert.equal(
    isReadyForGoalUnblock(dep, "goal-g"),
    false,
    "goal main_merge_sha null → goal blocker uncleared → dependent stays blocked",
  );
});

test("Phase 2 verification: the moment G.main_merge_sha is set (goal blocker becomes cleared) the dependent is ready to auto-queue", () => {
  // Same card, now the goal blocker is `cleared:true` (resolveBlockedBy keyed it on
  // goals.main_merge_sha which just got stamped). The predicate MUST accept the enqueue.
  const dep = card("outside-standalone", {
    blockedBy: [{ slug: "goal-g", cleared: true, kind: "goal" }],
  });
  assert.equal(isReadyForGoalUnblock(dep, "goal-g"), true);
});

test("Phase 2: a dependent blocked on BOTH goal G (just shipped) AND a still-uncleared external spec stays blocked", () => {
  // Multi-blocker case — the goal-ship clears its own leg but the sibling spec-slug blocker is still
  // in flight. The dependent MUST stay blocked (only every-cleared is enqueue-eligible).
  const dep = card("outside-standalone", {
    blockedBy: [
      { slug: "goal-g", cleared: true, kind: "goal" },
      { slug: "still-uncleared-spec", cleared: false, kind: "spec" },
    ],
  });
  assert.equal(isReadyForGoalUnblock(dep, "goal-g"), false);
});

test("Phase 2: a card that names a DIFFERENT goal (not `goalSlug`) is not selected — the fan-out is scoped to the ship that just happened", () => {
  const dep = card("outside-standalone", {
    blockedBy: [{ slug: "goal-h", cleared: true, kind: "goal" }],
  });
  assert.equal(
    isReadyForGoalUnblock(dep, "goal-g"),
    false,
    "unrelated goal's ship must not fan-out this card",
  );
});

test("Phase 2: a card with autoBuild=false is opted out — never auto-queued even when every blocker is cleared", () => {
  const dep = card("outside-standalone", {
    autoBuild: false,
    blockedBy: [{ slug: "goal-g", cleared: true, kind: "goal" }],
  });
  assert.equal(isReadyForGoalUnblock(dep, "goal-g"), false);
});

test("Phase 2: an already-shipped card is never re-queued (idempotent guard)", () => {
  const dep = card("outside-standalone", {
    status: "shipped",
    blockedBy: [{ slug: "goal-g", cleared: true, kind: "goal" }],
  });
  assert.equal(isReadyForGoalUnblock(dep, "goal-g"), false);
});

test("Phase 2: a card with no blockedBy is not selected — the fan-out only re-releases blocked-on-THIS-goal cards", () => {
  const dep = card("outside-standalone", { blockedBy: [] });
  assert.equal(
    isReadyForGoalUnblock(dep, "goal-g"),
    false,
    "no goal blocker → no relationship to this goal → not our concern",
  );
});

test("Phase 2: a spec-slug blocker (kind:'spec') on `goal-g` doesn't count as a goal blocker — the discriminant matters", () => {
  // Edge case: a raw spec-slug blocker whose slug HAPPENS to be `goal-g`. Without the kind
  // discriminant, we'd falsely treat this as a goal blocker. The predicate MUST require kind==="goal".
  const dep = card("outside-standalone", {
    blockedBy: [{ slug: "goal-g", cleared: true, kind: "spec" }],
  });
  assert.equal(isReadyForGoalUnblock(dep, "goal-g"), false);
});
