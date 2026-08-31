# libraries/playbook-repeat-guard

The pure runtime predicate for the [[../inngest/unified-ticket-handler]] `pb-send` / `pb-adv-send-*` sites: "is this playbook about to send a customer-facing message substantially identical to the last one it sent on the same ticket?" Extracted from the handler so a unit test can pin every equivalence rule and the handler stays a thin DB read + a single call to this predicate + an escalation branch.

**File:** `src/lib/playbook-repeat-guard.ts`

## What it does

Given `{ pending, lastOutbound }` — where `pending` is the plain-text reply the playbook is about to send and `lastOutbound` is the `body` of the most recent outbound external `author_type='ai'` [[../tables/ticket_messages]] row on the ticket (HTML, or null when this is the first playbook message on the ticket) — returns `{repeat: false}` when the messages are meaningfully different, and `{repeat: true, note}` when they are substantially identical.

Equivalence rules, in order:

1. **No `lastOutbound`** → nothing can repeat (first playbook message on the ticket).
2. **Empty normalized `pending` OR `lastOutbound`** → nothing meaningful to compare.
3. **Normalized exact match** → repeat. Strongest signal — verbatim re-send.
4. **One contains the other after normalization** → repeat. Covers the boilerplate-differs case where the second ask drops the `wrapResponse` first-message intro but keeps the identical question sentence.
5. **Jaccard token-set similarity ≥ 0.80** on both sides having ≥ 5 filtered tokens (≥ 3 chars each) → repeat. Catches high-Jaccard rewords ("Could you confirm …" vs "Can you confirm …").
6. **Otherwise** → not a repeat.

Very short messages (≤ 4 filtered tokens on either side) can only trip on rules 3–4, never Jaccard — the token-set math is too noisy on short acks.

## Why it exists

[[../specs/playbook-drift-classifier-sees-the-pending-question]] § Phase 2, ticket 8e2c87d6 (Suzanne Ross, 2026-08-24). The Replacement Order playbook asked "did you not receive your order at all?", her answer was misclassified NEW_TOPIC (Phase 1 closes that gap), and the playbook re-ran the SAME question on the very next turn. Then it asked her to confirm the same shipping address — same misclassification, same re-ask. A playbook that asks the same thing twice has lost state, not gathered information. The customer paid for it in round trips, and the orchestrator eventually fabricated a "currently in transit" reassurance on a shipment whose last carrier scan was 11 days old. Asking a third time is never the right move.

## Exports

- **`detectRepeatQuestion(inputs) → PlaybookRepeatVerdict`** — the pure predicate.
- **`normalizeForRepeatCheck(text) → string`** — the shared normalizer (strip HTML tags / entities, lowercase, collapse whitespace). Exported so a test can pin it directly.
- **`PlaybookRepeatInputs`** — interface for `{ pending, lastOutbound }`.
- **`PlaybookRepeatVerdict`** — discriminated union `{ repeat: false } | { repeat: true; note: string }`.

## How it's used

**Caller:** `src/lib/inngest/unified-ticket-handler.ts` — the `sendOrEscalateOnRepeat` closure inside the active-playbook block wraps every `sendWithDelay` for a customer-facing playbook reply. Before the send, it reads the most recent outbound external AI [[../tables/ticket_messages]] row on the ticket and calls `detectRepeatQuestion`. On `repeat: true` the reply is NOT sent — the handler drops a `[System] Repeat-question loop guard tripped — <note>. Not resending; escalating instead.` internal note, then routes through the SAME `raiseHoldingMessageEscalation` closure the escalate_api_failure branch uses (ticket → open + escalated, `SILENT_TURN_HOLDING_MESSAGE` to the customer, Slack header `🚨 *Playbook Repeat-Question Loop*`). Wired at BOTH send sites — the initial `pb-send` off `executePlaybookStep` AND each `pb-adv-send-${advCount}` in the auto-advance loop; the auto-advance trip additionally `break`s out so a chained duplicate can't stack a second escalation.

## Gotchas

- **Pure / test-friendly.** `playbook-repeat-guard.test.ts` pins the ground-truth Suzanne case (identical address-confirm re-ask with only closing "Thanks!" differing), the HTML-boilerplate-vs-plain-text normalization, the Jaccard-suppressed short-ack case, and the null-lastOutbound first-message case.
- **HTML vs plain text.** `pbResult.response` from `executePlaybookStep` is plain text (the `send` path calls `toHtml(msg)` when inserting into `ticket_messages`), so the stored body is HTML — both must pass through `normalizeForRepeatCheck` before equivalence holds.
- **`author_type='ai'` scope.** The DB read filters `direction='outbound' + visibility='external' + author_type='ai'` so a human-agent reply (`author_type='agent'`) or a system note (`author_type='system'`) never counts as the last outbound playbook message. This is intentional — the [[playbook-supersede-guard]] already clears the playbook on a human agent reply, so if we reach the send site the last AI outbound IS the playbook's own prior turn.
- **Not a supersede.** A repeat trip DOES escalate but does NOT null `active_playbook_id / playbook_step / playbook_exceptions_used` — the human agent that opens the to-do row decides whether to resume the playbook, hand-write a reply, or route through the CS Director. Nulling here would silently erase context; the escalation captures the drift without discarding state.

## Related

[[../inngest/unified-ticket-handler]] · [[playbook-executor]] · [[playbook-supersede-guard]] · [[silent-turn-guard]] · [[../specs/playbook-drift-classifier-sees-the-pending-question]]
