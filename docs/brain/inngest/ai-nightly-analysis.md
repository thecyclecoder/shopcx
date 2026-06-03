# inngest/ai-nightly-analysis

**DEPRECATED — function stub kept only for historical Inngest UI continuity.** Body returns `{ deprecated: true }` immediately and has no `triggers`. Does NOT run on a schedule.

The actual pipeline replacing this function is alive and running:

| What | Where |
|---|---|
| Per-ticket grade (every 30 min after a ticket closes) | [[ticket-analysis-cron]] (`*/30 * * * *`) |
| Daily synthesis of grades into themes + proposed rules | [[daily-analysis-report-cron]] (`0 11 * * *`) |
| Auto-review of proposed rules | [[sonnet-prompt-auto-review]] (`0 11 * * *`, runs right after the daily-report-cron) |
| Human override + dashboard | [[../dashboard/ai-analysis]] |
| The closed loop end-to-end | [[../lifecycles/ai-learning]] |

The phrase "AI nightly analysis paused 2026-04-28" in older notes refers to **the human review queue** being paused (proposals piled up without anyone approving them), NOT a cron pause. The upstream cron was already replaced by `ticket-analysis-cron` + `daily-analysis-report-cron` by then. The auto-review system documented in [[sonnet-prompt-auto-review]] is the canonical resumption — it processes the same backlog the human queue was supposed to.

**File:** `src/lib/inngest/ai-nightly-analysis.ts` (the original deprecated function)

## Functions

### `ai-nightly-analysis`
- **Trigger:** none (function has no `triggers` array)
- **Retries:** 1
- **Status:** deprecated — body returns `{ deprecated: true }` and exits

## Tables read / written

_None at runtime._ The original code is preserved below the early-return for archival reference but no longer executes.

## Related

[[ticket-analysis-cron]] · [[daily-analysis-report-cron]] · [[sonnet-prompt-auto-review]] · [[../lifecycles/ai-learning]] · [[../tables/ticket_analyses]] · [[../tables/daily_analysis_reports]] · [[../tables/sonnet_prompts]] · [[../tables/sonnet_prompt_decisions]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
