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
      clearHold:
        input.holdReasonBefore === "auth_expired" ||
        input.holdReasonBefore === "refresh_failed",
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
