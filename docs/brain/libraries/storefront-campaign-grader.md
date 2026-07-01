# `src/lib/storefront/campaign-grader.ts` — the Head-of-Growth campaign grader

The supervisory grading loop (M5) that closes the CEO → Growth → Optimizer chain for the [[../goals/storefront-optimizer]]. An AI grader scores each **concluded** M4 campaign 1–10 against a rubric + human-approved calibration rules ([[../tables/storefront_grader_prompts]]), exactly mirroring the shipped 1–10 ticket grader ([[ticket-analyzer]] + [[../tables/grader_prompts]]). The grade is the **feedback signal of the M4 agent**. Persists to [[../tables/storefront_campaign_grades]]. Spec `docs/brain/specs/storefront-campaign-grading-loop.md`.

The defining invariant: **hypothesis quality is scored separately from result** — a sound hypothesis that lost is good learning (high `hypothesis_quality`); a lucky win from a sloppy hypothesis is low. The grader never rewards outcome luck.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `gradeCampaign` | `({ experimentId, mode: 'initial'｜'revised', admin? }) → Promise<CampaignGradeResult>` | **API path — retired in Phase 4.** Grades ONE campaign via the Anthropic API. Preserved as a fallback + for tests; production grading is now box-side (see below). Idempotent per (campaign × mode); never clobbers a human override or the other mode's grade. |
| `applyBoxCampaignGrade` | `({ workspaceId, experimentId, mode, grade, hypothesisQuality?, resultQuality?, reasoning, admin? }) → Promise<CampaignGradeResult>` | **Phase 4 — box-hosted apply.** Writes the grade the box-hosted Max session emitted. Same UNIQUE(experiment_id) upsert + `graded_by='human'` override invariant as the API path; `model` stamped `box-max-session`; no `ai_token_usage` write. On a large initial-vs-revised gap fires the Opus calibration-rule proposal. |
| `pickCampaignGradeBatch` | `({ workspaceId, admin?, cap? }) → Promise<CampaignGradeCandidate[]>` | **Phase 4 — box-hosted pick.** Selects ungraded / pending-revised campaigns for the box lane, paginating past the 1000-row PostgREST cap and skipping human-owned rows. Truncated to `cap` (default 8). |
| `gradeRevisedForReconciledCohorts` | `({ workspaceId, admin? }) → Promise<{ considered, revised }>` | **Legacy API sweep — no longer wired in prod.** Preserved for tests / manual reruns. Production revised grading is enqueued by [[../inngest/storefront-ltv-reconcile]] as a `campaign-grade` `agent_jobs` row. |
| `loadLeverGradeSignal` | `({ workspaceId, productId?, landerType?, audience?, admin? }) → Promise<LeverGradeSignal>` | The training signal: per-lever avg grade + avg hypothesis-quality + overall avg. Feeds the M4 brief and the M2 `nextLeverToTest` `gradeBias`. |
| `buildCampaignGraderSystemPrompt` | `(admin, workspaceId, mode) → Promise<string>` | The rubric + approved [[../tables/storefront_grader_prompts]] rules. Mode-specific framing (proxy-time vs actual-LTV). |
| `REVISED_GAP_RULE_THRESHOLD` | `= 3` | initial-vs-revised gap that proposes a calibration rule. |

## How it grades
- **Inputs:** the campaign's hypothesis + cited reasoning (`storefront_experiments.last_decision.reasoning`), the variant patch produced, the lever + its [[../tables/storefront_lever_importance]] posterior at design time, the arm rollups (the proxy result), and — in `revised` mode — the [[../tables/storefront_ltv_reconciliations]] actual-vs-proxy row.
- **Model:** production grading runs on **Max via `scripts/builder-worker.ts → runCampaignGradeJob`** (`kind='campaign-grade'`); the API-path `gradeCampaign` (Sonnet [[ai-models]] `SONNET_MODEL` + Opus for the calibration-rule draft, logged as `purpose='storefront_campaign_grading'`) is retained as a fallback but no longer wired to any cron / refresh. Post-Phase-4 grades stamp `model='box-max-session'` and land no `ai_token_usage` row.
- **Output (strict JSON):** `{ grade, hypothesis_quality, result_quality, reasoning }`, each 1–10.

## Where it's wired
- **Initial grade** — [[storefront-experiment-refresh]] tracks whether any terminal decision landed (promote/kill/rollback), and at end-of-refresh calls `pickCampaignGradeBatch` + enqueues ONE `campaign-grade` `agent_jobs` row per workspace (dedup-gated). The box lane grades it and writes via `applyBoxCampaignGrade`.
- **Revised grade** — [[../inngest/storefront-ltv-reconcile]] calls `pickCampaignGradeBatch` after `reconcileLtvProxy` and enqueues a `campaign-grade` row for the workspace (dedup-gated); the box lane grades revised-mode candidates whose cohorts have reconciled and proposes a [[../tables/storefront_grader_prompts]] rule (`status='proposed'`) on a large initial-vs-revised gap.
- **Box lane** — `.claude/skills/campaign-grade/SKILL.md` + `runCampaignGradeJob` in `scripts/builder-worker.ts`. Concurrency 1, timeout 20 min. CEO directive 2026-06-30: every grader box-side ([[../specs/grading-cascade-to-box-sessions]] Phase 4).
- **Training signal** — [[storefront-optimizer-agent]] `loadOptimizerBrief` calls `loadLeverGradeSignal`, surfaces per-lever avg grades in the brief, and passes `gradeBias` to [[storefront-lever-memory]] `nextLeverToTest` (a secondary weight, `GRADE_BIAS_WEIGHT=0.15`).
- **Override + report** — the funnel dashboard ([[../dashboard/storefront__funnel]]) shows per-campaign grades + the agent's average-grade trend; `POST /api/workspaces/[id]/storefront-campaign-grades/[gradeId]` records the human override; `PATCH /api/workspaces/[id]/storefront-grader-prompts/[ruleId]` approves a calibration rule.

## Gotchas
- **Supervised tool** ([[../operational-rules]] § North star). The grader scores a bounded proxy (campaign quality); the Growth director owns the objective and overrides it — overrides are recorded, never silently lost.
- **Both grades persist.** `revised` mode never touches `grade_initial`. A human-overridden initial grade is never re-written by the agent.
- **Best-effort, never blocking.** Both hook calls are wrapped so a grader failure never breaks the refresh / reconcile run.
- **Idempotent.** `gradeCampaign` upserts on `experiment_id`; re-runs update in place, never duplicate.
