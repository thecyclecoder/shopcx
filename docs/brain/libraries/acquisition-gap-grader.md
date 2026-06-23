# `src/lib/acquisition-gap-grader.ts` — the acquisition gap grader

The Growth-director **gap→outcome grade** that trains the scouts (M5 of [[../goals/acquisition-research-engine]], [[../specs/acquisition-research-loop-grading]]). An AI grader scores each surfaced gap (ad or lander) 1–10 against a rubric + human-approved calibration rules ([[../tables/acquisition_grader_prompts]]), exactly mirroring [[storefront-campaign-grader]] and the 1–10 ticket grader. The grade is the **feedback signal of the scouts**. Persists to [[../tables/acquisition_gap_grades]].

The defining invariant: **gap quality is scored separately from outcome** — a well-evidenced gap whose experiment lost still scores high `gap_quality`; a flimsy gap the owner rejected scores low. The grader never rewards outcome luck.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `gradeGap` | `({ source: 'ad'｜'lander', gapId, mode: 'initial'｜'revised', admin? }) → Promise<GapGradeResult>` | Grade ONE acted-on gap. `initial` = when approved/rejected; `revised` = once the routed outcome resolves (won/lost). Idempotent per (gap × mode); never clobbers a human override or the other mode's grade. |
| `gradeActedGaps` | `({ workspaceId, admin? }) → Promise<{ considered, initial, revised }>` | The cadence sweep: initial-grade every acted-on gap with no grade, revise-grade every graded gap whose outcome resolved. Called from [[../inngest/acquisition-research-cadence]]. |
| `loadGapTypeGradeSignal` | `({ workspaceId, admin? }) → Promise<GapTypeGradeSignal>` | Per-`${source}:${gap_type}` avg grade + avg gap_quality + overall avg. The training signal surfaced on the hub. |
| `loadSuppressedGapTypes` | `({ workspaceId, admin? }) → Promise<Set<string>>` | `${source}:${gap_type}` keys whose avg grade ≤ `SUPPRESS_GRADE_THRESHOLD` (4) with ≥ `SUPPRESS_MIN_GRADED` (2) graded — the scouts skip these (the loop learns). |
| `isSuppressed` | `(set, source, gapType) → boolean` | Membership helper used by the surfacing paths. |
| `buildGapGraderSystemPrompt` | `(admin, workspaceId, mode) → Promise<string>` | The rubric + approved [[../tables/acquisition_grader_prompts]] rules, mode-specific framing. |
| `REVISED_GAP_RULE_THRESHOLD` (=3) · `SUPPRESS_GRADE_THRESHOLD` (=4) · `SUPPRESS_MIN_GRADED` (=2) | constants | |

## How it grades
- **Inputs:** the gap row (title, rationale, evidence — brand count / longevity / spend for ad gaps, competitor-lander count for lander gaps), the owner decision, and the **derived outcome state** (rejected · approved · shipped · won · lost — joined from [[../tables/agent_jobs]] / [[../tables/storefront_experiments]] the same way the hub's throughput is).
- **Model:** Sonnet for the grade ([[ai-models]]); Opus for the calibration-rule draft. Cost via [[ai-usage]] (`purpose='acquisition_gap_grading'`).
- **Output (strict JSON):** `{ grade, gap_quality, outcome_quality, reasoning }`, each 1–10.

## Where it's wired
- **Grading** — [[../inngest/acquisition-research-cadence]]'s daily cron calls `gradeActedGaps` per ad-tool workspace.
- **Surfacing feedback** — [[acquisition-hub]] `materializeAdGaps` and [[landing-page-scout]] `analyzeLanderGaps` call `loadSuppressedGapTypes` and SKIP a suppressed gap_type (the loop down-weights low-value gaps instead of re-surfacing them).
- **Visibility + override** — [[acquisition-hub]] `loadHubData` attaches each gap's grade + the `gradeSignal` + `suppressedTypes`; the hub dashboard ([[../dashboard/marketing__acquisition]]) shows them; `POST /api/ads/acquisition/grades/[id]` records the Growth-director override + optionally proposes a calibration rule.

## Gotchas
- **Supervised tool** ([[../operational-rules]] § North star) — scores a bounded proxy (gap quality); the Growth director owns the objective and overrides it (recorded, never silently lost).
- **Both grades persist** — `revised` never touches `grade_initial`; a human override is never re-written.
- **Best-effort, never blocking** — every cadence call is wrapped so a grader failure never breaks the loop.
- **Idempotent** — `gradeGap` keys on `(workspace_id, gap_source, gap_id)`; re-runs update in place.
- **Ad-gap suppression is coarse** — ad gaps are all `gap_type='ad_angle'`, so suppression only fires if ad angles are consistently low-graded workspace-wide (rejected angles already never re-surface via the queue's `dedup_key`). Lander suppression is per structural type (`comparison_table`, …).

---

[[../README]] · [[../tables/acquisition_gap_grades]] · [[../tables/acquisition_grader_prompts]] · [[../inngest/acquisition-research-cadence]] · [[acquisition-hub]] · [[landing-page-scout]] · [[storefront-campaign-grader]] · [[../specs/acquisition-research-loop-grading]] · [[../../CLAUDE]]
