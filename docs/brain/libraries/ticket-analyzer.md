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

- **`CUSTOMER_ESCALATION_KEYWORDS` substring-matches `"fraud"` against the entire inbound body**, which false-positives on benign bank phrasing — e.g. "my bank put a Fraud Alert on my card", "the fraud team called", "flagged for fraud". The customer is cooperating, not threatening, but `customerThreat` flips true and the ticket force-escalates silently regardless of score. Seen on ticket `a613e06e` (Elizabeth Fraser, 2026-06-05). **Mitigated** by `ESCALATION_KEYWORD_DENYLIST` + `matchesEscalationKeyword()` — a benign-phrase denylist that excludes the matching keyword when a cooperating-context phrase is present (added via the agent-todo `code_change`, PR #2). The same substring risk still applies to other keywords (`"scam"`, `"report you"`) that aren't yet denylisted.
- **No idempotency check on repeat mutations within a ticket.** The orchestrator can fire `bill_now` (or any mutation) twice in consecutive turns without verifying the first attempt's outcome — the analyzer only surfaces it after the fact as `missed_opportunity`, but the prevention belongs in orchestrator rules, not grading. Seen on the same ticket: `bill_now` fired in turn 2 and again in turn 3 without checking turn 2's result, with real duplicate-charge risk. Addressed by a sonnet_prompt rule (todo `943de409`) instructing the orchestrator to check the prior action result before re-firing a mutation.

---

[[../README]] · [[../../CLAUDE]]
