/**
 * a-test-that-no-runner-executes-is-not-a-test-register-orphans-and-guard-new-ones Phase 1 —
 * the pure decision predicates for [[../scripts/builder-worker.ts]] `sweepExpiredCredentials`
 * (per-account "refresh vs eject vs skip") and `attemptCredentialRefresh` (post-refresh
 * outcome). Kept in its own tiny module so
 * [[../scripts/builder-worker.auth-refresh.test.ts]] can import them without dragging in
 * builder-worker.ts's top-level `main()` (which requires GITHUB_TOKEN), exactly like the
 * sibling [[../scripts/builder-worker.stranded-fold.ts]].
 *
 * The four cases the test file pins map 1:1 to the four the box-account-auth-expiry
 * spec named: recovery (expired + refresh_token → refresh, not eject); genuinely-dead
 * (expired + no refresh_token → eject as `auth_expired`); refresh-failed (throttled after
 * a failed refresh → eject as `refresh_failed`, distinct from `usage_cap`); and the
 * whole-pool guard — the 2026-07-25 outage's exact shape — every account expired at
 * once with refresh_tokens present MUST decide REFRESH, never EJECT, so `healthyAccounts()`
 * is never emptied.
 */

// build-an-account-that-needs-a-human-login-says-so-instead-of-hiding-as-capped Phase 1 —
// `reauth_required` is the un-recoverable auth hold: expiresAt in the past AND no refreshToken
// in `.credentials.json`, so no retry ever renews the token. Distinct in kind from `auth_expired`
// (kept as the reactive-401 signal) and `refresh_failed` (a refresh WAS attempted and did not
// renew) — both of which the current pool machinery may still surface. A `null` holdReason is
// "unknown" — the snapshot MUST NOT collapse unknown to `usage_cap` (which is exactly what
// misreported two dead accounts as capacity-capped during 2026-08-03).
export type AccountHoldReason = "usage_cap" | "auth_expired" | "refresh_failed" | "reauth_required";

export type SweepAction =
  | { kind: "skip"; reason: "no_signal_or_valid" | "refresh_in_flight" | "throttled_after_success" }
  | { kind: "refresh" }
  | { kind: "eject"; holdReason: "auth_expired" | "refresh_failed" | "reauth_required" };

export function decideSweepAction(input: {
  expiresAt: number;
  hasRefreshToken: boolean;
  now: number;
  authRefreshInFlight: boolean;
  lastAuthRefreshAttemptAt: number | undefined;
  lastAuthRefreshFailed: boolean | undefined;
  refreshThrottleMs: number;
}): SweepAction {
  if (input.expiresAt <= 0 || input.expiresAt > input.now) {
    return { kind: "skip", reason: "no_signal_or_valid" };
  }
  if (!input.hasRefreshToken) {
    // Phase 1 — the un-recoverable case: an access token expired AND there is no refresh_token
    // to renew it, so no wait or retry ever succeeds. Only an interactive `/login` fixes it.
    // Distinct label from `auth_expired` (a reactive 401 whose credentials file we haven't read
    // yet) so the box card + summary + parked job's log_tail can direct the operator at the
    // right remedy — a human login, not a usage-wall wait.
    return { kind: "eject", holdReason: "reauth_required" };
  }
  if (input.authRefreshInFlight) {
    return { kind: "skip", reason: "refresh_in_flight" };
  }
  if (
    input.lastAuthRefreshAttemptAt &&
    input.now - input.lastAuthRefreshAttemptAt < input.refreshThrottleMs
  ) {
    if (input.lastAuthRefreshFailed) {
      return { kind: "eject", holdReason: "refresh_failed" };
    }
    return { kind: "skip", reason: "throttled_after_success" };
  }
  return { kind: "refresh" };
}

export type RefreshOutcome = {
  kind: "recovered" | "did_not_renew";
  lastAuthRefreshFailed: boolean;
  clearHold: boolean;
  markAuthExpired: boolean;
};

export function applyRefreshOutcome(input: {
  freshExpiresAt: number;
  now: number;
  holdReasonBefore: AccountHoldReason | null | undefined;
}): RefreshOutcome {
  if (input.freshExpiresAt > input.now) {
    return {
      kind: "recovered",
      lastAuthRefreshFailed: false,
      // build-an-account-that-needs-a-human-login-says-so-instead-of-hiding-as-capped Phase 3 —
      // a successful refresh ALSO clears a prior `reauth_required` hold (the CEO re-logged in, the
      // credentials file now carries a refreshToken, and the sweep's exercise-fire-refresh path just
      // renewed the access token). Without this, an account that came back healthy via /login would
      // sit at cappedUntil for the full weekly window because clearHold=false — the "ordering trap"
      // the spec explicitly names.
      clearHold:
        input.holdReasonBefore === "auth_expired" ||
        input.holdReasonBefore === "refresh_failed" ||
        input.holdReasonBefore === "reauth_required",
      markAuthExpired: false,
    };
  }
  return {
    kind: "did_not_renew",
    lastAuthRefreshFailed: true,
    clearHold: false,
    markAuthExpired: true,
  };
}

// ── build-an-account-that-needs-a-human-login-says-so-instead-of-hiding-as-capped Phase 3 ─────────
// The pure account-health classifier the spec asked for in writing. It maps the two ground-truth
// inputs an operator has — the credentials file's `expiresAt` + whether a `refreshToken` is present
// — plus the runtime usage-wall signal to one of five states, so every downstream label (box page,
// CEO card, summary line) is a function of the same predicate and cannot regress into a mislabel.
//
// The five states map 1:1 to the vocabulary the brain runbook documents:
//   - 'healthy'         — access token is live (expiresAt > now). No hold; picked by dispatch.
//   - 'expiring_soon'   — access token is live but within `warnThresholdMs` of expiry. A WITH-
//                         refreshToken account is renewed automatically by the sweep's exercise
//                         path once the wall is crossed (proven on 2026-08-03 midday); a WITHOUT
//                         one is flagged EARLY (Phase 3 CEO warning card) so the human /login can
//                         happen BEFORE the account goes fully dead.
//   - 'renewable'       — access token is past expiry AND a refreshToken is present. The sweep will
//                         fire an exercise `claude -p` that rewrites the credentials file with a
//                         fresh accessToken; no human action needed.
//   - 'reauth_required' — access token is past expiry AND no refreshToken. Only an interactive
//                         `/login` restores this account. Distinct in kind — no wait or retry.
//   - 'usage_cap'       — a real usage-wall rejection (isHardRateLimitRejection / isUsageCapError
//                         upstream). Clears at the reset time; the classifier just names it.
export type AccountHealth =
  | { kind: "healthy" }
  | { kind: "expiring_soon"; expiresAt: number; hasRefreshToken: boolean; msUntilExpiry: number }
  | { kind: "renewable" }
  | { kind: "reauth_required" }
  | { kind: "usage_cap" };

export function classifyAccountHealth(input: {
  expiresAt: number;
  hasRefreshToken: boolean;
  now: number;
  warnThresholdMs: number;
  usageWallRejected: boolean;
}): AccountHealth {
  // A usage-wall rejection is a runtime signal that overrides file-based classification — the file
  // can look pristine while Anthropic's server has rejected the account on quota.
  if (input.usageWallRejected) return { kind: "usage_cap" };
  // No signal (missing / malformed file). Treat as healthy so the reactive 401 path stays in
  // charge — the sweep would otherwise start ejecting accounts based on a file-read error.
  if (input.expiresAt <= 0) return { kind: "healthy" };
  if (input.expiresAt > input.now) {
    const msUntilExpiry = input.expiresAt - input.now;
    if (msUntilExpiry <= input.warnThresholdMs) {
      return { kind: "expiring_soon", expiresAt: input.expiresAt, hasRefreshToken: input.hasRefreshToken, msUntilExpiry };
    }
    return { kind: "healthy" };
  }
  // expiresAt is in the past — one of the two auth-hold cases.
  return input.hasRefreshToken ? { kind: "renewable" } : { kind: "reauth_required" };
}

// ── build-an-account-that-needs-a-human-login-says-so-instead-of-hiding-as-capped Phase 1 ────────
// `decideHeldAccountRecovery` — the pure predicate the sweep consults for accounts that are ALREADY
// held out of rotation. When the CEO re-authenticates, the credentials file gets rewritten with a
// fresh `expiresAt` in the future + a `refreshToken`. Today the sweep only calls `decideSweepAction`
// (which is about ejecting healthy accounts), and skips accounts already held — so a re-authed
// account sits at `cappedUntil = now + 25h` until an operator hand-edits the heartbeat. That is the
// exact behaviour the 2026-08-02 incident produced: two accounts came back healthy within the hour
// and the box refused to use them for a full day.
//
// The predicate answers ONE question: "given this held account and its on-disk credentials, should
// we release the hold on this sweep tick?" A `release` means the hold is cleared (cappedUntil = 0,
// holdReason = null) so the account rejoins rotation on the next pick. A `hold` reports why the
// release did not fire — either because the hold is not an auth-shape hold (a usage_cap only clears
// at its reset time; the file says nothing about it) or because the credentials still read invalid.
//
// The three rules map 1:1 to the spec's decision table:
//
//   1. holdReason === 'usage_cap' (or null)                         → hold, not_auth_hold
//        A usage wall is a real quota with its own reset time; re-reading the credentials file
//        cannot answer whether it has cleared. A `null` reason is an unclassified hold — we do not
//        release something we cannot substantiate as an auth hold. This preserves the invariant
//        that a restart cannot become a shortcut around a real quota wall.
//
//   2. holdReason ∈ {auth_expired, refresh_failed, reauth_required}
//      AND expiresAt > now
//      AND hasRefreshToken                                          → release
//        A future expiry on disk means the credentials file has been rewritten by a successful
//        login (or auto-refresh) AFTER the eject. Requiring `hasRefreshToken` guards against a
//        transient state where the file was mid-write with a fresh expiresAt but no refreshToken.
//        `reauth_required` is treated equivalently to `auth_expired` / `refresh_failed` — the
//        underlying condition is the same (an auth-shape hold whose credentials now read valid);
//        the older label was added by a prior spec iteration and still exists in the pool.
//
//   3. otherwise                                                    → hold, still_invalid
//        An auth-shape hold whose credentials do NOT yet read valid (expiresAt still in the past,
//        or no refreshToken). Keep the hold in place; the sweep will check again on the next tick.
//
// This is a disk-read predicate — no API call, no side effect. Safe to run every sweep tick.
export type HeldAccountRecovery =
  | { kind: "release" }
  | { kind: "hold"; reason: "not_auth_hold" | "still_invalid" };

export function decideHeldAccountRecovery(input: {
  holdReason: AccountHoldReason | null;
  expiresAt: number;
  hasRefreshToken: boolean;
  now: number;
}): HeldAccountRecovery {
  const r = input.holdReason;
  if (r == null || r === "usage_cap") {
    return { kind: "hold", reason: "not_auth_hold" };
  }
  if (
    (r === "auth_expired" || r === "refresh_failed" || r === "reauth_required") &&
    input.expiresAt > input.now &&
    input.hasRefreshToken
  ) {
    return { kind: "release" };
  }
  return { kind: "hold", reason: "still_invalid" };
}
