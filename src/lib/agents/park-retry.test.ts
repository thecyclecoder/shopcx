/**
 * park-retry — re-drive a park caused by a code-side validation rejection before it becomes a
 * founder's unactionable card.
 *
 * Ground truth (2026-08-10/11): June's `cs-director-call` was rejected by the author chokepoint at
 * 14:25:39Z for a prose-only phase; that defect shipped fixed 4m35s later and every subsequent run
 * succeeded — but the parked job was never re-driven, so her product-gap finding was NEVER authored
 * and the founder got an unactionable card about a doubly-obsolete problem.
 *
 *   npx tsx --test src/lib/agents/park-retry.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideParkRetry,
  isRetryableParkError,
  PARK_RETRY_MAX,
  PARK_RETRY_MIN_INTERVAL_MS,
  RERUNNABLE_JOB_KINDS,
} from "./park-retry";

const NOW = new Date("2026-08-11T12:00:00Z");
/** The verbatim error that parked June's job. */
const REAL_ERROR =
  "author_spec: SDK threw (spec internal-renewal-order-injects-customer-name-into-shipping-address has a phase with no machine-runnable verification — phase 1 (P1 — implement the fix) — zero auto-testable checks (only prose / only needs_human).) — no spec written";

const base = { kind: "cs-director-call", error: REAL_ERROR, priorRetries: 0, lastRetryAt: null, now: NOW };

test("the REAL park error that lost June's finding is recognized as retryable", () => {
  assert.equal(isRetryableParkError(REAL_ERROR), true);
  assert.equal(decideParkRetry(base).retry, true);
});

test("an infrastructure/outage error is NOT retried — a retry there is a coin flip", () => {
  for (const err of [
    "authentication_failed / Not logged in",
    "ETIMEDOUT connecting to api.anthropic.com",
    "no parseable verdict returned by the session",
  ]) {
    assert.equal(isRetryableParkError(err), false, `${err} must not be retryable`);
    assert.equal(decideParkRetry({ ...base, error: err }).retry, false);
  }
});

test("a null/empty error is never retryable (no signature to reason about)", () => {
  assert.equal(isRetryableParkError(null), false);
  assert.equal(isRetryableParkError(""), false);
});

test("only safely re-runnable kinds are re-driven", () => {
  // `build` produces side effects (a branch, a PR) — re-running it is not free, and the orphan-reaper
  // deliberately excludes it for the same reason.
  assert.equal(RERUNNABLE_JOB_KINDS.has("build"), false);
  assert.equal(decideParkRetry({ ...base, kind: "build" }).retry, false);
  assert.equal(RERUNNABLE_JOB_KINDS.has("cs-director-call"), true);
  assert.equal(RERUNNABLE_JOB_KINDS.has("repair"), true);
});

test("the re-drive cap is enforced — after it, the park escalates for real", () => {
  assert.equal(decideParkRetry({ ...base, priorRetries: PARK_RETRY_MAX }).retry, false);
  assert.match(decideParkRetry({ ...base, priorRetries: PARK_RETRY_MAX }).reason, /cap reached/);
  // one below the cap still gets its attempt
  assert.equal(decideParkRetry({ ...base, priorRetries: PARK_RETRY_MAX - 1 }).retry, true);
});

test("re-drives are spaced so they straddle a DEPLOY, not hammer the same code", () => {
  const justNow = new Date(NOW.getTime() - 60_000);
  assert.equal(decideParkRetry({ ...base, priorRetries: 1, lastRetryAt: justNow }).retry, false);

  const longAgo = new Date(NOW.getTime() - PARK_RETRY_MIN_INTERVAL_MS - 1000);
  assert.equal(decideParkRetry({ ...base, priorRetries: 1, lastRetryAt: longAgo }).retry, true);
});

test("the decision always explains itself — the ledger and escalation must be auditable", () => {
  for (const d of [
    decideParkRetry(base),
    decideParkRetry({ ...base, kind: "build" }),
    decideParkRetry({ ...base, error: "kaboom" }),
    decideParkRetry({ ...base, priorRetries: PARK_RETRY_MAX }),
  ]) {
    assert.ok(d.reason.length > 10, "every decision carries a human-readable reason");
  }
});
