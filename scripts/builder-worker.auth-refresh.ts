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

export type AccountHoldReason = "usage_cap" | "auth_expired" | "refresh_failed";

export type SweepAction =
  | { kind: "skip"; reason: "no_signal_or_valid" | "refresh_in_flight" | "throttled_after_success" }
  | { kind: "refresh" }
  | { kind: "eject"; holdReason: "auth_expired" | "refresh_failed" };

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
    return { kind: "eject", holdReason: "auth_expired" };
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
