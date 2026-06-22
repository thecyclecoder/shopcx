# `src/lib/storefront/campaign-grader.ts` — the Head-of-Growth campaign grader

The supervisory grading loop (M5) that closes the CEO → Growth → Optimizer chain for the [[../goals/storefront-optimizer]]. An AI grader scores each **concluded** M4 campaign 1–10 against a rubric + human-approved calibration rules ([[../tables/storefront_grader_prompts]]), exactly mirroring the shipped 1–10 ticket grader ([[ticket-analyzer]] + [[../tables/grader_prompts]]). The grade is the **feedback signal of the M4 agent**. Persists to [[../tables/storefront_campaign_grades]]. Spec `docs/brain/specs/storefront-campaign-grading-loop.md`.

The defining invariant: **hypothesis quality is scored separately from result** — a sound hypothesis that lost is good learning (high `hypothesis_quality`); a lucky win from a sloppy hypothesis is low. The grader never rewards outcome luck.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `gradeCampaign` | `({ experimentId, mode: 'initial'｜'revised', admin? }) → Promise<CampaignGradeResult>` | Grade ONE concluded campaign. `initial` = at significance on the proxy; `revised` = after the M3 reconciler lands actual LTV. Idempotent per (campaign × mode); never clobbers a human override or the other mode's grade. |
| `gradeRevisedForReconciledCohorts` | `({ workspaceId, admin? }) → Promise<{ considered, revised }>` | Sweep: revise-grade every campaign with an initial grade, no revised grade, whose cohort has reconciled. Called from [[../inngest/storefront-ltv-reconcile]]'s daily run. |
| `loadLeverGradeSignal` | `({ workspaceId, productId?, landerType?, audience?, admin? }) → Promise<LeverGradeSignal>` | The training signal: per-lever avg grade + avg hypothesis-quality + overall avg. Feeds the M4 brief and the M2 `nextLeverToTest` `gradeBias`. |
| `buildCampaignGraderSystemPrompt` | `(admin, workspaceId, mode) → Promise<string>` | The rubric + approved [[../tables/storefront_grader_prompts]] rules. Mode-specific framing (proxy-time vs actual-LTV). |
| `REVISED_GAP_RULE_THRESHOLD` | `= 3` | initial-vs-revised gap that proposes a calibration rule. |

## How it grades
- **Inputs:** the campaign's hypothesis + cited reasoning (`storefront_experiments.last_decision.reasoning`), the variant patch produced, the lever + its [[../tables/storefront_lever_importance]] posterior at design time, the arm rollups (the proxy result), and — in `revised` mode — the [[../tables/storefront_ltv_reconciliations]] actual-vs-proxy row.
- **Model:** Sonnet ([[ai-models]] `SONNET_MODEL`) for the grade; Opus for the calibration-rule draft. Cost logged via `logAiUsage` (`purpose='storefront_campaign_grading'`).
- **Output (strict JSON):** `{ grade, hypothesis_quality, result_quality, reasoning }`, each 1–10.

## Where it's wired
- **Initial grade** — [[storefront-experiment-refresh]] calls `gradeCampaign(initial)` (best-effort) on every terminal decision (promote/kill/rollback), right after `commitLearning`.
- **Revised grade** — [[../inngest/storefront-ltv-reconcile]] calls `gradeRevisedForReconciledCohorts` after `reconcileLtvProxy`; a large gap proposes a [[../tables/storefront_grader_prompts]] rule (`status='proposed'`).
- **Training signal** — [[storefront-optimizer-agent]] `loadOptimizerBrief` calls `loadLeverGradeSignal`, surfaces per-lever avg grades in the brief, and passes `gradeBias` to [[storefront-lever-memory]] `nextLeverToTest` (a secondary weight, `GRADE_BIAS_WEIGHT=0.15`).
- **Override + report** — the funnel dashboard ([[../dashboard/storefront__funnel]]) shows per-campaign grades + the agent's average-grade trend; `POST /api/workspaces/[id]/storefront-campaign-grades/[gradeId]` records the human override; `PATCH /api/workspaces/[id]/storefront-grader-prompts/[ruleId]` approves a calibration rule.

## Gotchas
- **Supervised tool** ([[../operational-rules]] § North star). The grader scores a bounded proxy (campaign quality); the Growth director owns the objective and overrides it — overrides are recorded, never silently lost.
- **Both grades persist.** `revised` mode never touches `grade_initial`. A human-overridden initial grade is never re-written by the agent.
- **Best-effort, never blocking.** Both hook calls are wrapped so a grader failure never breaks the refresh / reconcile run.
- **Idempotent.** `gradeCampaign` upserts on `experiment_id`; re-runs update in place, never duplicate.
