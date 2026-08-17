/**
 * pr-create-diagnostic — pure formatter for the diagnostic string the box worker's `ensurePr` returns
 * when its retries exhaust. Stashed into `agent_jobs.log_tail` on a
 * `needs_attention_class='tooling_failure'` park so a human triaging the parked job sees the ACTUAL
 * GitHub HTTP status + body of every attempt — not the unrelated Claude usage metadata the previous
 * generic log_tail carried (the failure that spawned Fix 1 of
 * [[../specs/a-merge-stamps-only-the-phases-whose-code-it-actually-contains]]: parked build job
 * c5c168bc, "branch pushed but PR creation failed", log tail showed only Claude token counts).
 *
 * Kept in `src/lib/` (importable by the box worker + `--test`-runnable) so the format is unit-covered
 * without spawning the whole worker.
 */

export interface EnsurePrAttempt {
  /** 1-based attempt number. */
  attempt: number;
  /** HTTP status of the failed `POST /repos/…/pulls` call — or `null` when the fetch itself threw. */
  status: number | null;
  /** Raw response body (may be JSON or HTML). Truncated by the formatter — pass the raw string in. */
  body: string;
}

const PER_ATTEMPT_CAP = 400;

export function formatPrCreateFailureDiagnostic(attempts: EnsurePrAttempt[]): string {
  if (attempts.length === 0) {
    return "ensurePr: no attempts recorded (unexpected — treat as a worker-internal bug)";
  }
  const header = `PR-create failed after ${attempts.length} attempt(s) — a human should inspect the ACTUAL GitHub errors below (not the surrounding Claude usage metadata):`;
  const lines = attempts.map((a) => {
    const status = a.status === null ? "(fetch threw)" : String(a.status);
    const bodyOneLine = a.body.replace(/\s+/g, " ").trim().slice(0, PER_ATTEMPT_CAP);
    return `  attempt ${a.attempt} (HTTP ${status}): ${bodyOneLine}`;
  });
  return `${header}\n${lines.join("\n")}`;
}
