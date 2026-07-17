/**
 * preview-ready-event-trigger — the event-driven pre-merge enqueue's cheap guards. `enqueuePreMergeFrom
 * DeploymentReady` must reject a Production deploy, a missing SHA, and a missing preview URL BEFORE any
 * network/DB work (the GitHub branch-resolve + agent_jobs lookup), so a noisy stream of non-preview
 * deployment_status events costs nothing. These cases return purely (no createAdminClient, no fetch).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { enqueuePreMergeFromDeploymentReady } from "./agent-jobs";

test("Production env → skipped before any network", async () => {
  const r = await enqueuePreMergeFromDeploymentReady({ sha: "abc", previewUrl: "https://x.vercel.app", environment: "Production" });
  assert.equal(r.enqueued, false);
  assert.match(r.reason ?? "", /not a preview env/i);
});

test("missing SHA → skipped", async () => {
  const r = await enqueuePreMergeFromDeploymentReady({ sha: null, previewUrl: "https://x.vercel.app", environment: "Preview" });
  assert.equal(r.enqueued, false);
  assert.match(r.reason ?? "", /no deploy sha/i);
});

test("missing preview URL → skipped", async () => {
  const r = await enqueuePreMergeFromDeploymentReady({ sha: "abc", previewUrl: null, environment: "Preview" });
  assert.equal(r.enqueued, false);
  assert.match(r.reason ?? "", /no preview url/i);
});

test("a Preview-ish env label still passes the env guard (case-insensitive)", async () => {
  // "Preview – shopcx" style labels must not be rejected by the env guard. With a bogus SHA the resolve
  // returns no build branch, so it skips further along — NOT at the env guard.
  const r = await enqueuePreMergeFromDeploymentReady({ sha: "", previewUrl: "https://x.vercel.app", environment: "Preview – shopcx" });
  assert.equal(r.enqueued, false);
  assert.match(r.reason ?? "", /no deploy sha/i); // passed the env guard, stopped at the empty sha
});
