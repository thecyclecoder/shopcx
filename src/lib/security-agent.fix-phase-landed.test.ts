/**
 * a-branch-security-review-is-fresh-only-for-the-exact-head-sha-it-reviewed Phase 4 pins the fix-landed
 * direct-enqueue path:
 *
 *   1. `retestBranchSecurityIfFixPhaseLanded` (agent-jobs.ts) — the new sibling of the merge-based
 *      `retestOriginBranchSecurityIfFixMerged` — fires from `finalizeBuiltPhase` after `git push` lands
 *      a fix phase's build on the origin's branch. It reads each just-stamped phase's
 *      `metadata.security_review_job_id` and DIRECTLY enqueues a fresh branch-mode security review with
 *      `force: true` when any match — no dependence on the Phase-2 SHA freshness heuristic to infer the
 *      branch moved.
 *
 *   2. `spawnPreMergeFix` (pre-merge-fix.ts) accepts `securityReviewJobId` and stamps it onto each
 *      appended fix phase's `metadata.security_review_job_id` — the two-way link the landing side reads.
 *
 *   3. The security caller (scripts/builder-worker.ts `applySecurityVerdictToJob` branch-mode real-vuln
 *      arm) passes `securityReviewJobId: job.id` AND stamps the reverse leg
 *      `waiting_on_fix_positions: [...]` onto the review job's `instructions` — observability, not a
 *      dependence.
 *
 *   4. `finalizeBuiltPhase` (scripts/builder-worker.ts) calls `retestBranchSecurityIfFixPhaseLanded`
 *      after the `stampPhaseBuilt` loop — the "fix landed on the branch" trigger.
 *
 * Runtime tests exercise the skip paths (which need no DB — the guard predicate returns early). Wiring
 * pins the token graph is intact (like `premerge-security-retirement.test.ts` — a positive-absence miss
 * where the caller silently loses the link is exactly what would silently regress this).
 *
 * Run: npm run test:security-agent-fix-phase-landed
 *   (= tsx --test src/lib/security-agent.fix-phase-landed.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { retestBranchSecurityIfFixPhaseLanded } from "./agent-jobs";
import type { SpawnPreMergeFixInput, SpawnPreMergeFixResult } from "./pre-merge-fix";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_JOBS_SRC = readFileSync(resolve(__dirname, "./agent-jobs.ts"), "utf8");
const PRE_MERGE_FIX_SRC = readFileSync(resolve(__dirname, "./pre-merge-fix.ts"), "utf8");
const BUILDER_WORKER_SRC = readFileSync(resolve(__dirname, "../../scripts/builder-worker.ts"), "utf8");

// ── Runtime skip paths (predicate-only — no admin calls) ─────────────────────────────────────────
// Proxy admin that throws if touched — proves the skip returns BEFORE any DB call for these cases.
const throwOnUse = new Proxy({}, {
  get() {
    throw new Error("admin must NOT be touched — the skip guard must return before any DB read/write");
  },
}) as never;

test("retestBranchSecurityIfFixPhaseLanded — empty positions → skip (before any DB call)", async () => {
  const r = await retestBranchSecurityIfFixPhaseLanded("ws", "s", [], "claude/build-s", "sha", throwOnUse);
  assert.equal(r.enqueued, false);
  assert.equal(r.matchingFixPhaseCount, 0);
  assert.match(r.reason, /missing context|positions/i);
});

test("retestBranchSecurityIfFixPhaseLanded — non-claude/build-* branch → skip", async () => {
  const r = await retestBranchSecurityIfFixPhaseLanded("ws", "s", [1], "main", "sha", throwOnUse);
  assert.equal(r.enqueued, false);
  assert.equal(r.matchingFixPhaseCount, 0);
  assert.match(r.reason, /not a claude\/build/);
});

test("retestBranchSecurityIfFixPhaseLanded — missing workspaceId / slug / branch → skip", async () => {
  const r1 = await retestBranchSecurityIfFixPhaseLanded("", "s", [1], "claude/build-s", "sha", throwOnUse);
  const r2 = await retestBranchSecurityIfFixPhaseLanded("ws", "", [1], "claude/build-s", "sha", throwOnUse);
  const r3 = await retestBranchSecurityIfFixPhaseLanded("ws", "s", [1], "", "sha", throwOnUse);
  for (const r of [r1, r2, r3]) {
    assert.equal(r.enqueued, false);
    assert.equal(r.matchingFixPhaseCount, 0);
    assert.match(r.reason, /missing context/i);
  }
});

// ── Wiring pins (source-grep — a positive-absence miss on any of these would silently regress) ───

test("wiring: retestBranchSecurityIfFixPhaseLanded is EXPORTED from agent-jobs.ts (typeof export check)", () => {
  assert.equal(typeof retestBranchSecurityIfFixPhaseLanded, "function");
  assert.match(
    AGENT_JOBS_SRC,
    /export async function retestBranchSecurityIfFixPhaseLanded\s*\(/,
    "the function must be an exported async function so builder-worker.ts can dynamic-import it",
  );
});

test("wiring: retestBranchSecurityIfFixPhaseLanded gates on positions carrying `security_review_job_id`", () => {
  // The forward link the fix-landed hook reads must be the SAME field name spawnPreMergeFix stamps.
  // If either side drifts, the enqueue silently no-ops.
  assert.match(
    AGENT_JOBS_SRC,
    /security_review_job_id/,
    "retestBranchSecurityIfFixPhaseLanded must read `metadata.security_review_job_id`",
  );
});

test("wiring: retestBranchSecurityIfFixPhaseLanded enqueues with `force: true`", () => {
  // force:true bypasses ONLY dedup (2) — the SHA-based freshness — so the fresh review always enqueues
  // even when the caller can't prove the head moved. Guards (0)/(1) still apply. The spec's point 3:
  // "prefer enqueuing over skipping when the two are ambiguous".
  const fnMatch = AGENT_JOBS_SRC.match(/retestBranchSecurityIfFixPhaseLanded[\s\S]*?^}$/m);
  assert.ok(fnMatch, "could not locate the function body");
  assert.match(fnMatch![0], /force:\s*true/, "the fix-landed enqueue MUST force:true (bypasses SHA freshness; guards 0+1 still apply)");
});

test("wiring: spawnPreMergeFix stamps `security_review_job_id` via setPhaseMetadata on each appended fix phase", () => {
  // The forward leg of the two-way link. Without this write, the landing hook has nothing to read.
  assert.match(
    PRE_MERGE_FIX_SRC,
    /setPhaseMetadata\([\s\S]*?security_review_job_id/,
    "spawnPreMergeFix MUST call setPhaseMetadata with security_review_job_id on each appended fix phase",
  );
  assert.match(
    PRE_MERGE_FIX_SRC,
    /securityReviewJobId\?:\s*string\s*\|\s*null/,
    "SpawnPreMergeFixInput MUST expose an optional securityReviewJobId string|null",
  );
});

test("wiring: SpawnPreMergeFixResult exposes appendedPositions when spawned=true (compile-time signal for the caller)", () => {
  // The reverse-leg stamp (`waiting_on_fix_positions` on the review's instructions) needs the appended
  // positions the fix stamp reserved — so the result type MUST expose them on the `spawned: true` variant.
  type SpawnedVariant = Extract<SpawnPreMergeFixResult, { spawned: true }>;
  const spawned: SpawnedVariant = {
    spawned: true,
    escalated: false,
    fixSlug: "s",
    alreadyAuthored: false,
    buildQueued: true,
    attempts: 0,
    appendedPositions: [3, 4],
  };
  assert.deepEqual(spawned.appendedPositions, [3, 4]);
  // And the input carries the id:
  const input: SpawnPreMergeFixInput = {
    workspaceId: "w",
    originSlug: "s",
    originTitle: "T",
    branch: "claude/build-s",
    failing: [],
    securityReviewJobId: "job-xyz",
  };
  assert.equal(input.securityReviewJobId, "job-xyz");
});

test("wiring: scripts/builder-worker.ts security branch-mode arm passes securityReviewJobId: job.id to spawnPreMergeFix", () => {
  // The forward link's SOURCE — the security caller must actually pass its own job.id through. Without
  // this call-site, the phase gets stamped with `undefined` and the fix-landed hook silently no-ops.
  const spawnCallMatch = BUILDER_WORKER_SRC.match(/spawnPreMergeFix\s*\(\s*db\s*,\s*\{[\s\S]*?securityReviewJobId:\s*job\.id[\s\S]*?\}/);
  assert.ok(spawnCallMatch, "the security branch-mode arm MUST pass securityReviewJobId: job.id to spawnPreMergeFix");
});

test("wiring: scripts/builder-worker.ts persists `waiting_on_fix_positions` onto the security-review's instructions (reverse-leg observability)", () => {
  // Reverse leg for observability — the review row exposes which fix positions it is waiting on.
  assert.match(
    BUILDER_WORKER_SRC,
    /waiting_on_fix_positions/,
    "the security applier MUST persist waiting_on_fix_positions onto the review job's instructions",
  );
});

test("wiring: scripts/builder-worker.ts finalizeBuiltPhase calls retestBranchSecurityIfFixPhaseLanded after the stamp loop", () => {
  // The "fix landed on the branch" trigger — where the direct enqueue actually fires. If this call is
  // deleted or moved before the stamp loop, the landed-fix path silently regresses.
  assert.match(
    BUILDER_WORKER_SRC,
    /retestBranchSecurityIfFixPhaseLanded/,
    "finalizeBuiltPhase MUST invoke retestBranchSecurityIfFixPhaseLanded so a landed fix phase enqueues a fresh review directly",
  );
  // Also confirm it's called INSIDE the finalizeBuiltPhase body — not at some unrelated call site.
  const finalizeMatch = BUILDER_WORKER_SRC.match(/finalizeBuiltPhase\s*=\s*async\s*\(opts:[\s\S]*?^\s{4}\};$/m);
  assert.ok(finalizeMatch, "could not locate finalizeBuiltPhase body");
  assert.match(finalizeMatch![0], /retestBranchSecurityIfFixPhaseLanded/);
});
