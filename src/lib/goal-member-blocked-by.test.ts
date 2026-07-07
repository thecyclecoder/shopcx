/**
 * pia-decomposition-emits-plain-slug-blocked-by Phase 2 — pure diagnoser tests.
 *
 * Pins the named failing states from the Phase 2 verification:
 *   - The validation FLAGS a namespaced / unresolvable `blocked_by` entry.
 *   - The Sol-goal members (all plain-slug goal-members) PASS with zero flags.
 *   - A repaired member's stored list normalizes to plain slugs the goal-mate gate can resolve, so
 *     `repairedBlockedByList` yields the plain form the caller writes via `setSpecBlockers` — which
 *     lets the existing `areSpecsGoalMates` + Kahn sort in `src/lib/agent-jobs.ts` hold the
 *     dependent until its blocker ships.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/goal-member-blocked-by.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseGoalMemberBlockedByEntry,
  diagnoseGoalMemberBlockedByList,
  repairedBlockedByList,
} from "./goal-member-blocked-by";

const solMembers = new Set(["sol-cheap-execution-over-ticket-direction", "sol-ticket-direction-artifact"]);

test("flag: namespaced goalSlug:specSlug on a non-member normalized form → flagged (Bo guard: never rewrite to a cross-goal slug)", () => {
  const d = diagnoseGoalMemberBlockedByEntry(
    "wrong-goal:sol-ticket-direction-artifact",
    "sol-cheap-execution-over-ticket-direction",
    // membership set that does NOT contain the normalized target — the guard flags rather than repairs.
    new Set(["sol-cheap-execution-over-ticket-direction"]),
  );
  // The normalized form (`sol-ticket-direction-artifact`) is NOT in the member set for this contrived case,
  // so the diagnoser must flag it — a namespaced entry whose plain form isn't a goal-member is drift, not
  // a safe repair.
  assert.equal(d.status, "flag");
});

test("repair: namespaced goalSlug:specSlug whose plain form IS a goal-member → repair candidate (the Sol case)", () => {
  const d = diagnoseGoalMemberBlockedByEntry(
    "sol-agent-boot-goal:sol-ticket-direction-artifact",
    "sol-cheap-execution-over-ticket-direction",
    solMembers,
  );
  assert.equal(d.status, "repair");
  if (d.status === "repair") {
    assert.equal(d.plain, "sol-ticket-direction-artifact");
    assert.match(d.reason, /persist plain slug/);
  }
});

test("ok: plain slug that is a goal-member → passes (Sol-goal members named directly)", () => {
  const d = diagnoseGoalMemberBlockedByEntry(
    "sol-ticket-direction-artifact",
    "sol-cheap-execution-over-ticket-direction",
    solMembers,
  );
  assert.equal(d.status, "ok");
  if (d.status === "ok") assert.equal(d.plain, "sol-ticket-direction-artifact");
});

test("flag: plain slug that is NOT a goal-member → flagged (cross-goal / unknown)", () => {
  const d = diagnoseGoalMemberBlockedByEntry(
    "some-other-spec",
    "sol-cheap-execution-over-ticket-direction",
    solMembers,
  );
  assert.equal(d.status, "flag");
  if (d.status === "flag") assert.match(d.reason, /not a member of this goal/);
});

test("flag: self-slug (a spec cannot block itself) → flagged regardless of namespacing", () => {
  const d = diagnoseGoalMemberBlockedByEntry(
    "sol-cheap-execution-over-ticket-direction",
    "sol-cheap-execution-over-ticket-direction",
    solMembers,
  );
  assert.equal(d.status, "flag");
  if (d.status === "flag") assert.match(d.reason, /self-block/);
});

test("flag: junk / empty / non-string → flagged, never silently dropped", () => {
  for (const [raw, why] of [
    ["", "empty"],
    ["   ", "empty"],
    ["Not_A_Slug", "kebab"],
    ["[[]]", "kebab"],
  ] as const) {
    const d = diagnoseGoalMemberBlockedByEntry(raw, "self", solMembers);
    assert.equal(d.status, "flag", `expected flag for "${raw}"`);
    if (d.status === "flag") assert.ok(new RegExp(why, "i").test(d.reason), `reason for "${raw}" mentions "${why}"`);
  }
  const d2 = diagnoseGoalMemberBlockedByEntry(42 as unknown, "self", solMembers);
  assert.equal(d2.status, "flag");
});

test("list: Sol-goal members already fixed by hand → zero flags, zero repairs, ok holds", () => {
  // The named passing state: both Sol members reference each other by plain slug (the manual fix).
  const drift = diagnoseGoalMemberBlockedByList(
    ["sol-ticket-direction-artifact"],
    "sol-cheap-execution-over-ticket-direction",
    solMembers,
  );
  assert.deepEqual(drift.ok, ["sol-ticket-direction-artifact"]);
  assert.deepEqual(drift.repair, []);
  assert.deepEqual(drift.flag, []);
});

test("list: mixed drift → partitions into ok / repair / flag with order-preserving dedup on plain slug", () => {
  const drift = diagnoseGoalMemberBlockedByList(
    [
      "sol-agent-boot-goal:sol-ticket-direction-artifact", // repair
      "[[sol-ticket-direction-artifact]]", // duplicate after normalization — deduped against the repair
      "sol-cheap-execution-over-ticket-direction", // self — flag
      "cross-goal-slug", // flag (not a member)
      "", // flag
    ],
    "sol-cheap-execution-over-ticket-direction",
    solMembers,
  );
  assert.deepEqual(drift.ok, []);
  assert.equal(drift.repair.length, 1);
  assert.equal(drift.repair[0].plain, "sol-ticket-direction-artifact");
  // The dupe wikilink was collapsed against the first repair — it does NOT get a second row.
  assert.equal(drift.flag.length, 3); // self + cross-goal + empty
});

test("list: non-array input → empty drift (no work), never throws", () => {
  const d = diagnoseGoalMemberBlockedByList(undefined, "s", solMembers);
  assert.deepEqual(d, { slug: "s", ok: [], repair: [], flag: [] });
});

test("repairedBlockedByList: ok slugs first (preserved order), then repair plain slugs, deduped", () => {
  const drift = diagnoseGoalMemberBlockedByList(
    ["sol-ticket-direction-artifact", "sol-agent-boot-goal:sol-ticket-direction-artifact"],
    "sol-cheap-execution-over-ticket-direction",
    solMembers,
  );
  // The plain entry consumes the plain slot; the namespaced dupe is deduped out entirely.
  const list = repairedBlockedByList(drift);
  assert.deepEqual(list, ["sol-ticket-direction-artifact"]);
});
