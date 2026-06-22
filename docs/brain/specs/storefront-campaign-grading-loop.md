# Head-of-Growth campaign-grading loop ⏳

**Owner:** [[../functions/growth]] · **Parent:** M5 — Head-of-Growth grading loop
**Blocked-by:** [[storefront-optimizer-agent]]

The supervisory loop that closes the CEO → Growth → Optimizer chain for the [[../goals/storefront-optimizer]]. The [[../functions/growth|Growth director]] **grades each campaign 1–10** (human-overridable), scoring **hypothesis quality separately from result** — a *sound* hypothesis that lost is good learning (high grade); a *lucky* win from a sloppy hypothesis is low. There are **two grades per campaign:** an **initial grade** at significance (on the proxy + the agent's reasoning), and a **revised grade ~4 months later** when the [[storefront-ltv-proxy-reconciler|M3 reconciler]]'s real LTV lands. Grades **train the agent** — they bias which levers/hypotheses it favors next (the feedback signal of the [[storefront-optimizer-agent|M4 agent]]). This directly mirrors the shipped 1–10 ticket grader ([[../libraries/ticket-analyzer]] `analyzeTicket` + the calibration-rule [[../tables/grader_prompts]] pattern), reusing its proven shape: an AI grader against a rubric + human-approved calibration rules, human-overridable. Success metric served: the agent's **average campaign grade trending up**, plus the report contract Growth uses to supervise.

## Phase 1 — campaign grade store + rubric ⏳
- ⏳ planned
- New table `storefront_campaign_grades` — one row per campaign (the [[storefront-optimizer-agent|M4]] campaign record): `experiment_id`, `grade_initial` (1–10), `grade_initial_reasoning`, `hypothesis_quality` + `result_quality` sub-scores (scored *separately*), `grade_revised` (1–10, nullable until 4-month LTV lands), `grade_revised_reasoning`, `graded_by` ∈ `agent｜human`, `overridden_by` (nullable workspace member). Migration + [[write-brain-page]] `tables/storefront_campaign_grades.md`.
- A rubric for campaign grading, calibrated by **human-approved rules** in a `storefront_grader_prompts` store modeled on [[../tables/grader_prompts]] (`status` ∈ `proposed｜approved`, `derived_from_*`) — so the Growth director corrects the grader's scoring on edge cases the same way the ticket grader is calibrated.

## Phase 2 — the initial grade (at significance) ⏳
- ⏳ planned
- `src/lib/storefront/campaign-grader.ts` — `gradeCampaign(experiment, mode:'initial')`: an LLM grader ([[../libraries/ai-models]]) over the campaign's hypothesis (the cited funnel signal + lever posterior), the variant produced, and the proxy result, plus the approved calibration rules. Returns the 1–10 grade with **hypothesis-quality scored independently of result** (sound-but-lost = high; lucky-but-sloppy = low) + reasoning.
- Fired when the M1 bandit reaches significance / a campaign concludes (hook the M4 decide step). Idempotent per campaign.

## Phase 3 — the revised grade (4-month LTV) + training signal ⏳
- ⏳ planned
- `gradeCampaign(experiment, mode:'revised')`: re-grade once the [[storefront-ltv-proxy-reconciler|M3 reconciler]] lands the cohort's actual LTV — did the proxy-time call hold up? Persist `grade_revised` + reasoning; a large initial-vs-revised gap is a calibration signal (feeds a proposed `storefront_grader_prompts` rule).
- **Train the agent:** expose grades back to [[storefront-optimizer-agent|M4]] so the agent biases toward high-graded hypothesis patterns (and to [[storefront-lever-importance-memory|M2]] as a secondary weight on lever choice). This is the CEO → Growth → Optimizer feedback loop made concrete.

## Phase 4 — the Growth-director report contract + override ⏳
- ⏳ planned
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
- Apply the migration → expect `✓ public.storefront_campaign_grades has N columns` + `✓ public.storefront_grader_prompts has N columns`; confirm the `grade_initial`/`grade_revised` range CHECKs and the `status` CHECK on the calibration store.
- Conclude an M4 campaign at significance → `select grade_initial, hypothesis_quality, result_quality, grade_initial_reasoning, graded_by from storefront_campaign_grades where experiment_id='<id>';` → a 1–10 `grade_initial` with separate hypothesis/result sub-scores + reasoning, `graded_by='agent'`. Re-run grading → row updated in place (idempotent), not duplicated.
- Grade a sound-hypothesis-that-lost campaign → expect a HIGH `hypothesis_quality` despite a poor `result_quality`; grade a lucky-win-sloppy-hypothesis → expect a LOW `hypothesis_quality` despite a good result.
- After M3 lands a reconciled cohort, run revised grading → `grade_revised` + reasoning populated, `grade_initial` unchanged; a large gap proposes a `storefront_grader_prompts` rule (`status='proposed'`).
- On the Growth report surface, override a grade → expect `graded_by='human'`, `overridden_by=<member>` recorded, and the agent's average-grade trend reflects the override.
- Confirm M4 reads the grades as a training signal (the agent's next hypothesis selection references high-graded patterns).
