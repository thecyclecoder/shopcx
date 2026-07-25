# libraries/cs-director-ticket-transition

The **pure patch builder** for the per-verdict `tickets` state transition that Phase 2 of [[../specs/cs-director-call-closes-the-ticket-loop-note-and-resolution-per-verdict]] applies after a CS Director (June) verdict.

**File:** `src/lib/cs-director-ticket-transition.ts`

## What it does

Decides the ticket state patch to apply after a CS Director verdict, enforcing the invariant: **never leave a ruled-on ticket in the `open+escalated+no-owner` limbo**. Phase 1 wrote an internal note; this phase closes the structural gap where a ticket could remain open + escalated after being reviewed.

The per-verdict behavior:
- **`author_spec`** (CONFIRMED write — `authorSpecOutcome.ok === true` OR missing outcome for legacy back-compat) → close + de-escalate + unassign. The customer side is complete; the structural fix is tracked on the authored spec.
- **`author_spec`** (FAILED write — `authorSpecOutcome.ok === false`) → **`keep_escalated_needs_attention`**. Leave the ticket OPEN + ESCALATED and stamp `escalation_reason` with `"author_spec FAILED ({reason}) — no spec was written; ticket needs human review"` so it lands back in the queue instead of disappearing on a phantom close. See [[../specs/cs-director-spec-claim-must-match-the-actual-write]] Phase 2.
- **`approve_remedy`** (with customer reply pending) → de-escalate only. Status stays `open` so the Phase-2 executor can ship the customer reply without the ticket being stranded on the escalation queue.
- **`approve_remedy`** (no customer reply needed) → close + de-escalate + unassign. Same as a confirmed `author_spec`.
- **`escalate_founder`** → keep escalated but record that it now awaits the CEO. When the caller resolves the workspace owner's `user_id`, it is stamped on `escalated_to` so the ticket is owned by the founder rather than stranded on the routine's default lane.

**Playbook-supersede on resolution** ([[../specs/post-resolution-inbound-reroute-and-silent-turn-guard]] § Phase 1 — derived-from Melissa/eca3f43b). Both resolution-side patches (`close_and_deescalate` + `deescalate_only`) additionally null `active_playbook_id` + `playbook_step` + `playbook_exceptions_used` so a June-resolved ticket cannot resume a stale pre-escalation playbook on a later customer follow-up. The `escalate_founder` patch deliberately leaves the playbook alone — the founder ruling may still fold back into the pre-escalation lane. The runner drops a `[System] Active playbook cleared — the CS Director has resolved this ticket …` internal note when the pre-patch `active_playbook_id` was non-null AND the transition was `close_and_deescalate` or `deescalate_only`, so the ticket thread carries an audit-visible receipt of the supersede. The handler's own [[../inngest/unified-ticket-handler]] check-playbook guard ([[playbook-supersede-guard]]) is the belt-and-suspenders safety net for any code path that reaches a director resolution WITHOUT going through this helper.

## Exports

- **`decideCsDirectorTicketTransition(input: CsDirectorTransitionInput): CsDirectorTicketTransition`** — pure function that builds the patch. Takes the decision, reasoning, optional remedy plan, optional `authorSpecOutcome`, optional CEO user_id, and a timestamp. Returns `{patch, action_key}` where `patch` is the `tickets` row update and `action_key` names the applied logic for audit/logging.
- **`CsDirectorDecision`** — type alias for the four verdict shapes.
- **`CsDirectorAuthorSpecOutcome`** — interface for the `authorSpecOutcome` field: `{ ok, reason? }`. Only meaningful for `decision='author_spec'`.
- **`CsDirectorTransitionInput`** — interface for the input (decision, reasoning, remedy, authorSpecOutcome, ceoUserId, now timestamp).
- **`CsDirectorTicketTransition`** — return type with `patch` (record of column updates) and `action_key` (one of `close_and_deescalate`, `deescalate_only`, `keep_escalated_ceo_owned`, `keep_escalated_needs_attention`, `noop`).
- **`CsDirectorTransitionActionKey`** — enum of the five possible actions.

## How it's used

**Caller:** `scripts/builder-worker.ts` `runCsDirectorCallJob` — after the verdict's internal note is written and the `director_activity` row is audited, the runner calls `decideCsDirectorTicketTransition` and executes the patch via a compare-and-set update: `.eq("id", ticketId).eq("workspace_id", …).select("id")`. The compare-and-set guards against async races where the ticket has moved on since the verdict was rendered.

## Gotchas

- **Pure / test-friendly.** The function takes no DB or runtime context — `runCsDirectorCallJob` handles the `tickets` update, and unit tests (`cs-director-ticket-transition.test.ts`) exercise every verdict shape and remedy variant independently.
- **`author_spec` CLOSES only on a confirmed write.** Ticket 2b7ea029 was closed + de-escalated on a phantom `author_spec` verdict (the LLM claimed a slug that never landed in the specs table), and the irreversibility of the close hid the missing spec for a day. Callers MUST thread `authorSpecOutcome` from `handleAuthorSpec`; a failed write returns `keep_escalated_needs_attention` (leaves the ticket open + escalated + stamps `escalation_reason` with the concrete failure class like `author_spec_write_returned_false`, `ticket_id_unresolved`, `author_spec_threw`). A missing `authorSpecOutcome` falls back to `close_and_deescalate` for legacy back-compat — the shipped `runCsDirectorCallJob` call site ALWAYS threads it. See [[../specs/cs-director-spec-claim-must-match-the-actual-write]] Phase 2.
- **Remedy detection.** The function checks multiple field names (`needs_customer_reply`, `customer_reply`, `close_ticket`, `resolves_ticket`, `status`) because the RemedyPlan shape is evolving alongside the Phase-2 executor. Conservative default: if none of the signals are set, the function assumes a customer reply IS pending and only de-escalates.
- **CEO ownership at escalate_founder.** The `ceoUserId` is optional; if omitted, `escalated_to` is not stamped. The escalation reason is always stamped with `"CEO — awaits founder ruling: <reasoning>"` (capped at 400 chars — the full reasoning lives on `director_activity` + the internal note).
- **Compare-and-set in the runner.** The patch is built but the write is the runner's responsibility, with a `.select("id")` guard so a zero-row result is logged as a miss (another process advanced the ticket concurrently) rather than silently overwritten.

## Related

[[cs-director]] · [[cs-director-verdict-note]] · [[../tables/tickets]] · [[../inngest/cs-director-digest-composer]] · [[../tables/director_activity]]
