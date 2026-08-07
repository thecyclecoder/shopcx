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
  classifyAccountHealth,
  decideHeldAccountRecovery,
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

test("Case 2 (genuinely-dead) — expired access token + NO refresh_token → eject with holdReason='reauth_required' (a full human /login is required; no wait or retry can renew it — build-an-account-that-needs-a-human-login-says-so-instead-of-hiding-as-capped Phase 1)", () => {
  const action = decideSweepAction(baseSweep({ hasRefreshToken: false }));
  assert.equal(action.kind, "eject");
  // Narrow via `if` (not the discriminated field on the outer literal) so tsc keeps the eject variant.
  if (action.kind !== "eject") throw new Error("unreachable");
  // Phase 1 named the un-recoverable case `reauth_required`. It MUST NOT collapse into `usage_cap`
  // (the pre-fix snapshot default that misreported two 49h/66h-dead accounts as capacity-capped).
  assert.equal(action.holdReason, "reauth_required");
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

test("recovered outcome with holdReasonBefore='reauth_required' DOES clear the hold — the CEO re-logged in, the credentials file now has a refreshToken, and this sweep-triggered refresh just renewed the access token (build-an-account-that-needs-a-human-login-says-so-instead-of-hiding-as-capped Phase 3 — closes the ordering-trap deadlock where a reauth_required account otherwise sat cappedUntil for the full weekly window even after /login)", () => {
  const outcome = applyRefreshOutcome({
    freshExpiresAt: NOW + 3_600_000,
    now: NOW,
    holdReasonBefore: "reauth_required",
  });
  assert.equal(outcome.kind, "recovered");
  assert.equal(outcome.clearHold, true);
  assert.equal(outcome.markAuthExpired, false);
});

// ── classifyAccountHealth: the pure account-health classifier Phase 3 asked for in writing ─────
// The four cases the spec named + the pre-expiry warning + a null-signal skip. Every downstream
// label (box page chip, CEO card title, pool-holds summary line) is derived from this one
// predicate, so the labels cannot regress via a sibling change.

const WARN_MS = 24 * 60 * 60 * 1000; // 24 hours — warn a full day before the wall

test("classifyAccountHealth: expired + refreshToken ⇒ renewable (the sweep will fire an exercise refresh; no human needed)", () => {
  const health = classifyAccountHealth({
    expiresAt: NOW - 1_000,
    hasRefreshToken: true,
    now: NOW,
    warnThresholdMs: WARN_MS,
    usageWallRejected: false,
  });
  assert.equal(health.kind, "renewable");
});

test("classifyAccountHealth: expired + NO refreshToken ⇒ reauth_required (only an interactive /login restores this account)", () => {
  const health = classifyAccountHealth({
    expiresAt: NOW - 1_000,
    hasRefreshToken: false,
    now: NOW,
    warnThresholdMs: WARN_MS,
    usageWallRejected: false,
  });
  assert.equal(health.kind, "reauth_required");
});

test("classifyAccountHealth: healthy (expiresAt well in the future) ⇒ no hold — 'healthy'", () => {
  const health = classifyAccountHealth({
    expiresAt: NOW + 7 * 24 * 3600_000, // a week out
    hasRefreshToken: true,
    now: NOW,
    warnThresholdMs: WARN_MS,
    usageWallRejected: false,
  });
  assert.equal(health.kind, "healthy");
});

test("classifyAccountHealth: usage-wall rejection ⇒ usage_cap regardless of credentials-file state — the runtime signal overrides the file (a fresh token that Anthropic just rejected on quota is still capped)", () => {
  const health = classifyAccountHealth({
    expiresAt: NOW + 7 * 24 * 3600_000,
    hasRefreshToken: true,
    now: NOW,
    warnThresholdMs: WARN_MS,
    usageWallRejected: true,
  });
  assert.equal(health.kind, "usage_cap");
});

test("classifyAccountHealth: expiring_soon + NO refreshToken ⇒ 'expiring_soon' so the heartbeat sweep can flag this EARLY (before it goes fully dead) — the 2026-08-03 outage happened precisely because a no-refreshToken account was surfaced 49h AFTER expiry, not before", () => {
  const health = classifyAccountHealth({
    expiresAt: NOW + 2 * 3600_000, // 2h away — inside the 24h warn window
    hasRefreshToken: false,
    now: NOW,
    warnThresholdMs: WARN_MS,
    usageWallRejected: false,
  });
  assert.equal(health.kind, "expiring_soon");
  if (health.kind !== "expiring_soon") throw new Error("unreachable");
  assert.equal(health.hasRefreshToken, false);
  assert.equal(health.msUntilExpiry, 2 * 3600_000);
});

test("classifyAccountHealth: expiring_soon + refreshToken ⇒ 'expiring_soon' but the operator does NOT need to act — the sweep's exercise path will renew it once expired (the WITH-refreshToken half of Phase 3's remedy)", () => {
  const health = classifyAccountHealth({
    expiresAt: NOW + 2 * 3600_000,
    hasRefreshToken: true,
    now: NOW,
    warnThresholdMs: WARN_MS,
    usageWallRejected: false,
  });
  assert.equal(health.kind, "expiring_soon");
  if (health.kind !== "expiring_soon") throw new Error("unreachable");
  assert.equal(health.hasRefreshToken, true);
});

test("classifyAccountHealth: expiresAt=0 (missing / malformed credentials file) ⇒ 'healthy' so the reactive 401 path stays in charge — a file-read error must NEVER trigger a proactive eject wave", () => {
  const health = classifyAccountHealth({
    expiresAt: 0,
    hasRefreshToken: false,
    now: NOW,
    warnThresholdMs: WARN_MS,
    usageWallRejected: false,
  });
  assert.equal(health.kind, "healthy");
});

// ── decideHeldAccountRecovery ── build-an-account-that-needs-a-human-login-says-so-instead-of-hiding-as-capped Phase 1 ─
// The pure predicate the sweep consults for accounts ALREADY held out of rotation. On 2026-08-02 two
// accounts were ejected as auth_expired, the CEO re-authed both within the hour, and the box refused
// to use them for the full 25-hour window — because the sweep only decides about HEALTHY accounts;
// held ones are skipped entirely. These cases pin the release-on-re-auth rule so a repeat of that
// outage lights up in CI, and the usage-cap invariant (never release a real quota wall on a disk
// read) stays intact.

test("decideHeldAccountRecovery: usage_cap hold + fresh valid credentials ⇒ hold ('not_auth_hold') — a usage wall is a real quota that only ages out at its reset time; re-reading the credentials file cannot substantiate a release", () => {
  const decision = decideHeldAccountRecovery({
    holdReason: "usage_cap",
    expiresAt: NOW + 3_600_000, // credentials look fine — irrelevant to a usage wall
    hasRefreshToken: true,
    now: NOW,
  });
  assert.equal(decision.kind, "hold");
  if (decision.kind !== "hold") throw new Error("unreachable");
  assert.equal(decision.reason, "not_auth_hold");
});

test("decideHeldAccountRecovery: null holdReason (unclassified hold) ⇒ hold ('not_auth_hold') — we never release something we cannot substantiate as an auth hold, so a restart cannot become a shortcut around a real quota wall", () => {
  const decision = decideHeldAccountRecovery({
    holdReason: null,
    expiresAt: NOW + 3_600_000,
    hasRefreshToken: true,
    now: NOW,
  });
  assert.equal(decision.kind, "hold");
  if (decision.kind !== "hold") throw new Error("unreachable");
  assert.equal(decision.reason, "not_auth_hold");
});

test("decideHeldAccountRecovery: auth_expired + expiresAt in the future + refreshToken present ⇒ RELEASE — the credentials file was rewritten by a successful CEO /login AFTER the eject; the account must rejoin rotation immediately, not wait out the 25-hour weekly window", () => {
  const decision = decideHeldAccountRecovery({
    holdReason: "auth_expired",
    expiresAt: NOW + 3_600_000,
    hasRefreshToken: true,
    now: NOW,
  });
  assert.equal(decision.kind, "release");
});

test("decideHeldAccountRecovery: refresh_failed + expiresAt in the future + refreshToken present ⇒ RELEASE — a prior refresh attempt failed BUT the CEO has since re-authed and the credentials file now reads valid; the same recovery path applies", () => {
  const decision = decideHeldAccountRecovery({
    holdReason: "refresh_failed",
    expiresAt: NOW + 3_600_000,
    hasRefreshToken: true,
    now: NOW,
  });
  assert.equal(decision.kind, "release");
});

test("decideHeldAccountRecovery: reauth_required + expiresAt in the future + refreshToken present ⇒ RELEASE — reauth_required is another auth-shape hold whose recovery condition is identical (fresh expiresAt + refreshToken on disk means the CEO re-logged in); the pre-Phase-1 sweep skipped this case too", () => {
  const decision = decideHeldAccountRecovery({
    holdReason: "reauth_required",
    expiresAt: NOW + 3_600_000,
    hasRefreshToken: true,
    now: NOW,
  });
  assert.equal(decision.kind, "release");
});

test("decideHeldAccountRecovery: auth_expired + expiresAt STILL in the past ⇒ hold ('still_invalid') — the credentials file has not been re-authed yet; keep the hold in place", () => {
  const decision = decideHeldAccountRecovery({
    holdReason: "auth_expired",
    expiresAt: NOW - 1_000,
    hasRefreshToken: true,
    now: NOW,
  });
  assert.equal(decision.kind, "hold");
  if (decision.kind !== "hold") throw new Error("unreachable");
  assert.equal(decision.reason, "still_invalid");
});

test("decideHeldAccountRecovery: auth_expired + expiresAt fresh BUT no refreshToken ⇒ hold ('still_invalid') — guards against a mid-write credentials file where the fresh expiresAt landed before the refreshToken; releasing early would send a still-broken account back into rotation", () => {
  const decision = decideHeldAccountRecovery({
    holdReason: "auth_expired",
    expiresAt: NOW + 3_600_000,
    hasRefreshToken: false,
    now: NOW,
  });
  assert.equal(decision.kind, "hold");
  if (decision.kind !== "hold") throw new Error("unreachable");
  assert.equal(decision.reason, "still_invalid");
});
