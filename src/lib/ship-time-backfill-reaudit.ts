/**
 * ship-time-backfill-reaudit — pure classifiers for
 * [[../../docs/brain/specs/ship-time-backfill-executor-passes-apply]] Phase 2.
 *
 * Phase 1 fixed the executor to pass `--apply`, but it did nothing about the ~14 `data_op_runs`
 * rows already marked `ran` by the OLD executor — those APPLY-gated scripts only dry-ran, so some
 * may never have written. They are idempotent, so a fresh DRY-RUN re-check is safe:
 *   - a dry run that still reports pending work ⇒ the script never wrote ⇒ reset the row to
 *     `pending` so the Phase-1 executor re-drains it WITH `--apply`.
 *   - a dry run that reports a no-op ⇒ the data is already in place ⇒ leave the row `ran`.
 *   - a dry run whose output is ambiguous, errors, or whose script is gone / is a surgical
 *     one-customer fix ⇒ NOT auto-re-run (re-applying a one-off refund could double-charge) ⇒
 *     escalate to the founder on a single CEO card to decide.
 *
 * These two predicates are the whole judgment, kept pure + unit-tested so the "flip vs leave vs
 * escalate" fork can't silently regress. `scripts/_backfill-reaudit-dry-run-ledger-rows.ts` is the
 * I/O shell that spawns each dry run and applies the verdict through the ledger's own writers.
 */

/** The single CEO-card dedupe key for the whole reaudit pass (one card, bumped — never a spam fan). */
export const REAUDIT_DEDUPE_KEY = "backfill-reaudit";

/** `dashboard_notifications.metadata.escalation_kind` the reaudit card carries. */
export const REAUDIT_ESCALATION_KIND = "ship_time_backfill_reaudit";

/**
 * True iff a backfill script is APPLY-GATED — i.e. dry-run by default, writing only when passed
 * `--apply` / `APPLY=1`. Those are the scripts the OLD executor could silently no-op; a script with
 * NO gate (it always writes) DID write on its original run and must NOT be reset. Detected from the
 * source text: the convention is `process.argv.includes("--apply")` and/or `process.env.APPLY`.
 */
export function scriptHasApplyGate(source: string): boolean {
  if (typeof source !== "string" || source.length === 0) return false;
  const hasApplyFlag = /process\.argv[\s\S]{0,40}?["']--apply["']/.test(source);
  const hasApplyEnv = /process\.env\.APPLY/.test(source);
  return hasApplyFlag || hasApplyEnv;
}

/** Verdict for a historical `ran` row's fresh dry-run output. */
export type ReauditVerdict = "noop" | "pending" | "ambiguous";

/**
 * Classify an APPLY-gated backfill's DRY-RUN stdout.
 *   - `pending`   — a positive, structured would-write COUNT (`would-write=3`, `would update 5`,
 *     `would insert 2`) ⇒ real work remains ⇒ reset the row and re-drain (safe: idempotent batch).
 *   - `noop`      — an explicit no-op signal (`no-op`, `nothing to do`, `0 rows`, `would update 0`,
 *     `would-write=0`, `scanned=0`) and NO positive count ⇒ already applied ⇒ leave `ran`.
 *   - `ambiguous` — neither a clean count nor a clean no-op (e.g. a surgical one-customer fix that
 *     prints prose like "would insert Brittany's coupon" with no counter) ⇒ escalate, never auto-run.
 *
 * The positive-count check runs FIRST so a summary line like `no-op=2 would-write=3` (which also
 * contains the substring `no-op`) is correctly read as pending work, not a no-op.
 */
export function classifyReauditDryRun(stdout: string): ReauditVerdict {
  const t = (stdout || "").toLowerCase();
  // 1. A structured would-write/update/insert count > 0 ⇒ pending work.
  const work = t.match(/would[-\s](?:write|update|insert|flip|fill)[=:\s]+(\d+)/);
  if (work && Number.parseInt(work[1], 10) > 0) return "pending";
  // 2. An explicit no-op signal (and no positive count above) ⇒ already applied.
  if (/no-op|nothing to do|0 rows|would update 0|would-write=0|would write 0|written=0|scanned=0\b/.test(t)) {
    return "noop";
  }
  // 3. Neither ⇒ ambiguous (surgical one-off / unrecognized output) ⇒ founder decides.
  return "ambiguous";
}
