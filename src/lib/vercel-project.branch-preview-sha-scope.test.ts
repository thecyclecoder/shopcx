/**
 * a-branch-security-review-is-fresh-only-for-the-exact-head-sha-it-reviewed Phase 3 pins the
 * SHA-scoped lookup in `getLatestReadyDeploymentForBranch`:
 *
 *   1. When `commitSha` is supplied AND a READY deployment for THAT sha exists → `ready` is that
 *      deployment, `readyForRequestedSha === true`.
 *   2. When `commitSha` is supplied AND no READY matches → `ready === null` (NO substitution),
 *      `readyForRequestedSha === false`, and the branch's newest non-matching READY (if any) is
 *      exposed under `latestReadyOnBranch` for observability. This is the whole point.
 *   3. When `commitSha` is OMITTED → `ready` is the branch's newest READY (unchanged), and
 *      `readyForRequestedSha` mirrors `ready !== null`.
 *   4. `latest` still tracks the newest deployment on the branch regardless of state.
 *
 * The Vercel HTTP is stubbed by monkey-patching `globalThis.fetch` for the duration of each test.
 * Run: npm run test:vercel-project-branch-preview-sha-scope
 *   (= tsx --test src/lib/vercel-project.branch-preview-sha-scope.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";

// The module reads VERCEL_API_TOKEN at call-time via vercelToken(); set it before importing so the
// module doesn't crash on a missing env var.
process.env.VERCEL_API_TOKEN = "stub-token-for-tests";

import { getLatestReadyDeploymentForBranch } from "./vercel-project";

interface StubDeployment {
  uid: string;
  url: string;
  state?: "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELED" | "INITIALIZING";
  readyState?: "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELED" | "INITIALIZING";
  target?: "production" | "staging" | null;
  meta?: Record<string, string | undefined>;
  createdAt: number;
}

/** Install a fetch stub that returns the given deployment list; restore prior fetch on `dispose()`. */
function stubVercelFetch(deployments: StubDeployment[]): { dispose: () => void } {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    async text() {
      return "";
    },
    async json() {
      return { deployments };
    },
  })) as unknown as typeof fetch;
  return {
    dispose() {
      globalThis.fetch = prior;
    },
  };
}

const BRANCH = "claude/build-example";

test("SHA-supplied + a matching READY exists → ready is that deployment, readyForRequestedSha=true", async () => {
  const shaWanted = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const stub = stubVercelFetch([
    { uid: "d1", url: "shopcx-wanted.vercel.app", state: "READY", meta: { githubCommitSha: shaWanted }, createdAt: 200 },
    { uid: "d0", url: "shopcx-old.vercel.app", state: "READY", meta: { githubCommitSha: "old-sha" }, createdAt: 100 },
  ]);
  try {
    const lookup = await getLatestReadyDeploymentForBranch(BRANCH, shaWanted);
    assert.equal(lookup.ready?.uid, "d1");
    assert.equal(lookup.ready?.state, "READY");
    assert.equal(lookup.readyForRequestedSha, true);
    assert.equal(lookup.latestReadyOnBranch?.uid, "d1", "newest READY on branch same as the match here");
    assert.equal(lookup.latest?.uid, "d1");
  } finally {
    stub.dispose();
  }
});

test("⭐ SHA-supplied + NO matching READY → ready is NULL (no substitution) + readyForRequestedSha=false + latestReadyOnBranch exposes the non-matching newest READY", async () => {
  // The 2026-08-17 defect: merge commit d8727bf05 has no deployment; the branch's newest READY is
  // an older SHA. Under Phase 3, `ready` stays null (never substituted).
  const shaWanted = "d8727bf05000000000000000000000000000000c"; // no deployment for this sha
  const preMergeSha = "7bf057e97000000000000000000000000000000d";
  const stub = stubVercelFetch([
    { uid: "d0", url: "shopcx-pre-merge.vercel.app", state: "READY", meta: { githubCommitSha: preMergeSha }, createdAt: 100 },
  ]);
  try {
    const lookup = await getLatestReadyDeploymentForBranch(BRANCH, shaWanted);
    assert.equal(lookup.ready, null, "must NOT substitute another commit's deployment");
    assert.equal(lookup.readyForRequestedSha, false);
    assert.equal(lookup.latestReadyOnBranch?.uid, "d0", "the non-matching newest READY is exposed for observability");
    assert.equal(lookup.latest?.uid, "d0");
  } finally {
    stub.dispose();
  }
});

test("SHA-supplied + matching deployment is not yet READY (still BUILDING) → ready NULL (only READY qualifies)", async () => {
  const shaWanted = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const stub = stubVercelFetch([
    { uid: "d1", url: "shopcx-building.vercel.app", state: "BUILDING", meta: { githubCommitSha: shaWanted }, createdAt: 200 },
    { uid: "d0", url: "shopcx-old.vercel.app", state: "READY", meta: { githubCommitSha: "old" }, createdAt: 100 },
  ]);
  try {
    const lookup = await getLatestReadyDeploymentForBranch(BRANCH, shaWanted);
    assert.equal(lookup.ready, null);
    assert.equal(lookup.readyForRequestedSha, false);
    assert.equal(lookup.latest?.uid, "d1", "latest tracks newest of any state (still BUILDING)");
    assert.equal(lookup.latestReadyOnBranch?.uid, "d0", "the pre-existing old READY is still visible under latestReadyOnBranch");
  } finally {
    stub.dispose();
  }
});

test("SHA-OMITTED (no commitSha) → ready falls back to newest READY on branch (unchanged behavior)", async () => {
  const stub = stubVercelFetch([
    { uid: "d2", url: "shopcx-newest.vercel.app", state: "READY", meta: { githubCommitSha: "sha-newest" }, createdAt: 300 },
    { uid: "d1", url: "shopcx-older.vercel.app", state: "READY", meta: { githubCommitSha: "sha-older" }, createdAt: 200 },
  ]);
  try {
    const lookup = await getLatestReadyDeploymentForBranch(BRANCH, null);
    assert.equal(lookup.ready?.uid, "d2");
    assert.equal(lookup.readyForRequestedSha, true, "no commitSha ⇒ any READY satisfies the request");
    assert.equal(lookup.latestReadyOnBranch?.uid, "d2");
  } finally {
    stub.dispose();
  }
});

test("SHA-OMITTED + no READY on branch → ready null, readyForRequestedSha false, latest still tracks the newest deployment", async () => {
  const stub = stubVercelFetch([
    { uid: "d1", url: "shopcx-building.vercel.app", state: "BUILDING", createdAt: 300 },
  ]);
  try {
    const lookup = await getLatestReadyDeploymentForBranch(BRANCH, null);
    assert.equal(lookup.ready, null);
    assert.equal(lookup.readyForRequestedSha, false);
    assert.equal(lookup.latest?.uid, "d1");
    assert.equal(lookup.latestReadyOnBranch, null);
  } finally {
    stub.dispose();
  }
});

test("production deployments are filtered out even when READY (target: 'production' excluded)", async () => {
  const stub = stubVercelFetch([
    { uid: "prod", url: "shopcx.ai", state: "READY", target: "production", createdAt: 300 },
    { uid: "d1", url: "shopcx-preview.vercel.app", state: "READY", meta: { githubCommitSha: "sha-1" }, createdAt: 200 },
  ]);
  try {
    const lookup = await getLatestReadyDeploymentForBranch(BRANCH, null);
    assert.equal(lookup.ready?.uid, "d1", "the prod deployment must never be returned as a preview");
    assert.equal(lookup.latestReadyOnBranch?.uid, "d1");
  } finally {
    stub.dispose();
  }
});

test("Non-preview branches (main/master) are refused (existing hard rail unchanged)", async () => {
  await assert.rejects(getLatestReadyDeploymentForBranch("main", null), /non-preview branch "main"/);
  await assert.rejects(getLatestReadyDeploymentForBranch("master", null), /non-preview branch "master"/);
});
