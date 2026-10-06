# libraries/cs-director-close-gate

The workspace-scoped helper that closes the cross-tenant vulnerability in the pre-close inbound-message read for the CS Director's `close_no_action` gate. Phase 1 of [[../specs/inflection-resession-cs-director-ticket-messages-workspace-s]].

**File:** `src/lib/cs-director-close-gate.ts` · **Tests:** `src/lib/cs-director-close-gate.test.ts`

## What it does

Loads the list of inbound customer messages for a ticket, strictly scoped to the caller's workspace via a `tickets!inner` join. The `ticket_messages` table has NO `workspace_id` column of its own (it hangs off the ticket), so a bare `.eq('ticket_id', …)` read succeeds for a ticket owned by ANY workspace — a foreign ticket_id could leak another tenant's customer messages into the CS Director's close-no-action builder. This helper mirrors the [[./inflection-detector]] Phase 5 pattern (`loadTriggerMessageForTicket`) and enforces the same PostgREST `tickets!inner` scoping rule.

## Exports

- **`loadInboundMessagesForCloseGate(admin: SupabaseClient, workspace_id: string, ticket_id: string): Promise<CloseGateInboundMessage[]>`** — async function that loads the ascending list of inbound customer messages for a ticket, strictly scoped to the workspace. A foreign-workspace `ticket_id` resolves to an empty array (NOT a privacy leak dressed as null); so does any DB error — the caller treats that identically to "no inbound messages" (fail-safe fallthrough, a DB blip must never force-close over an unresolved customer ask).
- **`CloseGateInboundMessage`** — row shape: `{ id, direction, author_type, visibility, body, body_clean, created_at }`. Filters: `direction='inbound'` + `author_type='customer'`.

## How it's used

**Caller:** `scripts/builder-worker.ts` `runCsDirectorCallJob` (Phase 3 of [[../specs/inflection-resession-must-act-on-newest-ask]]) — the pre-close gate reads the newest inbound customer asks before the `decideCsDirectorTicketTransition` verdict. The helper is dynamically imported and called to replace the bare ticket_messages read.

## Security scoping

**The invariant:** `ticket_messages` has no `workspace_id` column, so a service-role read must enforce scope via a workspace-aware parent join. This helper enforces the PostgREST `tickets!inner(id)` join with `.eq('tickets.workspace_id', workspace_id)` — the ticket row MUST belong to the caller's workspace or the message set is empty. The query never returns cross-tenant rows; error semantics are fail-safe (empty array on DB blip, not a thrown exception or a leaked row).

## Tests

Both test cases mirror the Phase 5 pattern from `inflection-detector.reSessionSol.test.ts`:

1. **Foreign-workspace ticket_id** — a ticket belonging to a foreign workspace passed to the helper returns an empty inbound message set. Confirms the cross-tenant guard blocks the leak.
2. **Same-workspace positive case** — a ticket in the caller's workspace surfaces its inbound customer messages ascending by `created_at`. Noise rows (outbound, staff, internal) are filtered. Confirms the happy path.

Both tests run under `npx tsx --test src/lib/cs-director-close-gate.test.ts` and exercise the fixture harness (no network, pure logic).

## Related

[[./cs-director]] · [[./inflection-detector]] · [[./cs-director-ticket-transition]] · [[../tables/ticket_messages]] · [[../specs/inflection-resession-must-act-on-newest-ask]] · [[../specs/inflection-resession-cs-director-ticket-messages-workspace-s]]
