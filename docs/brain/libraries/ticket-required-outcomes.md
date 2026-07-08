# ticket-required-outcomes

`src/lib/ticket-required-outcomes.ts` — the SDK for the structured, individually-checkable "what" behind a customer reply. The **message-is-last** pipeline drives off these rows instead of prose:

1. **Phase 1** (this SDK) — Sol distills the customer's asks into N structured rows in [[../tables/ticket_required_outcomes]], each with an `expected_db_state` predicate.
2. **Phase 2** — the executor honors each row (fires the action + verifies against the DB) BEFORE any reply is composed.
3. **Phase 3** — the customer-facing send guard blocks any claim whose backing row isn't `status='verified'` (ledger stamp `verified_outcome='unbacked'`).
4. **Phase 4** — the completion gate keeps the ticket in-progress until every row is verified.

See [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] · [[../goals/guaranteed-ticket-handling]].

## Exports

| Symbol | Signature | Purpose |
|---|---|---|
| `RequiredOutcomeStatus` | type: `'pending'\|'done'\|'verified'\|'failed'` | The four-state lifecycle. `verified` is the ONLY closed status. |
| `ExpectedDbState` | type: `Record<string, unknown>` | The DB predicate that would prove the item done. Phase 2 defines how the executor consumes it. |
| `TicketRequiredOutcome` | interface | Row shape for reads. |
| `RequiredOutcomeInput` | interface | The `{kind, description, target_ids?, expected_db_state?}` a writer supplies per item. |
| `writeRequiredOutcomes(admin, {workspace_id, ticket_id, direction_id?, items})` | insert | Batch-insert N items in one call. Each item is a distinct row — this SDK never packs multiple outcomes into a single jsonb blob (the whole point is that each item is INDIVIDUALLY CHECKABLE). |
| `listRequiredOutcomes(admin, ticket_id, opts?)` | read | Every required outcome for a ticket in authored order. |
| `markOutcomeDone(admin, {id, workspace_id, resolution_event_id?})` | CAS `pending → done` | Executor fired the action; DB verify hasn't confirmed yet. Returns `null` on CAS-lost. |
| `markOutcomeVerified(admin, {id, workspace_id, from?, resolution_event_id?})` | CAS `done → verified` (or `pending → verified` with `from:'pending'`) | The `expected_db_state` predicate holds. Stamps `verified_at`. |
| `markOutcomeFailed(admin, {id, workspace_id, from?, reason, resolution_event_id?})` | CAS to `failed` | Escalation trigger. Stamps `failed_reason`. |
| `hasUnverifiedOutcomes(admin, ticket_id, workspace_id)` | read | `true` when at least one row has status ≠ `'verified'`. The Phase-4 completion gate's core predicate; backed by the partial index. |
| `countOutcomesByStatus(admin, ticket_id, workspace_id)` | read | Breakdown by status — the Phase-4 escalation message uses this to name "2 pending, 1 failed". |

## Callers

Phase 1 lands the SDK; callers wire in as later phases land:

- **Sol's box session** (`scripts/builder-worker.ts` → `runTicketHandleJob`, via `src/lib/ticket-directions.ts`) — Phase 2 wire-in of the parent spec will call `writeRequiredOutcomes` at Direction-authoring time.
- **`src/lib/action-executor.ts` `executeSonnetDecision`** — Phase 2 wire-in will walk `listRequiredOutcomes` and stamp `done` / `verified` / `failed` as the actions land.
- **`src/lib/sol-policy-bait-guard.ts` `assessSolReplyBaitRisk`** — Phase 3 wire-in will extend the guard beyond bait risk to reject any claim whose backing outcome row isn't `verified`.
- **`src/inngest/unified-ticket-handler.ts`** — Phase 4 wire-in will read `hasUnverifiedOutcomes` before auto-resolving a ticket; a non-empty checklist keeps the ticket in-progress or escalates naming the unfinished items via `countOutcomesByStatus`.

## Invariants

- **CAS on every mutation.** Every status transition includes `.eq('status', <from>)` + `.eq('workspace_id', …)` so a racing writer can't overwrite a fresher terminal state with a stale one (learning #5 — re-assert the read-time predicate in the write, never trust a proxy). A lost CAS returns `null`; the caller re-reads and decides how to react.
- **`verified` is the only closed status.** `hasUnverifiedOutcomes` returns true for `pending`, `done`, AND `failed`. A `done` row means the action fired but the predicate hasn't been confirmed — the Phase-3 send guard treats it the same as `pending`: not ship-worthy.
- **`writeRequiredOutcomes` is batch-only for the same Direction.** N items → one insert call → one bounded write. Downstream corrections author a fresh row and mark the stale one `failed`, never `.update()` a landed predicate in place.

## Migration + probe

- Table: `supabase/migrations/20261001120000_ticket_required_outcomes.sql` (apply: `npx tsx scripts/apply-ticket-required-outcomes-migration.ts`).
- Smoke test: `npx tsx scripts/_probe-ticket-required-outcomes.ts` — inserts two structured outcomes on a throwaway ticket, drains one pending → done → verified, fails the other, and asserts the completion-gate + count breakdown.

---

[[../README]] · [[../tables/ticket_required_outcomes]] · [[../tables/ticket_directions]] · [[../tables/ticket_resolution_events]] · [[../libraries/action-executor]] · [[../libraries/sol-policy-bait-guard]] · [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] · [[../goals/guaranteed-ticket-handling]] · [[../../CLAUDE]]
