# `src/lib/repeat-verdict-breaker.ts` — stop a per-target job that keeps returning the same verdict

The box worker checks every claimed job against its recent history before running it ([[builder-worker]] `runJob` → `skippedByRepeatVerdictBreaker`). If a per-target job's last few runs all ended with the identical verdict line and nothing changed since, the worker marks the job `completed` without running it, with `error='repeat-verdict-breaker'`.

## Why

On 2026-10-07/08 the pre-merge `spec-test` for `agent-grade-spec-phase-position-query-fix` ran every ~5 min with the same `needs_human — ✅3 ✗0 👤1 ?0` line. That was 2,207 runs since 2026-10-01, each one a Max session and a lane slot, and nothing surfaced it. The enqueuer bug was fixed separately ([[agent-jobs]] `fixPhaseChangedSinceLatestRun`). This breaker is the general backstop: whatever enqueues the loop, the claim side caps it and makes it visible.

## Exports

- `decideRepeatVerdict(job, priorRuns, nowMs, lastCodeChangeAt, threshold?, cooldownMs?) → { skip: false } | { skip: true, verdict, repeats, lastRunAt }`. This is the pure decision. It skips only when all of these hold:
  - the kind is in `BREAKER_KINDS`;
  - the job wasn't human-created (`created_by` is null);
  - the newest `threshold` finished runs, breaker skips excluded, are all `completed` with the same non-empty verdict line;
  - the newest of those finished less than `cooldownMs` ago;
  - no `build` / `pr-resolve` on the same `spec_slug` updated after it.
- `verdictLine(logTail)` returns the first line of `log_tail`.
- `BREAKER_KINDS` holds the per-target kinds: `spec-test`, `security-review`, `repair` and `audit-spec-shipped-state`. Sweeps such as `platform-director`, `research`, `fold` and the grading passes repeat their summary by design. `pr-resolve` is excluded because a PR can go dirty again at any moment, and `mario` has its own loop guard.
- `BREAKER_REPEAT_THRESHOLD` (env `REPEAT_VERDICT_BREAKER_THRESHOLD`, default 3).
- `BREAKER_COOLDOWN_MS` (env `REPEAT_VERDICT_BREAKER_COOLDOWN_MS`, default 6h). Once tripped, one real run per window still goes through, so a target whose state changes recovers by itself.
- `BREAKER_SKIP_ERROR` (`'repeat-verdict-breaker'`) is the `agent_jobs.error` stamp on a skipped row.

## Visibility

The first skip after a real run writes one [[../tables/director_activity]] row (`action_kind='repeat_verdict_breaker_tripped'`, `director_function='platform'`). The row names the kind, target and repeated verdict. A spike of these rows means some enqueuer is re-running work without changing its inputs.

## Failure mode

Fails open. Any read error runs the job as normal.

Tests: `npm run test:repeat-verdict-breaker`.
