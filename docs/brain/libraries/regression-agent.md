# libraries/regression-agent

The queue plumbing + autonomy policy behind the **Regression Agent** box worker ([[../specs/regression-agent]] Phase 1) — a worker the [[../specs/platform-director-agent|Platform/DevOps Director]] supervises ([[../goals/devops-director]] M6). It does exactly what the operator did by hand: **review each regression and either dismiss it or author a fix spec** — then the DevOps Director queues the build (within its leash).

**File:** `src/lib/regression-agent.ts` · the box runner is `scripts/builder-worker.ts` `runRegressionJob` (see [[../recipes/build-box-setup]]).

## What a "regression" is

A thing that **used to work and now doesn't** — distinct from a brand-new error (those stay with the [[repair-agent]]). Phase 1's concrete detector is **spec-test-✅-now-failing**: a spec marked ✅ shipped whose `## Verification` no longer holds — an evidence-backed `fail` check on its latest [[spec_test_runs]] run (a false-✅ / drift caught by [[../specs/spec-test-deep-verification]]).

## North star — author + dismiss; the director disposes

The agent **authors + dismisses** (a bounded proxy: "is this a real regression + here's the fix"); the **DevOps Director (objective owner) queues the build** and is graded on whether the fix held ([[../operational-rules]] § North star, [[director-loop-grading]]). More autonomous than the repair agent — it **skips the "propose" step and authors the fix spec directly** (a regression is a confirmed break, not a hypothesis to pitch) — but it still never builds/merges on its own. A *repeatedly-failing* fix → loop-guard escalates to CEO. Every detect/dismiss/author/escalate writes a [[../tables/director_activity|director_activity]] row.

## Exports

- `type RegressionVerdict = "real-regression" | "transient" | "foreign" | "false-positive" | "already-fixed" | "needs-human"` — the box's per-regression verdict.
- `REGRESSION_DISMISS_VERDICTS: Set<string>` — the four dismiss verdicts (`transient｜foreign｜false-positive｜already-fixed`): reviewed away with recorded reasoning, no spec authored.
- `REGRESSION_NO_RESURFACE_VERDICTS: Set<string>` — the dismiss verdicts that permanently BLOCK re-surface of the same break (`transient｜foreign｜false-positive`). `already-fixed` is EXCLUDED — it's a transient "a fix is in-flight, pending deploy" state, so the break may re-fire if that fix doesn't hold.
- `REGRESSION_DIRECTOR_FUNCTION = "platform"` — the function whose objective supervises this worker.
- `REGRESSION_LOOP_GUARD_MAX = 2` — authored fix attempts for a spec before the box escalates to CEO instead of re-authoring (the deeper-issue guard).
- `REGRESSION_RECENT_WINDOW_MS` (7 days) — the window the loop-guard counts attempts over + a dismissal blocks re-surface over.
- `regressionSignature(specSlug, failingKeys)` → `regression:{slug}:{sha1(sorted keys).slice(0,12)}` — the dedupe key. Same spec + same failing checks = one signature (one review, no re-surface); a NEW failing check on the same spec is a distinct signature (a genuinely new break gets its own review).
- `enqueueRegressionJob(admin, { workspaceId, specSlug, title, failing, runAt })` → enqueue ONE `regression` [[agent_jobs]] job. Deduped by signature — no-op if a live job for it exists, or if a recent terminal job for it was **dismissed** (no re-surface). An authored-but-not-held fix does NOT block (the loop-guard handles re-fire). Records the `detected_regression` [[../tables/director_activity|activity]] row. **Best-effort, never throws.**
- `regressionAuthoredAttempts(admin, specSlug, selfJobId)` → how many prior authored fix attempts exist for this spec in the window (the loop-guard ledger; a fix that didn't hold re-fires and counts up to the cap).
- `getOpenRegressions(admin, workspaceId)` → `RegressionSurfaceItem[]` — READ-ONLY: open regression items awaiting the disposer (`needs_approval` = a routed fix with a queue-Build action, or `needs_attention` = needs-human / loop-guard escalation). Auto-queued + dismissed jobs complete silently.

## Trigger — event-driven (NOT a cron)

A spec-test run flipping a ✅ spec to a `fail` IS the trigger. `enqueueRegressionJob` is called inline at the end of `scripts/builder-worker.ts` `runSpecTestJob`: when `agent_verdict === "issues"`, it reads `getHumanTestQueue` ([[spec_test_runs]] — the exact regression definition: shipped + unarchived + UNRESOLVED evidence-backed fails) and enqueues a review for the slug just tested. (The spec lists two further detectors — tsc/CI-regression and ship-correlated error — that reuse the same `enqueueRegressionJob`; the ship-correlated path is deliberately deferred to the [[repair-agent]] to avoid double-handling brand-new errors.)

## The box loop — `runRegressionJob`

1. **Disposer resume** — a routed `regression_build` action approved (queue the build) / declined (dismiss).
2. **Already-fixed skip** (`findInflightRegressionFix`) — a prior authored fix for this spec is still building / pending deploy → no-op the daily re-fire (`already-fixed`, no re-review, doesn't count toward the loop-guard).
3. **Loop-guard** — `regressionAuthoredAttempts ≥ REGRESSION_LOOP_GUARD_MAX` → escalate to CEO (`needs_attention` + `escalated` activity), no re-author.
4. **Review** (Max, read-only, web search) → ONE verdict:
   - dismiss verdict → record reasoning on the job + `dismissed_regression` activity; no spec; the signature won't re-surface.
   - `needs-human` → `needs_attention`, no spec.
   - `real-regression` → **author the fix spec directly to main** (`authorRegressionFixSpec`), then route via `resolveApproverLive('platform')` ([[../libraries/approval-router]]): a live+autonomous director auto-queues the build within its leash; else surface for the **CEO inbox** (pre-M4). Records `authored_fix`.
   - **Unparseable/unrecognized verdict** ([[../specs/needs-attention-triage-and-verdict-robustness]] Phase 2) → the shared `resolveReviewVerdict` helper (shared with [[repair-agent]] + [[security-agent]]) RE-RUNS the review **once**, then fail-safes to an **actionable** `needs_attention` reason — `"regression review produced no parseable verdict after 2 attempts — re-run or review manually: <excerpt>"` — never a bare "ended without a recognizable verdict", never assume-resolved. The director's `reconcileNeedsAttention` ([[platform-director]] Phase 1) then triages that parked item.

## Related

[[../specs/regression-agent]] · [[repair-agent]] · [[../specs/spec-test-deep-verification]] · [[spec_test_runs]] · [[director-activity]] · [[../tables/director_activity]] · [[approval-router]] · [[../goals/devops-director]] · [[../specs/platform-director-agent]]
