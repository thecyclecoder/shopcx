/**
 * The pre-merge fix-force guard. A pending `kind='fix'` phase forces a re-test past the terminal-verdict
 * dedup only when the phase changed after the latest run on the branch. Before this guard an authored but
 * never-built fix phase forced a re-test on every standing pass (321 identical runs in ~28h, 2026-10-07/08).
 *
 * Run:
 *   npx tsx --test src/lib/agent-jobs.premerge-fix-force.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fixPhaseChangedSinceLatestRun, isFoldBlockingLiveJob } from "./agent-jobs";

const RUN = "2026-10-08T16:00:00Z";
const phase = (kind: string, status: string, updated_at: string) => ({ kind, status, updated_at });

test("no fix phase → no force", () => {
  assert.equal(fixPhaseChangedSinceLatestRun([phase("phase", "planned", "2026-10-08T17:00:00Z")], RUN), false);
});

test("pending fix phase untouched since the latest run → no force (the loop case)", () => {
  assert.equal(fixPhaseChangedSinceLatestRun([phase("fix", "planned", "2026-09-26T18:41:22Z")], RUN), false);
});

test("pending fix phase updated after the latest run → force", () => {
  assert.equal(fixPhaseChangedSinceLatestRun([phase("fix", "planned", "2026-10-08T16:05:00Z")], RUN), true);
});

test("pending fix phase and no run yet → force", () => {
  assert.equal(fixPhaseChangedSinceLatestRun([phase("fix", "planned", "2026-09-26T18:41:22Z")], null), true);
});

test("shipped or rejected fix phases never force", () => {
  const phases = [phase("fix", "shipped", "2026-10-08T17:00:00Z"), phase("fix", "rejected", "2026-10-08T17:00:00Z")];
  assert.equal(fixPhaseChangedSinceLatestRun(phases, RUN), false);
});

test("unparseable run timestamp → no force", () => {
  assert.equal(fixPhaseChangedSinceLatestRun([phase("fix", "planned", "2026-10-08T17:00:00Z")], "garbage"), false);
});

// isFoldBlockingLiveJob — a broken-check card is advisory and never holds a shipped spec's fold.

test("a running build holds the fold", () => {
  assert.equal(isFoldBlockingLiveJob({ status: "building" }), true);
});

test("a needs_approval card carrying only broken_check escalations does not hold the fold", () => {
  assert.equal(isFoldBlockingLiveJob({ status: "needs_approval", pending_actions: [{ type: "broken_check" }] }), false);
});

test("a needs_approval card with a real gated action still holds the fold", () => {
  assert.equal(isFoldBlockingLiveJob({ status: "needs_approval", pending_actions: [{ type: "broken_check" }, { type: "apply_migration" }] }), true);
  assert.equal(isFoldBlockingLiveJob({ status: "needs_approval", pending_actions: [] }), true);
});
