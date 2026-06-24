# Fix the error-reconcile endless loop — close errors to terminal + cooldown ⏳

**Priority:** critical

**Owner:** [[../functions/platform]] · **Parent:** [[director-zero-backlog-error-autonomy]] — fixes the reconcile that churns instead of draining, under [[../goals/devops-director]]
**Found in use 2026-06-24:** 13 open [[../tables/error_events]] (oldest 2026-06-22) reconciled **126 times in 60 minutes** — the same ~10 signatures, 9–19× each, several times per standing pass. 14 [[../libraries/repair-agent|repair]] jobs COMPLETED in that hour but the error rows stayed `open`. Root cause: the disposition never flips the error_events row to terminal, so every pass re-reconciles + re-enqueues — an endless loop that drains nothing AND eats the standing pass (starving build initiation — the box sat 0/8 while this churned).

## North star — every error reaches terminal exactly once; the reconcile never re-churns

The reconcile's job is to GUARANTEE each open error reaches a terminal state (fixed / resolved-pending-deploy / parked-external), not to re-enqueue a repair forever. A loop that re-processes the same signature every pass is the degenerate proxy state — it must be impossible.

## Phase 1 — drive each disposition to a TERMINAL error state ⏳
- When a repair job completes its verdict for a signature, the corresponding error_events row(s) MUST transition out of `open`: `real-bug` with a fix authored/building → `resolved` (fix in-flight / pending-deploy, so it stops re-firing); `transient`/`foreign`/`already-fixed` → `resolved`/closed with the reason; `needs-human` → a terminal `needs_attention`-equivalent that the reconcile no longer re-enqueues. The reconcile GUARANTEES this transition rather than leaving the row open.
- One-shot: disposition + close the 13 currently-stuck errors (the 06-22/06-23 supabase/vercel/inngest backlog).
- Brain: [[../libraries/repair-agent]] · [[../tables/error_events]] · [[../libraries/platform-director]] (the reconcile lane).

### Verification — Phase 1
- A repair job completing flips its error_events row(s) off `open` to a terminal state with a recorded reason. The 13 stuck errors disposition + close. Open-error count trends to 0 and stays there.

## Phase 2 — cooldown + once-per-pass dedup (stop the churn) ⏳
- The reconcile SKIPS an error it reconciled within a cooldown window, and processes each signature at most ONCE per standing pass. A signature with a live/recent repair job is confirmed in-flight — never re-enqueued. This kills the 126×/hour re-processing and returns the standing pass to build initiation.
- Brain: [[../libraries/platform-director]] (the reconcile lane) · [[../tables/director_activity]] (the dedup ledger).

### Verification — Phase 2
- Across consecutive passes, a still-open error is reconciled at most once per pass (not 9–19×/hour); a signature with an in-flight repair is confirmed, not re-enqueued. The reconciled_error action count per hour drops to roughly (open errors), not 100+.

## Phase 3 — loop-guard a stuck error + visibility ⏳
- If a signature has been reconciled ≥ a cap without reaching terminal (Rafa genuinely can't dispose of it), STOP re-enqueuing and escalate to the CEO ('stuck error — repair can't resolve it') — mirroring the build loop-guard. Surface open-error count + reconcile churn-rate on the [[Platform Department Scorecard]] so a loop is visible instantly, never silent.

### Verification — Phase 3
- An error Rafa can't terminally dispose of after the cap → one CEO escalation, no further churn. The scorecard shows open-error count + churn rate; a runaway loop is visible immediately.

## Open decision (for the CEO)
For the oldest 06-22 supabase-logs errors that may be genuinely foreign/external: auto-park them terminal as 'external/won't-fix' (default — they're 2+ days old and undrained), or escalate each to you once for a keep/park call. Default: auto-park with the reason logged, reversible.