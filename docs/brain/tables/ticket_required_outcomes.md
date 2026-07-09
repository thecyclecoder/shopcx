# ticket_required_outcomes

The **structured, individually-checkable "what"** behind a customer reply — one row per concrete outcome the ticket-handling pipeline commits to (e.g. "add a second bag to next order", "apply $15 credit", "create a replacement"). The **message-is-last** pipeline drives off these rows instead of prose. See [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] and [[../goals/guaranteed-ticket-handling]].

Written by Sol's box session (`runTicketHandleJob` — Phase 2 wire-in of the parent spec) via `src/lib/ticket-required-outcomes.ts` (`writeRequiredOutcomes` / `markOutcomeDone` / `markOutcomeVerified` / `markOutcomeFailed`). Until later phases land the executor + send-guard wire-in, the table exists and the SDK writes rows but nothing downstream reads them yet.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `ticket_id` | `uuid` | — | → [[tickets]].id · ON DELETE CASCADE — the ticket the outcome is scoped to |
| `direction_id` | `uuid` | ✓ | → [[ticket_directions]].id · ON DELETE SET NULL — the Direction that authored this outcome (null once the Direction is deleted; the outcome row survives so an already-verified item stays visible in the record) |
| `kind` | `text` | — | the kind of outcome (e.g. `apply_coupon`, `create_replacement`, `add_bag_to_next_order`, `partial_refund`) — loosely keyed to [[../libraries/action-executor]] `ActionParams.type` but intentionally looser (customer intent may include ad-hoc asks the executor doesn't directly know) |
| `description` | `text` | — | one-line human-readable summary of the item (what the customer needs, in plain English) — the string the Phase-4 escalation surfaces when it names the unfinished items |
| `target_ids` | `jsonb` | — | default `'{}'` — the target ids the outcome references (e.g. `{"contract_id":"gid://...","code":"WELCOME15"}`) |
| `expected_db_state` | `jsonb` | — | default `'{}'` — the DB predicate that would prove the item done (e.g. `{"table":"subscriptions","match":{...},"column":"status","expected":"paused"}`); Phase 2 defines how the executor consumes it |
| `status` | `text` | — | CHECK ∈ `pending` \| `done` \| `verified` \| `failed`. `pending` = executor hasn't fired the action; `done` = action fired, DB verify hasn't confirmed; `verified` = predicate holds; `failed` = executor escalated on a guardrail or verify couldn't back the claim |
| `resolution_event_id` | `uuid` | ✓ | → [[ticket_resolution_events]].id · ON DELETE SET NULL — the executor turn that produced this outcome (stamped by Phase 2's `markOutcomeDone` / `markOutcomeVerified` / `markOutcomeFailed`) |
| `verified_at` | `timestamptz` | ✓ | stamped when status transitions to `verified` — the moment the Phase-3 send guard can honor a claim on this row |
| `failed_reason` | `text` | ✓ | reason the item failed (for status=`failed`) — surfaced verbatim in the Phase-4 escalation |
| `authored_by` | `text` | — | default `'sol_box_session'` |
| `authored_at` | `timestamptz` | — | default `now()` |

**CHECK constraints:** `status ∈ {'pending','done','verified','failed'}`.

**Indexes:**
- `(workspace_id, ticket_id, authored_at ASC)` — the per-ticket "list every required outcome in authored order" read (Phase 2 executor walk + Phase 3 send-guard lookup + Phase 4 completion gate).
- **partial** `(workspace_id, ticket_id) WHERE status <> 'verified'` — the fast completion-gate probe. Keeps the "any still-open outcome?" check cheap even when the ticket has dozens of already-verified rows.

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `ticket_id` → [[tickets]].id · `direction_id` → [[ticket_directions]].id · `resolution_event_id` → [[ticket_resolution_events]].id.

**In:** none yet — this table is the "what" checklist; the Phase-3 send guard and Phase-4 completion gate READ these rows but don't FK against them.

## Read paths

- **Phase 2 executor — [[../libraries/honor-required-outcomes]]** — walks `listRequiredOutcomes(admin, ticket_id)` and, per row, fires the action via `directActionHandlers` + verifies via `verifyActionInDB` and marks the row `verified` or `failed`. Stamps `resolution_event_id` back to the [[ticket_resolution_events]] row it authored.
- **Phase 3 send guard** — before a customer-facing message ships, checks that every outcome the message asserts is backed by a row with `status='verified'`. An unbacked claim is BLOCKED (ledger stamp `verified_outcome='unbacked'`) and rewritten to the truthful state.
- **Phase 4 completion gate** — a ticket cannot auto-resolve while `hasUnverifiedOutcomes` is true; escalations name the specific unfinished items via `countOutcomesByStatus`.

## Row lifecycle

1. **Insert (`authored_at`, `status='pending'`)** — Sol's box session distills the customer's asks into N structured items and `writeRequiredOutcomes` inserts them in one batch. `direction_id` links back to the Direction that authored them; `expected_db_state` records the predicate that would prove each item done.
2. **`pending` → `done` (Phase 2)** — the executor fires the action (e.g. `apply_coupon`), the handler returns success. `markOutcomeDone` CAS from `pending` and stamps `resolution_event_id`.
3. **`done` → `verified` (Phase 2)** — the executor's `verifyActionInDB` (or an equivalent read-back) confirms the `expected_db_state` predicate holds. `markOutcomeVerified` CAS from `done`, stamps `verified_at` and (optionally) `resolution_event_id`. From here the Phase-3 send guard can honor claims on this row.
4. **`pending`/`done` → `failed` (Phase 2)** — the executor escalated on a guardrail, the handler errored, or DB verify couldn't back the claim. `markOutcomeFailed` CAS and stamps `failed_reason`. The Phase-4 completion gate names the reason verbatim in the escalation.

## RLS
Service-role only (RLS enabled with no policies). Every write goes through `createAdminClient()` from `src/lib/ticket-required-outcomes.ts` — per CLAUDE.md's "All writes go through `createAdminClient()`" invariant. No client-side reads.

## Invariants
- **Every mutation is compare-and-set on `status`.** `markOutcomeDone` / `markOutcomeVerified` / `markOutcomeFailed` all include `.eq('status', <from>)` so a racing writer that already moved the row to a fresher terminal state can't be overwritten by a stale one (mirrors learning #5 — re-assert the read-time predicate in the write). A lost CAS returns `null`; the caller reads the row and decides how to react.
- **`verified` is the only closed status.** `hasUnverifiedOutcomes` returns true for `pending`, `done`, AND `failed` — a failed item is not "done", it's a Phase-4 escalation trigger. The Phase-3 send guard treats claims on `done` rows the same as claims on `pending`: the DB verify hasn't yet confirmed the predicate, so the claim isn't ship-worthy.
- **`expected_db_state` is authored, not derived.** The row's author records the shape of the proof at authoring time; downstream execution consumes it, doesn't rewrite it. Correcting a bad predicate is a fresh row + `failed` on the old one (via `superseDirection` if the whole Direction is being re-authored), never an in-place UPDATE of a landed predicate.

## Migration

`supabase/migrations/20261001120000_ticket_required_outcomes.sql` (apply: `npx tsx scripts/apply-ticket-required-outcomes-migration.ts`). Idempotent — creates the table, both indexes (`(workspace_id, ticket_id, authored_at ASC)` + the partial `(workspace_id, ticket_id) WHERE status <> 'verified'`), and enables RLS.

Probe: `npx tsx scripts/_probe-ticket-required-outcomes.ts` — inserts two structured outcomes on a throwaway ticket, drains one to `verified` and fails the other, asserts the completion-gate + count breakdown, and cleans up.

---

[[../README]] · [[tickets]] · [[ticket_directions]] · [[ticket_resolution_events]] · [[workspaces]] · [[../lifecycles/ticket-lifecycle]] · [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] · [[../goals/guaranteed-ticket-handling]] · [[../functions/cs]] · [[../../CLAUDE]]
