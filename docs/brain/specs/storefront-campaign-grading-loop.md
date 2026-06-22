# Head-of-Growth campaign-grading loop ✅

**Owner:** [[../functions/growth]] · **Parent:** M5 — Head-of-Growth grading loop
**Blocked-by:** [[storefront-optimizer-agent]]

The supervisory loop that closes the CEO → Growth → Optimizer chain for the [[../goals/storefront-optimizer]]. The [[../functions/growth|Growth director]] **grades each campaign 1–10** (human-overridable), scoring **hypothesis quality separately from result** — a *sound* hypothesis that lost is good learning (high grade); a *lucky* win from a sloppy hypothesis is low. There are **two grades per campaign:** an **initial grade** at significance (on the proxy + the agent's reasoning), and a **revised grade ~4 months later** when the [[storefront-ltv-proxy-reconciler|M3 reconciler]]'s real LTV lands. Grades **train the agent** — they bias which levers/hypotheses it favors next (the feedback signal of the [[storefront-optimizer-agent|M4 agent]]). This directly mirrors the shipped 1–10 ticket grader ([[../libraries/ticket-analyzer]] `analyzeTicket` + the calibration-rule [[../tables/grader_prompts]] pattern), reusing its proven shape: an AI grader against a rubric + human-approved calibration rules, human-overridable. Success metric served: the agent's **average campaign grade trending up**, plus the report contract Growth uses to supervise.

## Phase 1 — campaign grade store + rubric ✅
- ✅ shipped — `20260628120000_storefront_campaign_grades.sql` (+ `scripts/apply-storefront-campaign-grades-migration.ts`); brain pages [[../tables/storefront_campaign_grades]] + [[../tables/storefront_grader_prompts]].
- New table `storefront_campaign_grades` — one row per campaign (the [[storefront-optimizer-agent|M4]] campaign record): `experiment_id`, `grade_initial` (1–10), `grade_initial_reasoning`, `hypothesis_quality` + `result_quality` sub-scores (scored *separately*), `grade_revised` (1–10, nullable until 4-month LTV lands), `grade_revised_reasoning`, `graded_by` ∈ `agent｜human`, `overridden_by` (nullable workspace member). Migration + [[write-brain-page]] `tables/storefront_campaign_grades.md`.
- A rubric for campaign grading, calibrated by **human-approved rules** in a `storefront_grader_prompts` store modeled on [[../tables/grader_prompts]] (`status` ∈ `proposed｜approved`, `derived_from_*`) — so the Growth director corrects the grader's scoring on edge cases the same way the ticket grader is calibrated.

## Phase 2 — the initial grade (at significance) ✅
- ✅ shipped — [[../libraries/storefront-campaign-grader]] `gradeCampaign(mode:'initial')`, hooked into [[../libraries/storefront-experiment-refresh]] on every terminal (promote/kill/rollback) decide step.
- `src/lib/storefront/campaign-grader.ts` — `gradeCampaign(experiment, mode:'initial')`: an LLM grader ([[../libraries/ai-models]]) over the campaign's hypothesis (the cited funnel signal + lever posterior), the variant produced, and the proxy result, plus the approved calibration rules. Returns the 1–10 grade with **hypothesis-quality scored independently of result** (sound-but-lost = high; lucky-but-sloppy = low) + reasoning.
- Fired when the M1 bandit reaches significance / a campaign concludes (hook the M4 decide step). Idempotent per campaign.

## Phase 3 — the revised grade (4-month LTV) + training signal ✅
- ✅ shipped — `gradeCampaign(mode:'revised')` + `gradeRevisedForReconciledCohorts` wired into [[../inngest/storefront-ltv-reconcile]]'s daily run; large gap proposes a `storefront_grader_prompts` rule. Training signal: `loadLeverGradeSignal` feeds the M4 brief + the M2 `nextLeverToTest` `gradeBias` (`GRADE_BIAS_WEIGHT=0.15`).
- `gradeCampaign(experiment, mode:'revised')`: re-grade once the [[storefront-ltv-proxy-reconciler|M3 reconciler]] lands the cohort's actual LTV — did the proxy-time call hold up? Persist `grade_revised` + reasoning; a large initial-vs-revised gap is a calibration signal (feeds a proposed `storefront_grader_prompts` rule).
- **Train the agent:** expose grades back to [[storefront-optimizer-agent|M4]] so the agent biases toward high-graded hypothesis patterns (and to [[storefront-lever-importance-memory|M2]] as a secondary weight on lever choice). This is the CEO → Growth → Optimizer feedback loop made concrete.

## Phase 4 — the Growth-director report contract + override ✅
- ✅ shipped — Campaign-grades panel on the [[../dashboard/storefront__funnel]] (per-campaign initial+revised grades, hypothesis/result sub-scores, the agent's average-grade trend, one-click override). `POST /api/workspaces/[id]/storefront-campaign-grades/[gradeId]` records the override; `PATCH /api/workspaces/[id]/storefront-grader-prompts/[ruleId]` approves a calibration rule.
- A report surface on the [[../dashboard/storefront__funnel|funnel dashboard]] (or a Growth section): every campaign with its initial + revised grade, hypothesis/result sub-scores, the agent's average grade trend, and a one-click **human override** (sets `graded_by='human'`/`overridden_by`) — the human-overridable gate.
- Define the structured report the Growth director (a future CEO-mode director-agent) consumes: per-period campaign grades + trend + the levers/products driving predicted-LTV-per-visitor.

## Safety / invariants
- **Hypothesis graded separately from result.** A sound hypothesis that lost scores high; a lucky win from a sloppy hypothesis scores low — the grader must not reward outcome luck (the goal § grade).
- **Human-overridable.** Every grade can be overridden by the Growth director; overrides are recorded (`graded_by`/`overridden_by`) and become calibration rules — never silently lost (mirror [[../libraries/ticket-analyzer]]'s `grader_prompts` calibration arc).
- **Two grades, both kept.** The initial (proxy-time) grade is never overwritten by the revised (actual-LTV) grade — both persist, so the proxy-vs-reality gap is auditable.
- **Idempotent grading.** A campaign is graded once per mode; a re-run updates in place, never duplicates.
- **The grader is a supervised tool.** It scores a bounded proxy (campaign quality); the Growth director owns the objective and overrides it ([[../operational-rules]] § North star).

## Completion criteria
- `storefront_campaign_grades` + a `storefront_grader_prompts` calibration store exist (typed, RLS'd, brain pages written).
- Every concluded M4 campaign gets an initial 1–10 grade at significance, scoring hypothesis quality independently of result, with reasoning.
- The revised grade lands once M3's 4-month actual LTV is available; both grades persist.
- Grades feed back to the M4 agent (and M2) as a training signal, and a human override path exists + is recorded.
- The Growth-director report surface shows per-campaign grades + the agent's average-grade trend.

## Verification
- Run `npx tsx scripts/apply-storefront-campaign-grades-migration.ts` → expect `✓ public.storefront_campaign_grades has N columns` + `✓ public.storefront_grader_prompts has N columns` + a list of CHECK constraints (the `grade_initial`/`grade_revised`/sub-score range CHECKs + the `graded_by` + the calibration-store `status` CHECK).
- In the DB, confirm one grade row per campaign: `\d storefront_campaign_grades` shows `experiment_id` UNIQUE; the partial index `…_pending_revised_idx` exists.
- Conclude an M4 campaign at significance (the M1 refresh promotes/kills/rolls-back an experiment) → `select grade_initial, hypothesis_quality, result_quality, grade_initial_reasoning, graded_by from storefront_campaign_grades where experiment_id='<id>';` → a 1–10 `grade_initial` with separate hypothesis/result sub-scores + reasoning, `graded_by='agent'`. Re-run the refresh → the row is updated in place (same `id`), never duplicated.
- Grade a sound-hypothesis-that-lost campaign → expect a HIGH `hypothesis_quality` despite a low `result_quality`; grade a lucky-win-from-a-sloppy-hypothesis → expect a LOW `hypothesis_quality` despite a high `result_quality` (hypothesis graded independently of result).
- After M3 reconciles a cohort, the `storefront-ltv-reconcile` Inngest run's `grade-revised` step → `select grade_initial, grade_revised, grade_revised_reasoning from storefront_campaign_grades where experiment_id='<id>';` → `grade_revised` + reasoning populated, `grade_initial` unchanged (both persist). A ≥3-point initial-vs-revised gap inserts a `storefront_grader_prompts` row with `status='proposed'`.
- On `/dashboard/storefront/funnel`, the "Campaign grades — Head of Growth" panel shows per-campaign initial+revised grades, hypothesis/result sub-scores, and the avg-grade + trend stat cards. Click **Override**, set a grade + reason, Save → `select graded_by, overridden_by, override_reason from storefront_campaign_grades where id='<grade_id>';` → `graded_by='human'`, `overridden_by=<member>`, reason recorded; the avg-grade trend reflects the new grade on reload.
- Approve a proposed calibration rule in the panel (`PATCH …/storefront-grader-prompts/[ruleId]` → `status='approved'`) → the next `gradeCampaign` call injects it (visible in `buildCampaignGraderSystemPrompt`).
- Load the M4 brief (`loadOptimizerBrief`) for a surface with graded campaigns → the brief text contains a `CAMPAIGN GRADE HISTORY (M5 …)` block with the agent's avg grade + per-lever avg grade/hypothesis-quality, and `nextLeverToTest` receives `gradeBias` (high-graded levers nudged up in the selection score).
