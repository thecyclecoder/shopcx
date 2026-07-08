/**
 * Unit tests for agent-jobs-update-retry-and-error-surface Phase 1 — the bounded-retry
 * chokepoint the box worker's `scripts/builder-worker.ts:update` funnels every agent_jobs
 * PATCH through. Pure functions over a mocked `runOnce`, no Supabase / worker plumbing.
 *
 *   npm run test:agent-jobs-update-retry
 *   (= tsx --test src/lib/agents/agent-jobs-update-retry.test.ts)
 *
 * Covers the spec's Verification bullet:
 *   "a mocked 521 is retried and a final failure is surfaced instead of ignored"
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentJobsUpdateError,
  isTransientAgentJobsUpdateResponse,
  isTransientAgentJobsUpdateThrow,
  writeAgentJobsUpdateWithRetry,
  type AgentJobsUpdateResponse,
  type AgentJobsUpdateRunOnce,
} from "./agent-jobs-update-retry";

// ── shared fixtures ──────────────────────────────────────────────────────────
const noSleep = async (_ms: number): Promise<void> => {};
const silentLogger = { warn: (_m: string) => {}, error: (_m: string) => {} };

function fakeCloudflare521(): AgentJobsUpdateResponse {
  return {
    status: 521,
    statusText: "",
    error: {
      message:
        "521: Web server is down — Cloudflare cannot establish a connection to the origin.",
      code: null,
      details: null,
      hint: null,
    },
  };
}

function fakeSuccess(): AgentJobsUpdateResponse {
  return { status: 204, statusText: "No Content", error: null };
}

function fakePostgrestRls(): AgentJobsUpdateResponse {
  return {
    status: 403,
    statusText: "Forbidden",
    error: {
      message: "new row violates row-level security policy",
      code: "PGRST116",
      details: null,
      hint: null,
    },
  };
}

// ── isTransientAgentJobsUpdateResponse ──────────────────────────────────────
test("isTransientAgentJobsUpdateResponse: Cloudflare 521 is transient (the exact signature the spec targets)", () => {
  assert.equal(isTransientAgentJobsUpdateResponse(fakeCloudflare521()), true);
});

test("isTransientAgentJobsUpdateResponse: 502/503/504 with an error body classify as transient", () => {
  for (const status of [500, 502, 503, 504, 522, 599]) {
    assert.equal(
      isTransientAgentJobsUpdateResponse({ status, error: { message: `${status} upstream blip` } }),
      true,
      `status=${status} should be transient`,
    );
  }
});

test("isTransientAgentJobsUpdateResponse: PostgREST PGRST* codes are terminal (bug, do NOT retry)", () => {
  assert.equal(isTransientAgentJobsUpdateResponse(fakePostgrestRls()), false);
  assert.equal(
    isTransientAgentJobsUpdateResponse({
      status: 400,
      error: { message: "duplicate key", code: "PGRST100" },
    }),
    false,
  );
});

test("isTransientAgentJobsUpdateResponse: a null error is not transient (no error to retry)", () => {
  assert.equal(isTransientAgentJobsUpdateResponse({ status: 204, error: null }), false);
});

test("isTransientAgentJobsUpdateResponse: 5xx-shaped message with no status still classifies as transient", () => {
  assert.equal(
    isTransientAgentJobsUpdateResponse({ error: { message: "521 web server is down" } }),
    true,
  );
});

// ── isTransientAgentJobsUpdateThrow ─────────────────────────────────────────
test("isTransientAgentJobsUpdateThrow: fetch failed / ECONNRESET / ETIMEDOUT are transient", () => {
  assert.equal(isTransientAgentJobsUpdateThrow(new Error("fetch failed")), true);
  assert.equal(isTransientAgentJobsUpdateThrow(new Error("socket hang up")), true);
  assert.equal(isTransientAgentJobsUpdateThrow(new Error("read ECONNRESET")), true);
  assert.equal(isTransientAgentJobsUpdateThrow(new Error("connect ETIMEDOUT 1.2.3.4:443")), true);
  assert.equal(isTransientAgentJobsUpdateThrow(new Error("getaddrinfo EAI_AGAIN db.host")), true);
});

test("isTransientAgentJobsUpdateThrow: a bug-shaped throw is terminal (do NOT retry)", () => {
  assert.equal(isTransientAgentJobsUpdateThrow(new TypeError("Cannot read property 'id' of null")), false);
  assert.equal(isTransientAgentJobsUpdateThrow(new SyntaxError("Unexpected token")), false);
});

// ── writeAgentJobsUpdateWithRetry (spec bullet) ─────────────────────────────
test("writeAgentJobsUpdateWithRetry: a mocked 521 is RETRIED and the eventual success returns { ok:true, attempts:3 }", async () => {
  let calls = 0;
  const sequence: AgentJobsUpdateResponse[] = [fakeCloudflare521(), fakeCloudflare521(), fakeSuccess()];
  const runOnce: AgentJobsUpdateRunOnce = async () => sequence[calls++]!;

  const result = await writeAgentJobsUpdateWithRetry(runOnce, {
    jobId: "daa40284-720e-44b5-a3fd-6b4cc4fd9d0d",
    attemptedStatus: "failed",
    attempts: 4,
    baseDelayMs: 0,
    sleep: noSleep,
    logger: silentLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3, "runOnce should be called exactly 3 times (2 x 521 + 1 x success)");
});

test("writeAgentJobsUpdateWithRetry: a mocked 521 that NEVER recovers surfaces a typed AgentJobsUpdateError (not silently ignored)", async () => {
  let calls = 0;
  const runOnce: AgentJobsUpdateRunOnce = async () => {
    calls++;
    return fakeCloudflare521();
  };

  await assert.rejects(
    writeAgentJobsUpdateWithRetry(runOnce, {
      jobId: "daa40284-720e-44b5-a3fd-6b4cc4fd9d0d",
      attemptedStatus: "failed",
      attempts: 3,
      baseDelayMs: 0,
      sleep: noSleep,
      logger: silentLogger,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AgentJobsUpdateError, "must throw a typed AgentJobsUpdateError");
      const e = err as AgentJobsUpdateError;
      assert.equal(e.jobId, "daa40284-720e-44b5-a3fd-6b4cc4fd9d0d");
      assert.equal(e.attemptedStatus, "failed");
      assert.equal(e.attempts, 3);
      // The Supabase error must be preserved on the throw so ops can triage.
      assert.ok(String(e.lastError?.message ?? "").includes("521"));
      // The error message MUST carry the jobId + attemptedStatus for the log breadcrumb.
      assert.ok(e.message.includes("daa40284-720e-44b5-a3fd-6b4cc4fd9d0d"));
      assert.ok(e.message.includes("attemptedStatus=failed"));
      return true;
    },
  );
  assert.equal(calls, 3, "runOnce must be called exactly `attempts` times before surfacing");
});

test("writeAgentJobsUpdateWithRetry: a PGRST* (terminal) error fails FAST — no retries burned", async () => {
  let calls = 0;
  const runOnce: AgentJobsUpdateRunOnce = async () => {
    calls++;
    return fakePostgrestRls();
  };

  await assert.rejects(
    writeAgentJobsUpdateWithRetry(runOnce, {
      jobId: "j-rls",
      attemptedStatus: "completed",
      attempts: 5,
      baseDelayMs: 0,
      sleep: noSleep,
      logger: silentLogger,
    }),
    AgentJobsUpdateError,
  );
  assert.equal(calls, 1, "terminal PostgREST error must not retry (bug, not a blip)");
});

test("writeAgentJobsUpdateWithRetry: a terminal THROW (bug-shaped) is re-thrown as-is, not wrapped", async () => {
  const bug = new TypeError("Cannot read property 'id' of null");
  const runOnce: AgentJobsUpdateRunOnce = async () => {
    throw bug;
  };

  await assert.rejects(
    writeAgentJobsUpdateWithRetry(runOnce, {
      jobId: "j-throw",
      attemptedStatus: "running",
      attempts: 3,
      baseDelayMs: 0,
      sleep: noSleep,
      logger: silentLogger,
    }),
    (err: unknown) => {
      assert.equal(err, bug, "the original bug must propagate — do NOT wrap in AgentJobsUpdateError");
      return true;
    },
  );
});

test("writeAgentJobsUpdateWithRetry: a transient THROW is retried; success on the 2nd attempt returns cleanly", async () => {
  let calls = 0;
  const runOnce: AgentJobsUpdateRunOnce = async () => {
    calls++;
    if (calls === 1) throw new Error("fetch failed");
    return fakeSuccess();
  };

  const result = await writeAgentJobsUpdateWithRetry(runOnce, {
    jobId: "j-fetch",
    attemptedStatus: "needs_attention",
    attempts: 3,
    baseDelayMs: 0,
    sleep: noSleep,
    logger: silentLogger,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test("writeAgentJobsUpdateWithRetry: first-attempt success returns { attempts: 1 } — no unnecessary retries", async () => {
  let calls = 0;
  const runOnce: AgentJobsUpdateRunOnce = async () => {
    calls++;
    return fakeSuccess();
  };
  const result = await writeAgentJobsUpdateWithRetry(runOnce, {
    jobId: "j-fast",
    attemptedStatus: "completed",
    attempts: 4,
    baseDelayMs: 0,
    sleep: noSleep,
    logger: silentLogger,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});
