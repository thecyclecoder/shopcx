# inngest/sonnet-prompt-auto-review

Daily Claude-Opus auto-review of proposed [[../tables/sonnet_prompts]]. The downstream half of the self-improvement loop — see [[../lifecycles/ai-learning]] for the end-to-end trace.

**File:** `src/lib/inngest/sonnet-prompt-auto-review.ts`

## Functions

### `sonnet-prompt-auto-review`
- **Trigger:** cron `0 11 * * *` (11 UTC = 6 AM Central during CDT, fires right after [[daily-analysis-report-cron]]) **+ event** `prompt-learning/auto-review.run` (manual trigger from a script or admin)
- **Retries:** 1
- **Concurrency:** `[{ limit: 1 }]` — at most one workspace-sweep at a time
- **Per-workspace gate:** skips workspaces with `workspaces.sonnet_auto_review_enabled=false` (default for all)

## Pipeline

For each enabled workspace:
1. Pull up to 50 `sonnet_prompts` rows where `status='proposed' AND auto_decision IS NULL`.
2. For each proposal, call `reviewSingleProposal()` in `src/lib/sonnet-prompt-auto-review.ts`:
   - Load top-K similar approved prompts, active [[../tables/policies]], contributing tickets from [[../tables/daily_analysis_reports]] + [[../tables/ticket_analyses]], and the voice docs from disk.
   - Call Claude Opus with the decision schema (`accept` / `reject` / `merge` / `supersede` / `revise` + `confidence` + `reasoning` + `references[]`). The system prompt explicitly tells the model there is **no human-review queue** — be decisive.
   - Apply through Phase 3 safety guards.
3. Return per-workspace + global counts.

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

_None._ Purely state-mutating.

## Tables written

- [[../tables/sonnet_prompts]] — `auto_decision`, `status`, `enabled`, `superseded_by_id`, `merged_into_id`, `reviewed_at`
- [[../tables/sonnet_prompt_decisions]] — one row per decision, append-only
- [[../tables/ai_token_usage]] — per-call cost accounting via `logAiUsage()`

## Tables read (not written)

- [[../tables/workspaces]] — `sonnet_auto_review_enabled`, `sonnet_auto_review_daily_cap`
- [[../tables/policies]] — active rules considered as references
- [[../tables/daily_analysis_reports]] — source pattern + theme membership
- [[../tables/ticket_analyses]] — contributing tickets

Reads three files at function init (cached + hashed for audit replay):
- `docs/brain/customer-voice.md`
- `docs/brain/operational-rules.md`
- `docs/brain/ui-conventions.md`

## Per-workspace enable + cap

| Field | Default | Effect |
|---|---|---|
| `workspaces.sonnet_auto_review_enabled` | `false` | Cron skips workspace if false |
| `workspaces.sonnet_auto_review_daily_cap` | `10` | Max `accept` decisions per workspace per UTC day |

**No workspace has the enable flag on at this commit** — flip per-workspace via SQL once the first batch of decisions look right on /dashboard/ai-analysis.

## Related

[[../lifecycles/ai-learning]] · [[../tables/sonnet_prompts]] · [[../tables/sonnet_prompt_decisions]] · [[../tables/policies]] · [[ticket-analysis-cron]] · [[daily-analysis-report-cron]] · [[ai-nightly-analysis]] · [[../integrations/anthropic]] · [[../dashboard/ai-analysis]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
