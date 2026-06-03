# inngest/sonnet-prompt-auto-review

Daily Claude-Opus auto-review of proposed [[../tables/sonnet_prompts]]. The downstream half of the self-improvement loop — see [[../lifecycles/ai-learning]] for the end-to-end trace.

**File:** `src/lib/inngest/sonnet-prompt-auto-review.ts`

## Functions

### `sonnet-prompt-auto-review`
- **Trigger:** cron `0 11 * * *` (11 UTC = 6 AM Central during CDT, fires right after [[daily-analysis-report-cron]])
- **Retries:** 1
- **Concurrency:** `[{ limit: 1 }]` — at most one workspace-sweep at a time
- **Per-workspace gate:** skips workspaces with `workspaces.sonnet_auto_review_enabled=false` (default for all)

## Pipeline

For each enabled workspace:
1. Pull up to 50 `sonnet_prompts` rows where `status='proposed' AND auto_decision IS NULL`.
2. For each proposal, call `reviewSingleProposal()` in `src/lib/sonnet-prompt-auto-review.ts`:
   - Load top-K similar approved prompts, active [[../tables/policies]], contributing tickets from [[../tables/daily_analysis_reports]] + [[../tables/ticket_analyses]], and the voice docs from disk.
   - Call Claude Opus with the decision schema (`accept` / `reject` / `merge` / `supersede` / `human_review` / `revise` + `confidence` + `reasoning` + `references[]`).
   - Apply through Phase 3 safety guards.
3. Return per-workspace + global counts.

## Phase 3 safety guards

Implemented in `applyDecision()`:

- **Confidence floor 0.75** → forces `human_review`, prepends `[SAFETY] confidence_floor (X < 0.75)` to reasoning.
- **Daily cap** of `workspaces.sonnet_auto_review_daily_cap` (default 10) accepts per workspace per day → excess → `human_review`.
- **`delete` → `supersede`** (model never gets to delete an approved row).
- **Audit BEFORE apply** — writes [[../tables/sonnet_prompt_decisions]] first; only on success does the prompt row mutate.

A safety test (`scripts/test-prompt-auto-review-safety.ts`) verifies each invariant.

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
