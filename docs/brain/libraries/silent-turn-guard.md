# libraries/silent-turn-guard

The pure runtime predicate for the [[../inngest/unified-ticket-handler]] post-auto-advance step: "did this playbook-exec turn actually reach the customer, or did it end silent?" Mirrors [[tickets-read]] `buildTurnTimeline`'s READ-side `silentTurn` diagnostic, but this variant runs INSIDE the handler so a silent turn triggers the escalate_api_failure holding-message + Slack rail instead of just being observable after the fact.

**File:** `src/lib/silent-turn-guard.ts`

## What it does

Given four tracked signals — `responseSent`, `escalationRaised`, `cancelled`, `finalAction`, `finalError` — returns `{silent: false}` when the customer heard back OR the existing escalate_api_failure rail already fired OR a newer inbound superseded the turn; otherwise returns `{silent: true, reason, note}`:

- **`dead_playbook_resume`** — no response, no escalation, no error; the exec concluded on `action=complete` OR the auto-advance loop hit `MAX_AUTO_ADVANCE` with no reply. Melissa/eca3f43b's exact class (stale post-resolution playbook resumed and silently ran to complete).
- **`playbook_mutation_failed`** — same silence but a `PlaybookExecResult.error` string was carried. Guards against an executor bug where a mutation failure fails to flip `action='escalate_api_failure'` — the runtime guard still short-circuits it into the holding-message path.

## Why it exists

Melissa/eca3f43b — see [[../specs/post-resolution-inbound-reroute-and-silent-turn-guard]] § Phase 2. After June resolved the ticket with an in-flight return, a later customer reply resumed the stale pre-escalation refund playbook. The playbook found nothing to do, tried to cancel her subscription (it FAILED), and — crucially — sent the customer ZERO customer-facing text. Measured: 5 of 13 backstopped tickets ended silent. A handled non-new inbound MUST never conclude without either a customer-facing reply OR an explicit escalation with a holding message.

## Exports

- **`detectSilentTurn(inputs) → SilentTurnVerdict`** — pure predicate returning `{silent: false}` OR `{silent: true, reason, note}`.
- **`SilentTurnReason`** — `"dead_playbook_resume" | "playbook_mutation_failed"`.
- **`SilentTurnVerdict`** — discriminated union.
- **`SilentTurnInputs`** — interface for the five tracked signals.
- **`SILENT_TURN_HOLDING_MESSAGE`** — the exact copy the escalate_api_failure rail sends today (`"I need a little time to work on this and I'll get back to you."`). Exported so the runtime guard's escape hatch sends the byte-identical string and a test can pin the coupling — the customer never sees two different holding messages.

## How it's used

**Caller:** `src/lib/inngest/unified-ticket-handler.ts` — the exec-playbook-step + auto-advance block tracks `responseSent` (any `pbResult.response` / advance-loop `pr.response` shipped via `sendWithDelay`) and `escalationRaised` (the `escalate_api_failure` branch already fired). After the auto-advance loop concludes, the handler calls `detectSilentTurn`; on `silent:true` it runs the SAME `raiseHoldingMessageEscalation` closure the escalate_api_failure branch uses (holding message → `SILENT_TURN_HOLDING_MESSAGE`, ticket → open + escalated, Slack notify) so a silent turn is impossible by construction and the return-value shape is `{ status: "playbook_silent_turn", reason }`.

## Gotchas

- **Pure / test-friendly.** Unit tests (`silent-turn-guard.test.ts`) pin every reason + the whitespace-error edge case + the note truncation.
- **Copy-coupled.** `SILENT_TURN_HOLDING_MESSAGE` MUST stay in lockstep with the string the escalate_api_failure branch sends — a drift means a customer sees two different holding messages depending on which rail fired. The test file pins the exact string.
- **Order of precedence.** cancelled > responseSent > escalationRaised > error-present > action-only. This ordering is load-bearing — a `responseSent=true` case with `finalError=<something>` is NOT silent (an error string on an otherwise-successful turn is a soft warning, not a customer-facing gap).
- **Not a read-side replacement.** [[tickets-read]] `buildTurnTimeline`'s `silentTurn` diagnostic still exists as the AFTER-THE-FACT ticket-thread QA read — the runtime guard is the BEFORE-THE-FACT preventer. Both should stay green.

## Related

[[../inngest/unified-ticket-handler]] · [[playbook-executor]] · [[tickets-read]] · [[../specs/post-resolution-inbound-reroute-and-silent-turn-guard]] · [[../specs/agent-todo-system]]
