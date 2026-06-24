# Triage every needs_attention item + harden review-agent verdicts ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — the director supervises the build/QC pipeline's parked items under [[../goals/devops-director]]
**Found in use 2026-06-24:** [[director-executable-plans-and-priority-board-pip]] built + merged + passed spec-test, but its post-merge SECURITY-REVIEW returned `needs_attention` with `security review ended without a recognizable verdict` — and nothing handled it; it just sat. Two confirmed gaps: (1) the director's loop-guard treats `needs_attention` as a failed attempt ONLY for `kind='build'` jobs (`FAILED_BUILD_STATUSES` in [[../libraries/platform-director]] is read by `specBuildState`, which queries `kind='build'`), so a `needs_attention` on a NON-build QC job (security-review / spec-test / repair / regression) is triaged by NOTHING. (2) `ended without a recognizable verdict` is a SYSTEMIC bare fallback — `scripts/builder-worker.ts` sets it for the security-review, repair (`repair ended without a recognizable verdict`), and regression (`regression review ended without a recognizable verdict`) agents alike — giving the human no actionable reason.

## North star — nothing parked rots silently; an inconclusive verdict is actionable

`needs_attention` is the right 'automation can't resolve this, a human looks' stop — but a stop with no owner and no reason is how work rots. The director must triage every parked item (re-run the recoverable, surface the rest with a clear diagnosis), and a review agent must never degrade an inconclusive result to a bare, reasonless flag. Fail-safe stays conservative (inconclusive → human-needed, never a silent pass).

## Phase 1 — director sweep triages every non-build needs_attention item ⏳
- Add `reconcileNeedsAttention(admin)` to [[../libraries/platform-director]], run in `runPlatformDirectorStandingPass` (dormant until live+autonomous, like the other lanes). It finds `agent_jobs` in `needs_attention` across ALL kinds NOT already covered by the build loop-guard (security-review, spec-test, repair `needs-human`, regression, proposed-goal/greenlight commit failures, etc.).
- Per item, classify: RECOVERABLE (a transient/inconclusive QC result — e.g. a review that produced no parseable verdict → re-run the step ONCE) vs HUMAN-NEEDED (a real blocker — e.g. a genuine security finding, a missing artifact → surface a CLEAR CEO diagnosis with the reason + excerpt, not a bare 'needs attention'). Loop-guarded: a re-run that fails again escalates, never churns. Deduped per job. Writes a `triaged_needs_attention` [[../tables/director_activity]] row.
- Brain: [[../libraries/platform-director]] · [[../tables/agent_jobs]] · `scripts/builder-worker.ts` (the standing pass).

### Verification — Phase 1
- A security-review/spec-test job in `needs_attention` with an inconclusive verdict → re-run once on the next standing pass (recoverable) + a `triaged_needs_attention` activity row; a genuinely-blocked item → a CEO diagnosis carrying the actual reason (not a bare flag). A re-run that fails twice → escalates, no churn. A `kind='build'` needs_attention is left to the existing build loop-guard (no double-handling).

## Phase 2 — harden the review agents' verdict parsing (kill the bare fallback) ⏳
- The verdict extraction for the security-review, repair, and regression agents must always resolve to a recognizable outcome: parse the verdict robustly; on an unparseable/empty result, RETRY once, then fail-safe to an ACTIONABLE `needs_attention` reason — `"<agent> produced no parseable verdict after 2 attempts — re-run or review manually: <excerpt>"` — never a bare `ended without a recognizable verdict`. Conservative default (inconclusive → human-needed, never auto-pass / auto-approve).
- One shared helper for the three agents so the fallback message + retry are consistent.
- Brain: `scripts/builder-worker.ts` (security-review / repair / regression verdict parsing) · [[../libraries/repair-agent]] · [[../libraries/regression-agent]].

### Verification — Phase 2
- A review agent returning unparseable output retries once, then parks with a specific, actionable reason + excerpt (not a bare flag). It never auto-passes/auto-approves on an inconclusive result.

## Phase 3 — surface needs_attention as a tracked KPI ⏳
- Count + oldest-age of open `needs_attention` items on the [[Platform Department Scorecard]] + the daily board-watch ('N items need attention, oldest Xh'), and report what the director triaged each pass — so parked items are visible and don't rot.

### Verification — Phase 3
- The scorecard/board-watch shows the open needs_attention count + oldest age and the day's triage actions.

## Open decision (for the CEO)
How aggressive the auto-re-run is: (a) re-run an inconclusive QC step once before surfacing (default — most inconclusive verdicts are transient), or (b) surface every non-build needs_attention to you immediately with the reason, no auto-re-run. Default is (a) with the loop-guard backstop.