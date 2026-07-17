# libraries/playbook-supersede-guard

The pure predicate for the [[../inngest/unified-ticket-handler]] check-playbook guard: "should the ticket's active playbook be cleared before the next inbound turn runs?"

**File:** `src/lib/playbook-supersede-guard.ts`

## What it does

Given two DB read booleans, returns the reason a playbook should be superseded — `"agent_reply"` when a human has replied externally, `"director_resolution"` when a CS-Director verdict note landed, or `null` when neither signal is present. Agent-reply outranks a director-resolution when both are true (a human reply is the stronger signal that the conversation has moved out of the AI's hands entirely; the sysNote wording is more accurate).

## Why it exists

Melissa/eca3f43b — see [[../specs/post-resolution-inbound-reroute-and-silent-turn-guard]] § Phase 1. The original guard only fired on an external human-agent reply. June (the CS Director) resolves a ticket as AI (`approve_remedy` + close + de-escalate), so her resolution slipped past the guard: the ticket's stale pre-escalation refund playbook stayed active, a later customer follow-up wrongly re-ran it, the playbook found nothing to do, silently failed a cancel, and sent the customer NOTHING back. Widening the guard to also treat a June resolution as a supersede routes the follow-up back to Sol/Sonnet first-touch (remedy-aware) instead of a stale pre-escalation lane.

The runner's write-site ([[../libraries/cs-director-ticket-transition]] → `runCsDirectorCallJob`) is the primary clearing path — the CS-director transition patch nulls `active_playbook_id` + `playbook_step` + `playbook_exceptions_used` as part of the `close_and_deescalate` / `deescalate_only` patch, so the handler almost never sees an "active_playbook_id + `[CS Director review]` note" pair. This helper is the belt-and-suspenders safety net for the case where a director-resolution write reached the ticket via a path that did NOT clear the playbook (a hand-written SDK call, a partial-failure transition patch, a legacy row) — the handler still short-circuits the resume.

## Exports

- **`detectPlaybookSuperseder({ hasExternalAgentReply, hasCsDirectorResolutionNote })`** — pure predicate returning `PlaybookSupersedeReason | null`.
- **`playbookSupersedeReasonPhrase(reason)`** — human phrase for the sysNote (`"a human agent has replied externally on this ticket"` / `"the CS Director has resolved this ticket"`).
- **`CS_DIRECTOR_VERDICT_NOTE_PREFIX = "[CS Director review]"`** — the exact body prefix `buildCsDirectorVerdictNote` writes. Exported so the handler ilike-matches on the same prefix and a test can pin the coupling.

## How it's used

**Caller:** `src/lib/inngest/unified-ticket-handler.ts` § "check-playbook" step. Two parallel `ticket_messages` reads (one for an external agent reply, one for a `[CS Director review]` internal system note) feed the predicate; a non-null reason triggers the `active_playbook_id / playbook_step / playbook_exceptions_used` clear + a `[System] Active playbook cleared — <phrase>, so the playbook is no longer authoritative. Routing to Sonnet.` internal note. `agent_intervened` is only stamped true on `"agent_reply"` — a director-resolution supersede leaves the column unchanged because June is an AI.

## Gotchas

- **Pure / test-friendly.** No DB, no network; unit tests (`playbook-supersede-guard.test.ts`) pin every input combo + the sysNote wording contract.
- **Note-prefix coupling.** `CS_DIRECTOR_VERDICT_NOTE_PREFIX` MUST stay in lockstep with `buildCsDirectorVerdictNote`'s header line — a drift silently breaks the widened supersede path. The test file pins the exact string.

## Related

[[cs-director-verdict-note]] · [[cs-director-ticket-transition]] · [[../inngest/unified-ticket-handler]] · [[../tables/tickets]] · [[../specs/post-resolution-inbound-reroute-and-silent-turn-guard]]
