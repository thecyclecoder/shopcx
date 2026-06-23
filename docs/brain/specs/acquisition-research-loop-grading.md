# Acquisition Research — continuous loop + grading ✅

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/acquisition-research-engine]] (M5)
**Blocked-by:** [[acquisition-research-hub]]

Make it **constant research**, not a one-shot: a standing cadence that keeps the scouts running, plus the Growth-director grade that trains them.

## What it does
- **Standing cadence** — scheduled re-scans: re-run [[ad-creative-scout]] sweeps + [[landing-page-scout]] snapshots, **promote newly-surfaced heavy advertisers** ([[competitor-scout]]), surface **new** gaps (deduped against shipped/dismissed). Competitor landers + ad sets stay fresh.
- **Growth-director grade** — score each surfaced gap + the resulting action: *was the gap real? did the shipped enhancement / experiment win?* (mirrors the [[storefront-campaign-grading-loop]] hypothesis-vs-result grading). Grades train the scouts (which gap types convert) + tune what's surfaced.

## Phase 1 — the standing cadence + the gap/outcome grade ✅
A scheduled re-scan loop (fresh sweeps/snapshots + heavy-advertiser promotion + new-gap surfacing, deduped) + the 1–10 grade of gap→outcome that feeds back into what the scouts prioritize. Brain: [[../goals/acquisition-research-engine]] · [[competitor-scout]] · [[ad-creative-scout]] · [[landing-page-scout]] · [[acquisition-research-hub]] · [[storefront-campaign-grading-loop]].

**Built (code-complete, tsc-clean; migration NOT yet applied to prod):**
- `supabase/migrations/20260623150000_acquisition_gap_grades.sql` — two tables mirroring the storefront campaign-grading loop: [[../tables/acquisition_gap_grades]] (one grade row per surfaced gap — `grade_initial` + `grade_revised` both persist, `gap_quality`/`outcome_quality` scored **separately**, the derived `outcome_state`, `graded_by` ∈ agent｜human + override provenance) and [[../tables/acquisition_grader_prompts]] (the human-approved calibration store). Apply via `scripts/apply-acquisition-gap-grades-migration.ts`.
- `src/lib/acquisition-gap-grader.ts` ([[../libraries/acquisition-gap-grader]]) — `gradeGap` (1–10 grade of one acted-on gap, initial｜revised, idempotent), `gradeActedGaps` (the cadence sweep), `loadGapTypeGradeSignal` + `loadSuppressedGapTypes`/`isSuppressed` (the training signal: down-weight a low-graded gap_type so it stops being re-surfaced). Gap quality is scored **separately** from outcome (a well-evidenced gap that lost still scores high).
- `src/lib/inngest/acquisition-research-cadence.ts` ([[../inngest/acquisition-research-cadence]]) — the standing cron (`0 10 * * *`, after the 9am sweep) + a manual trigger (`ads/acquisition-research.cadence`): per ad-tool workspace it promotes heavy advertisers, re-materializes ad gaps (deduped, suppressed types skipped), fires `ads/landing-page-scout.analyze` (new lander gaps, deduped, suppressed types skipped), and runs `gradeActedGaps`. Registered in `registered-functions.ts`; emits a Control-Tower heartbeat.
- **Surfacing wired to the grade** — `materializeAdGaps` ([[../libraries/acquisition-hub]]) + `analyzeLanderGaps` ([[../libraries/landing-page-scout]]) skip a suppressed gap_type (the loop **learns**, not endlessly re-surfaces).
- **Visibility + override** — `loadHubData` attaches each gap's grade + a `gradeSignal` + `suppressedTypes`; the hub dashboard ([[../dashboard/marketing__acquisition]]) shows the avg-grade card, per-gap grades, the down-weighted types, and a one-click **Override**. `POST /api/ads/acquisition/grades/[id]` records the Growth-director override (`graded_by='human'`) + optionally proposes a calibration rule.

## Safety / invariants
- **Gap quality graded separately from outcome.** A well-evidenced gap that lost scores high `gap_quality`; a flimsy rejected gap scores low — the grader never rewards outcome luck (mirror [[storefront-campaign-grading-loop]]).
- **Both grades persist.** `grade_revised` never overwrites `grade_initial` — the at-action-time vs outcome-resolved gap stays auditable.
- **Human-overridable.** Every grade can be overridden by the Growth director; overrides are recorded and become proposed calibration rules — never silently lost.
- **Supervised tool** ([[../operational-rules]] § North star). The cadence only re-scans / proposes / grades; nothing auto-routes or auto-approves. The grade only TUNES what's surfaced.
- **Idempotent throughout.** Promotion, ad-gap materialization, lander analysis, and grading all dedup — daily re-runs never duplicate.

## Completion criteria
- The cadence re-scans on schedule (promote + ad-gap materialize + lander analyze + grade) and surfaces only NEW gaps (deduped). ✅
- Each acted-on gap + its outcome gets a 1–10 grade scoring gap quality independently of outcome, with reasoning; the grade history is visible on the hub. ✅
- The grade feeds back: a low-value/rejected gap type is down-weighted (suppressed) over time, and a human override path exists + is recorded. ✅

## Verification
- **Apply first:** `npx tsx scripts/apply-acquisition-gap-grades-migration.ts` → expect `✓ tables present: [ 'acquisition_gap_grades', 'acquisition_grader_prompts' ]`. In the DB, `\d acquisition_gap_grades` shows the `(workspace_id, gap_source, gap_id)` UNIQUE, the `outcome_state` + `graded_by` CHECKs, and the partial `…_pending_revised_idx`.
- **Cadence runs:** trigger `ads/acquisition-research.cadence { workspaceId }` (or wait for the `0 10 * * *` cron) → the run's `cadence-<ws>` step returns `{ promoted, adGaps, graded:{ considered, initial, revised } }`, a `lander-analyze-<ws>` event is sent, and the `acquisition-research-cadence-cron` heartbeat appears in Control Tower. Re-running does NOT duplicate competitors / ad gaps / grades (all deduped/idempotent).
- **Gap gets graded:** approve a gap in the hub queue, then run the cadence → `select gap_source, grade_initial, gap_quality, outcome_quality, outcome_state, graded_by from acquisition_gap_grades where workspace_id='<ws>';` → a 1–10 `grade_initial` with separate `gap_quality`/`outcome_quality` + `graded_by='agent'`, `outcome_state` ∈ approved｜shipped. Reject a different gap → it grades with a LOW `gap_quality` and `outcome_state='rejected'`. Re-run the cadence → rows update in place, never duplicate.
- **Revised grade:** once an approved gap's routed experiment is `promoted` (or killed/rolled-back), the next cadence run fills `grade_revised` + `grade_revised_reasoning` with `outcome_state` ∈ won｜lost, leaving `grade_initial` unchanged (both persist). A ≥3-point initial-vs-revised gap inserts an `acquisition_grader_prompts` row with `status='proposed'`.
- **Visible on the hub:** as **owner**, open `/dashboard/marketing/acquisition` → the "Gap grade (avg)" card shows the overall average + graded count; each acted-on gap card shows `grade N/10 · gap X · outcome Y · <state>`; `GET /api/ads/acquisition?workspaceId=<ws>` returns `gradeSignal` + `suppressedTypes` + a `grade` on each acted-on `gapQueue` item.
- **Override (human-overridable gate):** click **Override** on a graded gap, enter a grade + reason → `POST /api/ads/acquisition/grades/{gradeId} { workspaceId, grade, reason, propose_rule:true }` → `select graded_by, overridden_by, override_reason from acquisition_gap_grades where id='<gradeId>';` → `graded_by='human'`, `overridden_by=<user>`, reason recorded; a proposed `acquisition_grader_prompts` rule appears; the next `gradeGap` does NOT re-write the human grade.
- **Negative — the loop learns:** drive a lander `gap_type` (e.g. `founder_story`) to ≥2 graded instances averaging ≤4 → `loadSuppressedGapTypes` returns `lander:founder_story`, the hub shows it under "Down-weighted (no longer re-surfaced)", and the next `analyzeLanderGaps` run reports `skippedSuppressed≥1` and does NOT re-propose that type (it's not endlessly re-surfaced). A non-owner GET `/api/ads/acquisition` still → `403`.
