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

- **The `customerThreat` scan must use the CLEANED body, not raw `body`.** Inbound email replies quote the message they're replying to. Our own order-confirmation emails carry a "Join our Facebook group!" footer, so every reply to one quotes it — and `CUSTOMER_ESCALATION_KEYWORDS` contains the bare substring `"facebook"`. Scanning raw `body` substring-matched that quoted footer → `customerThreat` true → silent force-escalate of a positively-closed ticket. Seen on ticket `246163b4` (Melissa Sachs, 2026-06-19, score **9** — "handled correctly, customer closed positively"). **Fixed:** the scan now reads `m.body_clean || cleanEmailBody(m.body)` ([[email-cleaner]] strips quoted history + signatures), so only the customer's actual new text is checked. This was systemic — any email reply quoting our Facebook footer would have tripped it.
- **`CUSTOMER_ESCALATION_KEYWORDS` substring-matches `"fraud"` against the entire inbound body**, which false-positives on benign bank phrasing — e.g. "my bank put a Fraud Alert on my card", "the fraud team called", "flagged for fraud". The customer is cooperating, not threatening, but `customerThreat` flips true and the ticket force-escalates silently regardless of score. Seen on ticket `a613e06e` (Elizabeth Fraser, 2026-06-05). **Mitigated** by `ESCALATION_KEYWORD_DENYLIST` + `matchesEscalationKeyword()` — a benign-phrase denylist that excludes the matching keyword when a cooperating-context phrase is present (added via the agent-todo `code_change`, PR #2), and now also by scanning cleaned bodies (above). The same substring risk still applies to other keywords (`"scam"`, `"report you"`, the social-platform names) on the customer's *own* text — a benign mention ("I saw your post on Facebook") could still match; tightening those to require threatening context is open work.
- **No idempotency check on repeat mutations within a ticket.** The orchestrator can fire `bill_now` (or any mutation) twice in consecutive turns without verifying the first attempt's outcome — the analyzer only surfaces it after the fact as `missed_opportunity`, but the prevention belongs in orchestrator rules, not grading. Seen on the same ticket: `bill_now` fired in turn 2 and again in turn 3 without checking turn 2's result, with real duplicate-charge risk. Addressed by a sonnet_prompt rule (todo `943de409`) instructing the orchestrator to check the prior action result before re-firing a mutation.

---

[[../README]] · [[../../CLAUDE]]
