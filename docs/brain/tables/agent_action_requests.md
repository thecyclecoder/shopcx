# agent_action_requests

The queue that lets Sol's **read-only** `ticket-handle` box session request bounded, verified mutations without holding write creds — the spine of **Sol cheap-execution (enqueue → worker-execute → poll → adapt)**. Sol enqueues a schema-validated `SonnetDecision`; the deterministic execute-worker (a drain in [[../../scripts/builder-worker]], write creds) claims it, runs it through the ONE executor ([[../libraries/agent-action-queue]] `executeActionRequest` → [[../libraries/tickets-mutate]] `runTicketDecision` → `executeSonnetDecision`), verifies, and writes the REAL result back. Sol long-polls the row and crafts her reply from the actual outcome.

This SUPERSEDES the post-hoc `required_outcomes` honor step ([[ticket_required_outcomes]], spec `eliminate-false-promises…`) for the ticket-handle path: rather than DECLARE an outcome and let a brittle exact-match verify fire+gate it (which false-failed a successful Oct-renewal and hard-blocked the reply → dead silence on Sofia 83ee7005), Sol EXECUTES mid-session and reads the real result before she writes a word — adapting in-session on failure with no cold re-session.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid NOT NULL → workspaces | tenant scope |
| `ticket_id` | uuid NOT NULL → tickets | the ticket the action belongs to |
| `customer_id` | uuid → customers | resolved from the ticket at enqueue |
| `direction_id` | uuid → ticket_directions | provenance (Sol's live Direction) |
| `status` | text | `pending` · `pending_condition` · `running` · `done` · `failed` · `expired` |
| `decision` | jsonb NOT NULL | the validated `SonnetDecision` (action_type + actions[] + handler_name…) |
| `dry_run` | boolean NOT NULL default false | REHEARSAL — runs with `ctx.sandbox=true` (simulate, no mutation, no send, no real outcome-ledger write). Forced on by `SOL_DRY_RUN=1`; Sol can't turn it off |
| `trigger_condition` | jsonb | null = run now; else the condition that must hold before a `pending_condition` row promotes to `pending` (deferred/conditional actions) |
| `result` | jsonb | verified outcome `{ok, messageSent, escalated, closed, statusManaged}` — what Sol polls |
| `error` | text | failure message on `failed` |
| `attempts` | integer NOT NULL default 0 | claim increments it |
| `created_at` / `claimed_at` / `started_at` / `completed_at` | timestamptz | lifecycle stamps |
| `expires_at` | timestamptz | TTL for `pending_condition` rows (abandonment) |

## Indexes

- `idx_agent_action_requests_claim` — partial `(status, created_at)` WHERE status IN (`pending`,`pending_condition`): the worker's oldest-first claim scan.
- `idx_agent_action_requests_ticket` — `(ticket_id, created_at DESC)`: Sol's long-poll + per-ticket lookups.

## Status lifecycle

`pending` (ready now) → `running` (atomic compare-and-set claim) → `done` (executed + verified; `result` populated) or `failed` (executed but action failed; `error` populated — NO false success sent). `pending_condition` (armed) → `pending` when `trigger_condition` holds, or → `expired` when its TTL lapses.

## Gotchas

- A `direct_action` runs **action-only** — the executor blanks `decision.response_message` so the queue never sends a customer message. Sol's `first_reply` (composed from the result) is the SOLE customer touch; no double-send.
- On success/failure the executor also writes a [[ticket_required_outcomes]] row reflecting the REAL terminal status (`verified`/`failed`) so the existing claim-guard's false-promise protection still holds for the money/state kinds. A `dry_run` writes NO ledger row.
- Journeys/playbooks are NOT enqueued — Sol keeps those on her `chosen_path`/`plan`.
- **Ticket hard-delete dependency.** When a ticket is deleted (owner/admin route), the delete handler must clear `agent_action_requests` rows BEFORE deleting the ticket row — the foreign key `ticket_id` → `tickets.id` blocks hard-delete otherwise. The route validates the parent ticket (id + workspace_id), then deletes all matching action requests with explicit `.eq('workspace_id', workspaceId)` scoping (no cross-tenant row deletion), then deletes dependent rows (returns, store_credit_log, ticket_messages), then finally the ticket. Same tenant-scoped pattern applied to all children — a multi-tenant safeguard against workspace boundary violations when service-role RLS is bypassed.

## Migration

`supabase/migrations/20260709130000_agent_action_requests.sql` · apply via `scripts/apply-agent-action-requests-migration.ts`.
