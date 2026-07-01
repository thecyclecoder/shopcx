# `src/lib/acquisition-gap-grader.ts` — the acquisition gap grader

The Growth-director **gap→outcome grade** that trains the scouts (M5 of [[../goals/acquisition-research-engine]], [[../specs/acquisition-research-loop-grading]]). An AI grader scores each surfaced gap (ad or lander) 1–10 against a rubric + human-approved calibration rules ([[../tables/acquisition_grader_prompts]]), exactly mirroring [[storefront-campaign-grader]] and the 1–10 ticket grader. The grade is the **feedback signal of the scouts**. Persists to [[../tables/acquisition_gap_grades]].

The defining invariant: **gap quality is scored separately from outcome** — a well-evidenced gap whose experiment lost still scores high `gap_quality`; a flimsy gap the owner rejected scores low. The grader never rewards outcome luck.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `gradeGap` | `({ source: 'ad'｜'lander', gapId, mode: 'initial'｜'revised', admin? }) → Promise<GapGradeResult>` | **API path — retired in Phase 4.** Grades ONE gap via the Anthropic API. Preserved as a fallback + for tests; production grading is now box-side. Idempotent per (gap × mode); never clobbers a human override or the other mode's grade. |
| `applyBoxGapGrade` | `({ workspaceId, source, gapId, mode, grade, gapQuality?, outcomeQuality?, reasoning, admin? }) → Promise<GapGradeResult>` | **Phase 4 — box-hosted apply.** Writes the grade the box-hosted Max session emitted. Same UNIQUE(workspace_id, gap_source, gap_id) upsert + `graded_by='human'` override invariant as the API path; `model` stamped `box-max-session`; no `ai_token_usage` write. On a large initial-vs-revised gap fires the Opus calibration-rule proposal. |
| `pickGapGradeBatch` | `({ workspaceId, admin?, cap? }) → Promise<GapGradeCandidate[]>` | **Phase 4 — box-hosted pick.** Selects ungraded / pending-revised gaps for the box lane, paginating past the 1000-row PostgREST cap and skipping human-owned rows. Truncated to `cap` (default 8). |
| `gradeActedGaps` | `({ workspaceId, admin? }) → Promise<{ considered, initial, revised }>` | **Legacy API sweep — no longer wired in prod.** Preserved for tests / manual reruns. Production grading is enqueued by [[../inngest/acquisition-research-cadence]] as a `gap-grade` `agent_jobs` row. |
| `loadGapTypeGradeSignal` | `({ workspaceId, admin? }) → Promise<GapTypeGradeSignal>` | Per-`${source}:${gap_type}` avg grade + avg gap_quality + overall avg. The training signal surfaced on the hub. |
| `loadSuppressedGapTypes` | `({ workspaceId, admin? }) → Promise<Set<string>>` | `${source}:${gap_type}` keys whose avg grade ≤ `SUPPRESS_GRADE_THRESHOLD` (4) with ≥ `SUPPRESS_MIN_GRADED` (2) graded — the scouts skip these (the loop learns). |
| `isSuppressed` | `(set, source, gapType) → boolean` | Membership helper used by the surfacing paths. |
| `buildGapGraderSystemPrompt` | `(admin, workspaceId, mode) → Promise<string>` | The rubric + approved [[../tables/acquisition_grader_prompts]] rules, mode-specific framing. |
| `REVISED_GAP_RULE_THRESHOLD` (=3) · `SUPPRESS_GRADE_THRESHOLD` (=4) · `SUPPRESS_MIN_GRADED` (=2) | constants | |

## How it grades
- **Inputs:** the gap row (title, rationale, evidence — brand count / longevity / spend for ad gaps, competitor-lander count for lander gaps), the owner decision, and the **derived outcome state** (rejected · approved · shipped · won · lost — joined from [[../tables/agent_jobs]] / [[../tables/storefront_experiments]] the same way the hub's throughput is).
- **Model:** production grading runs on **Max via `scripts/builder-worker.ts → runGapGradeJob`** (`kind='gap-grade'`); the API-path `gradeGap` (Sonnet [[ai-models]] + Opus for the calibration-rule draft, `purpose='acquisition_gap_grading'`) is retained as a fallback but no longer wired to any cron. Post-Phase-4 grades stamp `model='box-max-session'` and land no `ai_token_usage` row.
- **Output (strict JSON):** `{ grade, gap_quality, outcome_quality, reasoning }`, each 1–10.

## Where it's wired
- **Grading** — [[../inngest/acquisition-research-cadence]]'s daily cron calls `pickGapGradeBatch` per ad-tool workspace and enqueues ONE `gap-grade` `agent_jobs` row per workspace (dedup-gated). The box lane grades it and writes via `applyBoxGapGrade`.
- **Box lane** — `.claude/skills/gap-grade/SKILL.md` + `runGapGradeJob` in `scripts/builder-worker.ts`. Concurrency 1, timeout 20 min. CEO directive 2026-06-30: every grader box-side ([[../specs/grading-cascade-to-box-sessions]] Phase 4).
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
