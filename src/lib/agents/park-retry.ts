/**
 * libraries/park-retry — should a parked `agent_jobs` row be RE-DRIVEN before it becomes a founder's
 * problem?
 *
 * ## The failure this exists to prevent
 *
 * A `needs_attention` park is effectively terminal: nothing retries it, and the founder cannot act on
 * it either (`approveRoadmapAction` hard-requires `needs_approval`, so a park card can only offer
 * "Dismiss"). When the thing that CAUSED the park is a code-side defect, fixing that defect does not
 * revive the parked work — it just leaves a card describing a problem that no longer exists.
 *
 * Ground truth, 2026-08-10/11. June (`cs-director-call`) found a real product gap — internal renewal
 * orders were not injecting the customer's name into `shippingAddress` — and tried to author a spec
 * for it. The author chokepoint rejected her seed at **14:25:39Z** because a phase carried no
 * machine-runnable check. That authoring defect was fixed in #2424 at **14:30:14Z — 4 minutes and 35
 * seconds later**, and the three `cs-director-call` jobs that ran after it all completed cleanly. But
 * the parked job was never re-driven, so:
 *
 *   - the spec was NEVER authored — June's finding was silently lost (the underlying bug survived
 *     only because a human happened to fix it by hand in #2436), and
 *   - the founder was left with an unactionable card, titled with a bare ticket UUID and bodied with
 *     a raw error dump, describing a doubly-obsolete problem.
 *
 * The lost work is the serious half. A card is noise; a dropped finding is a defect that ships.
 *
 * ## The rule
 *
 * A park is worth re-driving when BOTH hold:
 *   1. the job kind is safely re-runnable (read-only analysis that produces no side effects until it
 *      succeeds — the same set the worker's orphan-reaper already re-queues), and
 *   2. the error is a DETERMINISTIC CODE-SIDE REJECTION — a validation rail said no. Those are
 *      exactly the failures a subsequent deploy can fix, which makes "try again later" meaningful.
 *
 * Deliberately NOT retried: infrastructure/outage errors (a retry is a coin flip, and the existing
 * backstop already handles them), and anything ambiguous. When in doubt this returns `false` and the
 * park escalates exactly as it does today.
 *
 * Bounded by `PARK_RETRY_MAX` attempts spaced `PARK_RETRY_MIN_INTERVAL_MS` apart, so a genuinely
 * broken job costs a small, fixed number of cheap re-runs and then escalates with a card that finally
 * says something useful: "retried N times across code changes, still failing."
 */

/**
 * Job kinds that are safe to flip back to `queued`. MIRRORS the worker's `RERUNNABLE_KINDS`, which
 * the startup orphan-reaper already re-queues on the stated grounds that a re-run loses no work.
 *
 * This lives HERE, not in `scripts/builder-worker.ts`, because importing that module BOOTS THE WORKER
 * (module-level main loop + reaper) — a unit test that did so once healed a developer's worktree back
 * to main and discarded uncommitted work. The worker imports this set rather than declaring its own,
 * so the two cannot drift.
 */
export const RERUNNABLE_JOB_KINDS: ReadonlySet<string> = new Set([
  "spec-test",
  "triage-escalations",
  "migration-fix",
  "dev-ask",
  "pr-resolve",
  "repair",
  "regression",
  "storefront-optimizer",
  "db_health",
  "coverage-register",
  "platform-director",
  "director-bounce-back",
  "growth-director",
  "proposed-goal",
  "deploy-review",
  "cs-director-call",
  "playbook-compile",
  "prompt-review",
  "mario",
]);

/**
 * Error fingerprints that mean "a validation rail rejected this", i.e. a code-side defect a deploy
 * can fix. Matched case-insensitively against `agent_jobs.error`.
 *
 * Each entry is a rail that has ACTUALLY parked a job in production. Keep this list narrow — a
 * signature added here buys a re-run, and a signature that is really an outage buys a wasted one.
 */
const RETRYABLE_PARK_SIGNATURES: readonly RegExp[] = [
  // The author chokepoint's own guards. The measured case: a phase whose checks were prose-only.
  /no machine-runnable verification/i,
  /zero auto-testable checks/i,
  /author_spec:\s*SDK threw/i,
  /author_spec:\s*SDK returned false/i,
  // The parent/anchor resolver rejecting a seed — the class Dylan's notes call "bare-function parent".
  /InvalidParentError/i,
  // The spec-body guards a malformed seed trips.
  /spec-body-empty/i,
];

/** Max re-drives per parked job before it escalates for real. */
export const PARK_RETRY_MAX = Number(process.env.PARK_RETRY_MAX || 2);
/**
 * Minimum spacing between re-drives. The point of spacing is to straddle a DEPLOY: retrying a
 * validation rejection thirty seconds later just reproduces it, whereas six hours later the fix may
 * well have shipped (in the measured case it shipped in under five minutes).
 */
export const PARK_RETRY_MIN_INTERVAL_MS = Number(process.env.PARK_RETRY_MIN_INTERVAL_MS || 6 * 60 * 60 * 1000);

/** Does this park's error look like a deterministic code-side rejection? Pure. */
export function isRetryableParkError(error: string | null | undefined): boolean {
  if (!error) return false;
  return RETRYABLE_PARK_SIGNATURES.some((re) => re.test(error));
}

export interface ParkRetryDecision {
  retry: boolean;
  /** Why — surfaced in the ledger + the eventual escalation so the decision is auditable. */
  reason: string;
}

/**
 * The full decision. Pure so the branch order is unit-testable without a Supabase seam.
 *
 * `priorRetries` / `lastRetryAt` come from the `director_activity` ledger (the same ledger the router
 * already reads), so the count survives a worker restart and cannot be lost to in-memory state.
 */
export function decideParkRetry(input: {
  kind: string;
  error: string | null;
  priorRetries: number;
  lastRetryAt: Date | null;
  now: Date;
}): ParkRetryDecision {
  if (!RERUNNABLE_JOB_KINDS.has(input.kind)) {
    return { retry: false, reason: `kind '${input.kind}' is not safely re-runnable` };
  }
  if (!isRetryableParkError(input.error)) {
    return { retry: false, reason: "park error is not a known code-side validation rejection" };
  }
  if (input.priorRetries >= PARK_RETRY_MAX) {
    return { retry: false, reason: `re-drive cap reached (${input.priorRetries}/${PARK_RETRY_MAX}) — escalate for real` };
  }
  if (input.lastRetryAt) {
    const sinceMs = input.now.getTime() - input.lastRetryAt.getTime();
    if (sinceMs < PARK_RETRY_MIN_INTERVAL_MS) {
      return {
        retry: false,
        reason: `last re-drive was ${(sinceMs / 3_600_000).toFixed(1)}h ago (< ${(PARK_RETRY_MIN_INTERVAL_MS / 3_600_000).toFixed(0)}h spacing) — wait for a deploy`,
      };
    }
  }
  return {
    retry: true,
    reason: `code-side validation rejection on a re-runnable kind; re-drive ${input.priorRetries + 1}/${PARK_RETRY_MAX}`,
  };
}
