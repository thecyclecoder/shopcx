# libraries/ticket-analyzer

Per-ticket AI analysis: sentiment, intent, summary, suggested action. Writes [[../tables/ticket_analyses]].

**File:** `src/lib/ticket-analyzer.ts`

## File header

```
Per-ticket AI analysis. Replaces the nightly batch.
Flow:
1. Find closed tickets needing analysis (cron, every 30 min)
2. For each ticket, pull messages since last_analyzed_at (or ticket creation)
3. Skip if no AI messages in window (don't waste a call)
4. Skip if ticket is spam/outreach/auto-reply (low-value)
5. Send to Sonnet with the rubric + approved grader_prompts
6. Insert ticket_analyses row + ai_token_usage row tagged with ticket_id
7. Apply severity actions: ≤5 → escalate + notify customer; 6 → escalate silently;
7+ → log only. Plus issue-type overrides.
See discussion 2026-05-06 with Dylan.
```

## Exports

### `analyzeTicket` — function

```ts
async function analyzeTicket(ticketId: string, trigger: "auto_close" | "manual_close" | "reopen_close" | "manual" = "auto_close",) : Promise<AnalyzeResult>
```

## Callers

- `src/lib/inngest/ticket-analysis-cron.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
