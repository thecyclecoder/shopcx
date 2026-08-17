/**
 * a-branch-security-review-is-fresh-only-for-the-exact-head-sha-it-reviewed Phase 3 pins the pure
 * "what do we persist" decision `computePersistedPreviewFields`. The invariant it enforces:
 *
 *   - `previewUrl` is drawn STRICTLY from `lookup.ready`. Because Phase 3's SHA-scoped
 *     `getLatestReadyDeploymentForBranch` leaves `lookup.ready` null on a mismatched-SHA miss
 *     (no cross-SHA substitution), a caller that supplied `commitSha` gets `previewUrl: null` on
 *     that miss — never a URL from another commit's deployment. That is the whole point.
 *   - `previewState` continues to reflect the branch's newest deployment (`lookup.latest`) so an
 *     operator sees "preview exists / still BUILDING" progress regardless of the SHA match.
 *   - A no-SHA caller (branch's-newest-preview semantics) is unchanged — the branch's newest
 *     READY populates `lookup.ready` in that case, so `previewUrl` is set as before.
 *
 * Pure — no Vercel, no Supabase. Run:
 *   npm run test:preview-capture-persist-sha-scope
 *   (= tsx --test src/lib/preview-capture.persist-sha-scope.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computePersistedPreviewFields } from "./preview-capture";
import type { Deployment, LatestDeploymentLookup } from "./vercel-project";

function deployment(overrides: Partial<Deployment> & { url: string; state: Deployment["state"] }): Deployment {
  return {
    uid: "dpl_x",
    target: null,
    meta: {},
    createdAt: 0,
    ...overrides,
  };
}

test("SHA-match: lookup.ready is a READY deployment (SHA-scoped) → previewUrl set to that deployment's URL", () => {
  const ready = deployment({ url: "shopcx-abc.vercel.app", state: "READY", meta: { githubCommitSha: "sha-A" } });
  const lookup: LatestDeploymentLookup = {
    latest: ready,
    ready,
    readyForRequestedSha: true,
    latestReadyOnBranch: ready,
  };
  const r = computePersistedPreviewFields(lookup);
  assert.equal(r.previewUrl, "https://shopcx-abc.vercel.app");
  assert.equal(r.previewState, "READY");
});

test("⭐ SHA-MISS: lookup.ready is null but a DIFFERENT-SHA READY exists on the branch → previewUrl stays NULL (no substitution)", () => {
  // The exact 2026-08-17 defect: merge commit d8727bf05 landed with no deployment; the branch's
  // newest READY was `7bf057e97` (pre-merge). Under the old code, `lookup.ready` was substituted
  // with the pre-merge deployment. Under Phase 3, getLatestReadyDeploymentForBranch leaves
  // `lookup.ready` null on a SHA miss AND exposes the non-matching newest READY under
  // `latestReadyOnBranch` for visibility. This test pins that `computePersistedPreviewFields` does
  // NOT re-introduce the substitution via `latestReadyOnBranch` or `lookup.latest`.
  const preMergeReady = deployment({
    url: "shopcx-pre-merge.vercel.app",
    state: "READY",
    meta: { githubCommitSha: "7bf057e97" },
  });
  const lookup: LatestDeploymentLookup = {
    latest: preMergeReady, // the branch's newest deployment happens to be the pre-merge READY
    ready: null,           // Phase 3: no READY for the caller's SHA
    readyForRequestedSha: false,
    latestReadyOnBranch: preMergeReady,
  };
  const r = computePersistedPreviewFields(lookup);
  assert.equal(r.previewUrl, null, "must NOT persist a URL from a different commit's deployment");
  assert.equal(r.previewState, "READY", "state still reflects the branch's newest deployment for operator visibility");
});

test("SHA-MISS + newest deployment is BUILDING → previewUrl null, previewState 'BUILDING' (operator sees progress)", () => {
  const buildingLatest = deployment({
    url: "shopcx-building.vercel.app",
    state: "BUILDING",
    meta: { githubCommitSha: "sha-under-test" },
  });
  const lookup: LatestDeploymentLookup = {
    latest: buildingLatest,
    ready: null,
    readyForRequestedSha: false,
    latestReadyOnBranch: null,
  };
  const r = computePersistedPreviewFields(lookup);
  assert.equal(r.previewUrl, null);
  assert.equal(r.previewState, "BUILDING", "operator can see the new push is deploying");
});

test("NO deployments at all → previewUrl null, previewState null", () => {
  const lookup: LatestDeploymentLookup = {
    latest: null,
    ready: null,
    readyForRequestedSha: false,
    latestReadyOnBranch: null,
  };
  const r = computePersistedPreviewFields(lookup);
  assert.equal(r.previewUrl, null);
  assert.equal(r.previewState, null);
});

test("No-SHA caller (branch's newest preview semantics): lookup.ready populated → previewUrl set (unchanged behavior)", () => {
  // With no commitSha, getLatestReadyDeploymentForBranch populates lookup.ready with the branch's
  // newest READY regardless of commit — the caller is asking for "any recent preview" and no
  // substitution is possible. Phase 3 is intentionally unchanged here.
  const ready = deployment({ url: "shopcx-no-sha.vercel.app", state: "READY" });
  const lookup: LatestDeploymentLookup = {
    latest: ready,
    ready,
    readyForRequestedSha: true,
    latestReadyOnBranch: ready,
  };
  const r = computePersistedPreviewFields(lookup);
  assert.equal(r.previewUrl, "https://shopcx-no-sha.vercel.app");
  assert.equal(r.previewState, "READY");
});

test("lookup.ready is set but NOT READY (defensive) → previewUrl null (only READY URLs are persistable)", () => {
  // The SHA-scoped path only sets `ready` when a READY is found; this defensive check pins that
  // a non-READY value never becomes a persisted URL, even if the shape drifts.
  const almostReady = deployment({ url: "shopcx-almost.vercel.app", state: "BUILDING" });
  const lookup: LatestDeploymentLookup = {
    latest: almostReady,
    ready: almostReady, // hypothetically set to a non-READY — must still not persist a URL
    readyForRequestedSha: false,
    latestReadyOnBranch: null,
  };
  const r = computePersistedPreviewFields(lookup);
  assert.equal(r.previewUrl, null);
  assert.equal(r.previewState, "BUILDING");
});

test("URL scheme: previewHttpsUrl adds https:// when the deployment url is scheme-less (already https passes through)", () => {
  const preHttps = deployment({ url: "https://shopcx-already.vercel.app", state: "READY" });
  const lookup: LatestDeploymentLookup = {
    latest: preHttps,
    ready: preHttps,
    readyForRequestedSha: true,
    latestReadyOnBranch: preHttps,
  };
  const r = computePersistedPreviewFields(lookup);
  assert.equal(r.previewUrl, "https://shopcx-already.vercel.app", "an already-https URL is not double-prefixed");
});
