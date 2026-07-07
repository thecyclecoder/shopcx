# inngest/sonnet-prompt-auto-review

Daily **enqueue** cron for the sonnet-prompt auto-review box agent. The reviewer USED to be a headless Claude Opus API call fired straight from this cron; it is now a supervised box-session agent (`kind='prompt-review'`) under June (CS Director) — see [[../lifecycles/ai-learning]] for the end-to-end trace. This cron only enqueues rows; the review itself runs on the box lane in `scripts/builder-worker.ts → runPromptReviewJob`.

**File:** `src/lib/inngest/sonnet-prompt-auto-review.ts`

## Functions

### `sonnet-prompt-auto-review`
- **Trigger:** cron `0 11 * * *` (11 UTC = 6 AM Central during CDT, fires right after [[daily-analysis-report-cron]]) **+ event** `prompt-learning/auto-review.run` (manual trigger from a script or admin)
- **Retries:** 1
- **Concurrency:** `[{ limit: 1 }]` — at most one enqueue-sweep at a time
- **Per-workspace gate:** skips workspaces with `workspaces.sonnet_auto_review_enabled=false` (default for all)

## Pipeline

For each enabled workspace:
1. Pull up to 50 `sonnet_prompts` rows where `status='proposed' AND auto_decision IS NULL` (oldest first, capped by `MAX_PROPOSALS_PER_CRON_RUN` so a big backlog drains over consecutive daily ticks rather than flooding the box).
2. Dedupe against already-in-flight prompt-review jobs (`kind='prompt-review' AND status IN (queued, queued_resume, claimed, building, needs_attention)`, matched by `spec_slug=proposal.id`).
3. Insert one `agent_jobs` row per fresh proposal: `kind='prompt-review'`, `status='queued'`, `spec_slug=proposal.id`, `workspace_id`. That's it — no LLM call here.
4. Return per-workspace + global candidate / enqueued / skipped counts.

The box worker (`scripts/builder-worker.ts → runPromptReviewJob`) claims each row, assembles the review inputs (top-K similar approved prompts, active [[../tables/policies]], source-pattern tickets from [[../tables/daily_analysis_reports]] + [[../tables/ticket_analyses]], voice docs from disk — same inputs `loadReviewInputs` used to hand the retired direct-Opus fetch), runs ONE Max session with `buildSystemPrompt` + `buildUserPrompt`, parses the JSON verdict via `parseDecision`, then hands it to `applyDecision` — which writes the SAME auto_decision fields with the SAME safety guards.

## Phase 3 safety guards

Implemented in `applyDecision()`. Constants exported from `src/lib/sonnet-prompt-auto-review.ts`:

```ts
export const REJECT_FLOOR = 0.55;        // anything below this is dropped
export const ACCEPT_FLOOR = 0.70;        // accepts below this become rejects
export const DEFAULT_DAILY_CAP = 10;     // accept ceiling per workspace per UTC day
```

| Guard | Behavior |
|---|---|
| `confidence < REJECT_FLOOR` | Downgrade to `reject`. Reasoning: `[SAFETY] confidence_below_reject_floor (X < 0.55) — dropping rather than queuing for human review`. The pattern will resurface if real. |
| `accept` with `REJECT_FLOOR ≤ confidence < ACCEPT_FLOOR` | Downgrade to `reject`. Reasoning: `[SAFETY] accept_below_floor (X < 0.70) — downgraded to reject; resurface with more evidence`. |
| Model returns `human_review` | Override to `reject`. Reasoning: `[SAFETY] model_recommended_human_review_overridden_to_reject — auto-review never queues to humans`. |
| Daily cap reached (`accept` count today ≥ `workspaces.sonnet_auto_review_daily_cap`) | Downgrade excess to `reject`, not human_review. |
| Model returns `delete` | Rewrite to `supersede`. The model can't delete an approved row; only supersede + archive. |
| Audit-first | Write [[../tables/sonnet_prompt_decisions]] BEFORE mutating the prompt row. If audit insert fails, the prompt is untouched. |

A safety test (`scripts/test-prompt-auto-review-safety.ts`) verifies each invariant.

### Why no human queue

The previous spec routed low-confidence proposals to `human_review`. The first live run sent 26 proposals to that queue. Dylan's feedback: *"I really don't want these getting routed to me… you have way better suggestions than just routing 26 to me — fix the system so it can make better decisions."*

The redesign (2026-06-03) makes the cron decisive. A reject is reversible (Dylan can revert it from /dashboard/ai-analysis); a queued-for-human pile is dead weight that grows faster than anyone clears it. The reasoning of every safety-driven downgrade is preserved on the audit row — including the model's hesitation when it tried to defer.

## Downstream events sent

_None._ The cron writes `agent_jobs` rows the box worker claims; no Inngest events are fanned out.

## Tables written

- `agent_jobs` — one row per proposal (`kind='prompt-review'`, `status='queued'`, `spec_slug=proposal.id`). The box worker's `runPromptReviewJob` writes the auto_decision fields below.

The following are written by the box lane (`applyDecision` in `src/lib/sonnet-prompt-auto-review.ts`), not by this cron:

- [[../tables/sonnet_prompts]] — `auto_decision`, `status`, `enabled`, `superseded_by_id`, `merged_into_id`, `reviewed_at`
- [[../tables/sonnet_prompt_decisions]] — one row per decision, append-only
- [[../tables/ai_token_usage]] — per-call cost accounting via `logAiUsage()` (metered as part of the Max session, not a direct-API call)

## Tables read (not written)

- [[../tables/workspaces]] — `sonnet_auto_review_enabled`, `sonnet_auto_review_daily_cap`
- [[../tables/sonnet_prompts]] — backlog of proposed prompts to enqueue
- `agent_jobs` — dedupe against in-flight prompt-review jobs

The box lane's `runPromptReviewJob` reads [[../tables/policies]], [[../tables/daily_analysis_reports]], [[../tables/ticket_analyses]] + the voice docs on disk (`docs/brain/customer-voice.md`, `docs/brain/operational-rules.md`, `docs/brain/ui-conventions.md`) — not this cron.

## Per-workspace enable + cap

| Field | Default | Effect |
|---|---|---|
| `workspaces.sonnet_auto_review_enabled` | `false` | Cron skips workspace if false |
| `workspaces.sonnet_auto_review_daily_cap` | `10` | Max `accept` decisions per workspace per UTC day |

**No workspace has the enable flag on at this commit** — flip per-workspace via SQL once the first batch of decisions look right on /dashboard/ai-analysis.

## Related

[[../lifecycles/ai-learning]] · [[../tables/sonnet_prompts]] · [[../tables/sonnet_prompt_decisions]] · [[../tables/policies]] · [[ticket-analysis-cron]] · [[daily-analysis-report-cron]] · [[ai-nightly-analysis]] · [[../functions/cs]] · [[../dashboard/ai-analysis]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
