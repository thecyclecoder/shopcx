# `src/lib/agents/director-grader.ts` — the director-decision grader

The CEO's **director-decision grade** — one row per graded **director call**, 1–10 + reasoning (M5 of [[../goals/devops-director]], [[../specs/director-loop-grading]] Phase 3). One level **up the org chart** from [[storefront-campaign-grader]] / [[acquisition-gap-grader]]: there a director grades a TOOL's output; here the CEO grades the [[../specs/platform-director-agent|Platform/DevOps Director]]'s own CALLS. Persists to [[../tables/director_decision_grades]]; calibrated by approved [[../tables/director_grader_prompts]] rules.

The defining invariant: **soundness is scored separately from outcome** — a sound auto-approval that later needed a rare, reversible tweak still grades well if the reasoning was right; a careless rubber-stamp that happened to be fine grades low. The grader never rewards outcome luck ([[../operational-rules]] § North star; mirror [[../tables/storefront_campaign_grades]]'s hypothesis-vs-result split).

## Two dimensions (each one gradeable "call")
- **`auto-approval`** — one [[../tables/approval_decisions]] row the director auto-approved (`decided_by='director'`, `autonomous=true`). Was the cause+fix **sound** and within the leash, and did it **hold up** — the target [[../tables/agent_jobs]] build concluded clean (no later `failed`/`needs_attention` re-run of the same spec)? Gradeable only once the target build reaches a terminal status (`completed｜merged｜failed｜needs_attention`). **`merged` IS terminal** — a build goes `building → completed → merged` (PR landed on `main`; `SUCCESSFUL_BUILD_STATUSES` in [[agent-jobs]]); the approval call concluded the moment the work shipped, so a build sitting at `merged` (e.g. a post-merge finalization step that never re-flips it `completed`) is fully gradeable. **Omitting `merged` here was the STARVED-grading root cause** — every concluded build that landed sat un-gradeable for days (`considered>0, graded=0`) while the cron heartbeat stayed green.
- **`goal-escort`** — one `(goal_slug, milestone)` the director escorted (an `escorted_goal` [[../tables/director_activity]] row exists for the goal). Did the milestone **land clean** — every linked spec shipped? Gradeable only once the milestone's status is `shipped`.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `gradeDirectorCall` | `({ dimension, workspaceId, approvalDecisionId?, context?, admin? }) → Promise<DirectorGradeResult>` | The per-call entrypoint the spec names — dispatches to the dimension grader. `auto-approval` ⇒ pass `approvalDecisionId`; `goal-escort` ⇒ pass a resolved `MilestoneContext`. |
| `gradeAutoApproval` | `({ approvalDecisionId, admin? }) → Promise<DirectorGradeResult>` | Grade ONE auto-approval. Concluded-only (`not_concluded` until the target build terminates — `completed｜merged｜failed｜needs_attention`); idempotent on `approval_decision_id`; never clobbers a human grade. |
| `gradeGoalEscort` | `({ context, workspaceId, admin? }) → Promise<DirectorGradeResult>` | Grade ONE escorted milestone. Idempotent on `(workspace_id, goal_slug, milestone)`; never clobbers a human grade. |
| `gradeConcludedDirectorCalls` | `({ workspaceId, admin? }) → Promise<{ considered, graded }>` | The standing-cadence sweep: grade every concluded, ungraded call in BOTH dimensions. Called from [[../inngest/platform-director-cron]]. A no-op while the director made no calls. |
| `buildDirectorGraderSystemPrompt` | `(admin, workspaceId, dimension) → Promise<string>` | The dimension rubric + approved [[../tables/director_grader_prompts]] calibration rules. |

## How it grades
- **Inputs (auto-approval):** the `approval_decisions` reasoning (what the director claimed made it sound), the target build (kind / spec / approved action / cmd / status / error / log tail), and a **repeat-failure count** (later `failed`/`needs_attention` builds of the same spec after the approval — the "did it hold up" signal).
- **Inputs (goal-escort):** the milestone's specs + statuses, the director's `escorted_goal` activity reasons for the goal, and a regression-activity count.
- **Model:** Sonnet ([[ai-models]]). Cost via [[ai-usage]] (`purpose='director_decision_grading'`).
- **Output (strict JSON):** `{ grade, soundness, outcome, reasoning }`, each 1–10 — only `grade` + `reasoning` persist (the soundness/outcome split is kept distinct in the reasoning). The grade weights soundness ≥ outcome.

## Where it's wired
- **Grading** — [[../inngest/platform-director-cron]]'s standing cron (`*/5 * * * *`) runs `gradeConcludedDirectorCalls` per build-console workspace on the same beat it enqueues the box pass. Runs in the **deployed runtime** (it needs `ANTHROPIC_API_KEY`), not on the box. Mirrors [[../inngest/acquisition-research-cadence]]'s grade sweep.
- **Liveness** — the same cron's `emit-grading-liveness` step writes a dedicated [[../tables/loop_heartbeats]] beat `loop_id='director-decision-grading'` each sweep carrying `{director:{considered,graded}, worker:{considered,graded,coached}, starved}`, and opens a warn-level [[../tables/loop_alerts]] row (`grading_starved:director-decision-grading`) when grading is **starved for ≥2 consecutive sweeps** (`considered>0` but `graded==0` across both layers) — auto-resolving the moment grading flows again. This closes the silent-starvation gap so a future un-gradeable status can't sit unseen.
- **The calls it grades** — the auto-approval rows come from [[platform-director]] `applyDirectorApproval`; the escort rows from `escortApprovedGoals` (`escorted_goal` activity).
- **Report + override** — the per-period grades + trend + the leash-adjustment recommendations land on the Agents hub Director-grades tab via [[director-leash-recommendations]] (Phase 4 ✅); the human override (`POST /api/developer/agents/grades/{id}`) + calibration-rule proposal/approval arc lives there too.

## Gotchas
- **Supervised tool** ([[../operational-rules]] § North star) — scores a bounded proxy (decision quality); the CEO owns the objective and overrides it. The leash widens only by the CEO (Phase 4) — the grader only recommends.
- **Concluded-only** — an auto-approval is not graded until its target build terminates (`completed｜merged｜failed｜needs_attention`); a milestone not until it's fully `shipped`. An in-flight call returns `not_concluded` and is retried next beat. **`merged` counts as concluded** (it's terminal-success) — the same fix landed in [[agent-grader]]'s worker terminal set, since the `build` rubric grades "PR merged clean".
- **Idempotent + human-safe** — keyed on the partial uniques; a re-run UPDATEs in place, and `graded_by='human'` is never re-written by the agent.
- **Best-effort, never blocking** — the sweep is wrapped per workspace so a grader failure never breaks the cron; a missing API key is a clean no-op.
- **Dormant-aware by data** — pre-Phase-4 the director makes no autonomous calls, so the sweep simply finds zero candidates (no explicit gate needed).

---

[[../README]] · [[../tables/director_decision_grades]] · [[../tables/director_grader_prompts]] · [[../inngest/platform-director-cron]] · [[platform-director]] · [[storefront-campaign-grader]] · [[acquisition-gap-grader]] · [[../specs/director-loop-grading]] · [[../goals/devops-director]] · [[../../CLAUDE]]
