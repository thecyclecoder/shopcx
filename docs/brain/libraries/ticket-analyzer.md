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

## Escalation routing

`analyzeTicket`'s severity actions (≤5 → escalate + notify; 6 → escalate silently) now escalate to the **AI Routine**, not a human: the re-open sets `escalated_to = null` with `escalated_at` + `escalation_reason` set (it no longer round-robins to a workspace member or pre-assigns `assigned_to`). That `escalated_at`-set + `escalated_to`-null state is exactly what [[../inngest/triage-escalations]]'s cron picks up — the idle-triage routine then runs solver→skeptic→quorum and produces approval-gated todos, handing **up** to a human only on no-quorum. The orchestrator (`action-executor.ts`), workflow executor (`workflow-executor.ts`), and portal remediation (`portal/remediation.ts`) escalations default the same way. See [[../specs/escalate-to-routine-by-default]].

## Gotchas

- **The `customerThreat` scan must use the CLEANED body, not raw `body`.** Inbound email replies quote the message they're replying to. Our own order-confirmation emails carry a "Join our Facebook group!" footer, so every reply to one quotes it — and `CUSTOMER_ESCALATION_KEYWORDS` contains the bare substring `"facebook"`. Scanning raw `body` substring-matched that quoted footer → `customerThreat` true → silent force-escalate of a positively-closed ticket. Seen on ticket `246163b4` (Melissa Sachs, 2026-06-19, score **9** — "handled correctly, customer closed positively"). **Fixed:** the scan now reads `m.body_clean || cleanEmailBody(m.body)` ([[email-cleaner]] strips quoted history + signatures), so only the customer's actual new text is checked. This was systemic — any email reply quoting our Facebook footer would have tripped it.
- **`CUSTOMER_ESCALATION_KEYWORDS` substring-matches `"fraud"` against the entire inbound body**, which false-positives on benign bank phrasing — e.g. "my bank put a Fraud Alert on my card", "the fraud team called", "flagged for fraud". The customer is cooperating, not threatening, but `customerThreat` flips true and the ticket force-escalates silently regardless of score. Seen on ticket `a613e06e` (Elizabeth Fraser, 2026-06-05). **Mitigated** by `ESCALATION_KEYWORD_DENYLIST` + `matchesEscalationKeyword()` — a benign-phrase denylist that excludes the matching keyword when a cooperating-context phrase is present (added via the agent-todo `code_change`, PR #2), and now also by scanning cleaned bodies (above). The same substring risk still applies to other keywords (`"scam"`, `"report you"`, the social-platform names) on the customer's *own* text — a benign mention ("I saw your post on Facebook") could still match; tightening those to require threatening context is open work.
- **The grader mis-read the refund playbook's designed stand-firm round as an `inaccuracy`.** The refund playbook intentionally states the policy (a tier-0 "pre-exception stand firm") before offering the Tier 1 store-credit / Tier 2 cash exception — that's the retention arc: stand firm → customer pushes back → save with an exception → positive close. The grader has the policy in context, saw the stand-firm denial, concluded "Tier 1 was available, so this was a wrong denial," labeled it `inaccuracy` (a `SEVERE_ISSUE_TYPE`) → hard-cap 5 + force-escalate — on a ticket that ended in a clean store-credit save and a positive close. The in-flight-playbook guard (line ~761) didn't save it because the playbook had **completed** (cleared `active_playbook_id` on the positive close), so the guard's `active_playbook_id` check was null. Seen on ticket `cc3d6b9b` (2026-06-19). **Fixed** via an approved `grader_prompts` calibration rule (`900a4fa0`): the stand-firm-then-save arc is correct execution, not an inaccuracy/rule_violation; tone is at most a minor note; the arc is not an escalation trigger. Re-grade went 5 → 8 (no escalation). Note: the calibration deliberately stops at "solid 8, not escalated" rather than forcing 9-10 — the opening tone was a genuine empathy miss, fixed at its source in the **refund playbook** copy, not by blinding the grader.
- **An `inaccuracy`-only flag force-escalated a happy, 7/10, positively-closed ticket.** `applySeverityActions` set `forceEscalate = hasSevereIssue || customerThreat`, where `hasSevereIssue` is true for ANY `inaccuracy`/`false_promise`/`broken_action` issue — at any score, regardless of a positive close. The grader tagged a harmless closing phrase ("your loyalty points stay intact") as an `inaccuracy` on a 7/10 ticket the customer closed happily after a clean resolution (ground truth: loyalty fully intact). That alone re-opened + escalated the ticket to the routine/human — the same churn the `customerThreat` path already avoids. Seen on ticket `9a6e53d9` (Laurie Predmore). **Fixed:** when the **only** severe trigger is `inaccuracy` (no `false_promise`/`broken_action`), there's no `customerThreat`, the score is **≥7**, and the ticket is **cleanly positively closed**, the force-escalate is suppressed and logged as a non-actionable internal note. Positive close is detected DETERMINISTICALLY via `hasCleanPositiveClose()` — it scans the FULL `ticket_messages` history for the `[System] Positive close. Ticket closed.` note (emitted at [[../inngest/unified-ticket-handler]]:1593) and confirms it's the most recent lifecycle event: no re-open/escalation note after it (so a re-opened-then-reclosed ticket like `9a6e53d9`, which had a prior score-3 reopen, is classified by its LATEST close) and no unanswered inbound customer message after it. It is NOT keyed on `tickets.status/closed_at/resolved_at` — the analyzer only runs on closed tickets, so `status='closed'` is near-universal and would suppress the override globally. `false_promise` and `broken_action` still escalate exactly as before (no heal-verification gating — `verify_refund_issued` is an unimplemented future recipe, so gating those would be a silent-drop hole); the `customerThreat` path, the score ≤6 paths, and the `selectResearchRecipes` hook are unchanged. See [[../specs/analyzer-no-force-escalate-inaccuracy-on-positive-close]].
- **No idempotency check on repeat mutations within a ticket.** The orchestrator can fire `bill_now` (or any mutation) twice in consecutive turns without verifying the first attempt's outcome — the analyzer only surfaces it after the fact as `missed_opportunity`, but the prevention belongs in orchestrator rules, not grading. Seen on the same ticket: `bill_now` fired in turn 2 and again in turn 3 without checking turn 2's result, with real duplicate-charge risk. Addressed by a sonnet_prompt rule (todo `943de409`) instructing the orchestrator to check the prior action result before re-firing a mutation.
- **The grader fetch THROWS on a Claude failure (no `grader_http_*` swallow).** `analyzeTicketInner` used to `return { ok:false, reason: grader_http_${status} }` on a non-2xx — a silent drop: the cron then marked `last_analyzed_at` and the grade was lost for good during a Claude outage. Now it throws via [[anthropic-retry]] (retryable status / network → `AnthropicDependencyError`; terminal → `NonRetriableError`), and [[../inngest/ticket-analysis-cron]] catches the dependency case and **defers** the ticket (re-graded next */30 tick — park-and-drain). See [[../specs/agent-outage-resilience]] Phase 1. (The `grader_http_*` reason no longer occurs; a thrown grader error surfaces as `ok:false` via the `threw` branch of the heartbeat below.)
- **`ai_disabled` — human directive hard gate.** When a person clicks "Turn off AI on this ticket" in the dashboard, the row's `ai_disabled` flips true. `analyzeTicketInner` returns `{ok:false, reason:'ai_disabled'}` early (right next to the `do_not_reply` skip) so we don't grade an intentional silence and we don't force-escalate a ticket a human just told us to leave alone. `applySeverityActions` also re-reads `ai_disabled` on its `tBefore` fetch and short-circuits before the `agent_intervened`/`active_playbook_id` respect-closure guards — same reason, plus the human may have toggled it AFTER the initial row-read. Non-propagating on merge; the surviving ticket keeps its own value. Phase 1 of `docs/brain/specs/human-directives-hard-gates-over-ticket-ai.md`.
- **Control Tower coverage (`ai:ticket-analyzer`).** `analyzeTicket` is a public wrapper around `analyzeTicketInner` that emits ONE [[../tables/loop_heartbeats]] beat in a try/finally at the end of every run ([[../specs/control-tower-agent-coverage]] · [[control-tower]]). `ok:false` only on a thrown run or a grader HTTP / parse error — an intentional skip (no AI messages, spam tag, merged, `do_not_reply`) beats `ok:true` (the agent correctly chose not to grade), so a normal batch of skips never trips the error-rate alert; `produced` carries `{analysis_id, score, ai_messages}`. The monitor's liveness-when-work-exists alert fires when closed AI-handled [[../tables/tickets]] with `last_analyzed_at IS NULL` exist in the window but there are 0 successful beats.

---

[[../README]] · [[../../CLAUDE]]
