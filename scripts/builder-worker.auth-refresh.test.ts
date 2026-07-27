/**
 * Unit test for a-test-that-no-runner-executes-is-not-a-test-register-orphans-and-guard-new-ones
 * Phase 1 — the box auth-refresh regression test the parent spec
 * (`box-account-auth-expiry-refreshes-before-eject-and-never-reports-as-usage-cap`) asked for
 * in writing and never got. The behaviour it guards — an account recovering from an expired
 * access token without a restart — is what turned a 5-minute credential refresh into a
 * 37-hour outage on 2026-07-25 when the sweep synchronously ejected every account before any
 * could refresh.
 *
 *   npx tsx --test scripts/builder-worker.auth-refresh.test.ts
 *
 * The four cases below are the four the spec named. The pure `decideSweepAction` +
 * `applyRefreshOutcome` predicates were factored out of `sweepExpiredCredentials` +
 * `attemptCredentialRefresh` in [[../scripts/builder-worker.ts]] so the test asserts on
 * the REAL decision logic, not a mock — the mandate the parent spec's Phase 5 spelled
 * out explicitly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRefreshOutcome,
  decideSweepAction,
  type SweepAction,
} from "./builder-worker.auth-refresh";

const THROTTLE_MS = 5 * 60 * 1000; // AUTH_REFRESH_MIN_INTERVAL_MS
const NOW = 1_700_000_000_000; // a fixed epoch — Date.now() is not called in the pure code

function baseSweep(
  overrides: Partial<Parameters<typeof decideSweepAction>[0]> = {},
): Parameters<typeof decideSweepAction>[0] {
  return {
    expiresAt: NOW - 1_000, // access token expired 1s ago
    hasRefreshToken: true,
    now: NOW,
    authRefreshInFlight: false,
    lastAuthRefreshAttemptAt: undefined,
    lastAuthRefreshFailed: undefined,
    refreshThrottleMs: THROTTLE_MS,
    ...overrides,
  };
}

test("Case 1 (recovery) — expired access token + live refresh_token MUST decide REFRESH (not eject); a successful refresh clears an auth-shaped hold without any restart", () => {
  // The named failing state the outage produced: the sweep ejected an account that could have
  // refreshed. The correct decision is REFRESH.
  const action = decideSweepAction(baseSweep());
  assert.equal(action.kind, "refresh");

  // After the CLI refreshes the credentials file (fresh expiresAt in the future), the pure
  // outcome function reports: mark NOT expired, clear the auth-shaped holdReason, and record a
  // recovery — the account rejoins rotation without a boot re-run.
  const outcome = applyRefreshOutcome({
    freshExpiresAt: NOW + 3_600_000,
    now: NOW,
    holdReasonBefore: "auth_expired",
  });
  assert.equal(outcome.kind, "recovered");
  assert.equal(outcome.markAuthExpired, false);
  assert.equal(outcome.clearHold, true);
  assert.equal(outcome.lastAuthRefreshFailed, false);
});

test("Case 2 (genuinely-dead) — expired access token + NO refresh_token → eject with holdReason='auth_expired' (needs a CEO re-login; no auto-recovery possible)", () => {
  const action = decideSweepAction(baseSweep({ hasRefreshToken: false }));
  assert.equal(action.kind, "eject");
  // Narrow via `if` (not the discriminated field on the outer literal) so tsc keeps the eject variant.
  if (action.kind !== "eject") throw new Error("unreachable");
  assert.equal(action.holdReason, "auth_expired");
});

test("Case 3a (refresh-failed, sweep tick) — throttled + last attempt FAILED → eject with holdReason='refresh_failed' — distinct from 'usage_cap', so the CEO card + parked-job tail don't collapse an auth failure into a usage-wall label", () => {
  const action = decideSweepAction(
    baseSweep({
      lastAuthRefreshAttemptAt: NOW - 30_000, // 30s ago, well inside the throttle window
      lastAuthRefreshFailed: true,
    }),
  );
  assert.equal(action.kind, "eject");
  if (action.kind !== "eject") throw new Error("unreachable");
  assert.equal(action.holdReason, "refresh_failed");
});

test("Case 3b (refresh-failed, refresh tail) — refresh attempt that did NOT renew expiresAt → mark refresh_failed + do NOT clear any prior hold + signal caller to mark auth-expired via the standard eject path", () => {
  const outcome = applyRefreshOutcome({
    freshExpiresAt: 0, // CLI ran but the file's expiresAt is still zero/expired
    now: NOW,
    holdReasonBefore: null,
  });
  assert.equal(outcome.kind, "did_not_renew");
  assert.equal(outcome.markAuthExpired, true);
  assert.equal(outcome.lastAuthRefreshFailed, true);
  assert.equal(outcome.clearHold, false);
});

test("Case 4 (whole-pool guard) — every account expired at once with refresh_tokens present MUST decide REFRESH for every one, EJECT for zero (this is the 2026-07-25 outage's exact shape: four accounts expired within 45 min, the pre-fix sweep pulled all four in one tick, and nothing could ever run to refresh them → 37 hours of downtime)", () => {
  // Simulate the four-account pool with staggered-but-simultaneously-expired tokens.
  const pool = Array.from({ length: 4 }, (_, i) =>
    baseSweep({ expiresAt: NOW - (i + 1) * 60_000 }),
  );
  const actions: SweepAction[] = pool.map(decideSweepAction);
  // The invariant: every account picks REFRESH; the number of EJECTs is zero. If either flips,
  // the deadlock is back.
  assert.equal(
    actions.filter((a) => a.kind === "refresh").length,
    pool.length,
    "every expired-with-refresh-token account must decide REFRESH",
  );
  assert.equal(
    actions.filter((a) => a.kind === "eject").length,
    0,
    "no account with a live refresh_token may be ejected in the same sweep tick",
  );
});

// ── Guardrail cases below — the three remaining branches of decideSweepAction that keep the
// four named cases from silently regressing via a sibling branch (e.g. throttled-after-success
// mistakenly ejecting, or an in-flight refresh double-firing).

test("refresh already in flight → skip (do not eject; the running refresh owns recovery)", () => {
  const action = decideSweepAction(baseSweep({ authRefreshInFlight: true }));
  assert.equal(action.kind, "skip");
});

test("throttled + last attempt succeeded → skip (do not re-fire the refresh AND do not eject)", () => {
  const action = decideSweepAction(
    baseSweep({
      lastAuthRefreshAttemptAt: NOW - 30_000,
      lastAuthRefreshFailed: false,
    }),
  );
  assert.equal(action.kind, "skip");
});

test("no signal (expiresAt=0 — file missing/malformed) → skip; reactive 401 path stays in charge", () => {
  const action = decideSweepAction(baseSweep({ expiresAt: 0 }));
  assert.equal(action.kind, "skip");
});

test("access token still valid (expiresAt > now) → skip", () => {
  const action = decideSweepAction(baseSweep({ expiresAt: NOW + 3_600_000 }));
  assert.equal(action.kind, "skip");
});

test("recovered outcome with holdReasonBefore='usage_cap' does NOT clear the hold — a usage-cap is a distinct, non-auth condition that only ages out via the reset time", () => {
  const outcome = applyRefreshOutcome({
    freshExpiresAt: NOW + 3_600_000,
    now: NOW,
    holdReasonBefore: "usage_cap",
  });
  assert.equal(outcome.kind, "recovered");
  assert.equal(outcome.clearHold, false);
  assert.equal(outcome.markAuthExpired, false);
});
