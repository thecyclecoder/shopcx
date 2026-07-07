/**
 * Unit test for the goal-bound Parent-prose derivation (single-source-of-truth from milestone_id).
 * Pins that the projected Parent line always ANCHORS to the milestone and NEVER reads as a bare goal —
 * the systematic 2026-07 planner bounce (milestone_id set, prose written bare-goal, Vale bounced all 14).
 *
 * Pure formatter — no I/O. Run: npx tsx --test src/lib/author-spec-parent-derive.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatMilestoneParentProse } from "./author-spec";

test("Parent prose anchors to the milestone and names it", () => {
  assert.equal(
    formatMilestoneParentProse("guaranteed-ticket-handling", 3, "Right-cost routing"),
    '[[../goals/guaranteed-ticket-handling#right-cost-routing]] — M3 "Right-cost routing" milestone.',
  );
});

test("never renders as a bare goal — always carries a #milestone anchor + 'milestone' + Mn", () => {
  for (const [pos, title] of [[1, "Truthful actions"], [2, "The resolution record (the spine)"], [5, "The autonomous CS Director"]] as const) {
    const p = formatMilestoneParentProse("g", pos, title);
    assert.match(p, /#[a-z0-9-]+\]\]/, "has a milestone anchor fragment");
    assert.match(p, /\bmilestone\.$/, "names it a milestone");
    assert.match(p, new RegExp(`M${pos}\\b`), "carries the Mn ordinal");
    assert.doesNotMatch(p, /^\[\[\.\.\/goals\/[a-z-]+\]\]/, "is not a bare-goal wikilink");
  }
});
