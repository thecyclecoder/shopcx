/**
 * Repeat-verdict breaker — the box worker refuses to re-run a per-target agent job whose last few runs
 * all ended with the identical verdict line. A target that keeps producing the same answer isn't
 * progressing, so another run only burns a Max session and a lane slot. The 2026-10-07/08 incident:
 * `spec-test` on agent-grade-spec-phase-position-query-fix re-ran every ~5 min with the identical
 * `needs_human — ✅3 ✗0 👤1 ?0` line, 2,207 times since 2026-10-01, and nothing surfaced it.
 *
 * Whatever enqueues the job, the breaker catches the loop at claim time. It doesn't fix the enqueuer.
 * It caps the damage at one run per cooldown window and makes the loop visible (one
 * `director_activity` row per target per window), so the enqueuer bug gets found instead of hidden.
 *
 * Scope: only the per-target kinds in `BREAKER_KINDS`, and never a human-created run (`created_by` set,
 * e.g. an owner's Re-run click). Sweeps (`platform-director`, `research`, `fold`, grading passes) repeat
 * the same summary line by design and are out of scope. `pr-resolve` (a PR can go dirty again at any
 * moment) and `mario` (has its own loop guard) are out of scope too. A `build` or `pr-resolve` on the
 * target after the newest repeat means the code changed, so the breaker lets the run through.
 */

/** Kinds whose `spec_slug` names one target (a spec, a PR, an error signature). */
export const BREAKER_KINDS: ReadonlySet<string> = new Set([
  "spec-test",
  "security-review",
  "repair",
  "audit-spec-shipped-state",
]);

/** Consecutive identical verdicts that trip the breaker. */
export const BREAKER_REPEAT_THRESHOLD = Number(process.env.REPEAT_VERDICT_BREAKER_THRESHOLD || 3);

/** Once tripped, one run is still allowed per this window, so a target whose state changes recovers. */
export const BREAKER_COOLDOWN_MS = Number(process.env.REPEAT_VERDICT_BREAKER_COOLDOWN_MS || 6 * 60 * 60 * 1000);

/** `agent_jobs.error` stamped on a run the breaker skipped. Prior-run reads exclude these rows. */
export const BREAKER_SKIP_ERROR = "repeat-verdict-breaker";

/** A finished prior run of the same (kind, spec_slug), newest first, breaker skips excluded. */
export interface PriorRun {
  status: string;
  log_tail: string | null;
  updated_at: string;
}

/** The verdict line a run ended with: the first line of its `log_tail`. Runs match only on identical text. */
export function verdictLine(logTail: string | null): string {
  return (logTail ?? "").split("\n")[0].trim().slice(0, 300);
}

export type BreakerDecision = { skip: false } | { skip: true; verdict: string; repeats: number; lastRunAt: string };

/**
 * Pure decision. Skip iff the newest `BREAKER_REPEAT_THRESHOLD` finished runs are all `completed`
 * with the same non-empty verdict line, the newest finished less than `BREAKER_COOLDOWN_MS` ago, and
 * no build/pr-resolve touched the target after it.
 */
export function decideRepeatVerdict(
  job: { kind: string; created_by?: string | null },
  priorRuns: readonly PriorRun[],
  nowMs: number,
  /** Newest `updated_at` of a build/pr-resolve on the same target, or null. */
  lastCodeChangeAt: string | null,
  threshold = BREAKER_REPEAT_THRESHOLD,
  cooldownMs = BREAKER_COOLDOWN_MS,
): BreakerDecision {
  if (!BREAKER_KINDS.has(job.kind) || job.created_by) return { skip: false };
  if (threshold < 2 || priorRuns.length < threshold) return { skip: false };
  const window = priorRuns.slice(0, threshold);
  const first = verdictLine(window[0].log_tail);
  if (!first) return { skip: false };
  if (!window.every((r) => r.status === "completed" && verdictLine(r.log_tail) === first)) return { skip: false };
  const lastMs = Date.parse(window[0].updated_at);
  if (Number.isNaN(lastMs) || nowMs - lastMs >= cooldownMs) return { skip: false };
  if (lastCodeChangeAt && Date.parse(lastCodeChangeAt) > lastMs) return { skip: false };
  return { skip: true, verdict: first, repeats: threshold, lastRunAt: window[0].updated_at };
}
