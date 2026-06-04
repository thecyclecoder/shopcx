# agent_todos

Async approval queue for the Agent To-Do system. One row per proposed action. A Claude Code Routine writes `pending` rows hourly for escalated tickets; humans approve/reject on [[../dashboard/tickets__todos]]. Approval triggers execution — customer-facing actions via the [[../inngest/agent-todo-routine]] worker (`agent-todo-execute`), system-level actions via the Routine itself.

**Nothing in this table executes without a `status='approved'` row + matching `approved_by`/`approval_role`.** Full trace: [[../lifecycles/agent-todo-system]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `source` | `text` | — | `ticket`/`csat`/`cron`/`manual` · default `ticket` |
| `source_ticket_id` | `uuid` | ✓ | → [[tickets]].id · ON DELETE SET NULL |
| `group_id` | `uuid` | — | Links every todo in one logical fix (e.g. 1 `customer_reply` + 2 `customer_action`). **Only one active group per ticket at a time.** |
| `action_type` | `text` | — | enum below |
| `payload` | `jsonb` | — | action-specific (reply HTML, `{actions:[…]}`, diff). default `{}` |
| `summary` | `text` | — | short label for list view |
| `context_what_happened` | `text` | ✓ | plain-English customer-side narrative |
| `context_what_we_propose` | `text` | ✓ | plain-English fix narrative |
| `pre_exec_context` | `jsonb` | — | drift snapshot (`latest_inbound_message_id`, `ticket_status`). default `{}` |
| `confidence` | `real` | ✓ | model confidence 0..1 |
| `urgency` | `text` | — | `urgent`/`normal`/`low` · default `normal` |
| `status` | `text` | — | `pending`/`approved`/`executed`/`rejected`/`superseded`/`failed` · default `pending` |
| `approved_by` | `uuid` | ✓ | → auth.users.id |
| `approved_at` | `timestamptz` | ✓ | |
| `approval_role` | `text` | ✓ | `owner`/`admin` |
| `executed_at` | `timestamptz` | ✓ | |
| `execution_result` | `jsonb` | ✓ | DB action → `{row_id}`; PR action → `{pr_url, branch, merged_at}`; failure → `{error}` |
| `rejected_at` | `timestamptz` | ✓ | |
| `rejected_by` | `uuid` | ✓ | → auth.users.id |
| `reject_reason` | `text` | ✓ | optional text from the reject dialog; `pr_closed_without_merge` when the cleanup pass demotes a phantom PR |
| `routine_run_id` | `uuid` | ✓ | which routine pass proposed this |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` (app-maintained) |

## `action_type` enum

| Value | Family | Approver | Executor |
|---|---|---|---|
| `customer_reply` | customer-facing | owner OR admin | Inngest worker |
| `customer_action` | customer-facing | owner OR admin | Inngest worker → `directActionHandlers` |
| `ticket_close` | customer-facing | owner OR admin | Inngest worker |
| `ticket_analysis_rescore` | system | owner OR admin | Routine (DB) |
| `sonnet_prompt_new` / `sonnet_prompt_edit` | system | owner only | Routine (DB) |
| `grader_prompt_edit` | system | owner only | Routine (PR) |
| `escalation_rule_fix` | system | owner only | Routine (PR) |
| `brain_doc_edit` | system | owner only | Routine (PR; may auto-merge if flagged) |
| `code_change` | system | owner only | Routine (PR; **never** auto-merges) |

Role gate lives in code: `canApprove()` in `src/lib/agent-todos/constants.ts`.

## Indexes

- `agent_todos_ws_status_created_idx` `(workspace_id, status, created_at desc)` — list-view paging.
- `agent_todos_source_ticket_idx` `(source_ticket_id)` — linked-todos block + active-group guard.
- `agent_todos_group_idx` `(group_id)` — group expansion.

## RLS

- `agent_todos_select` — workspace members read their workspace rows.
- `agent_todos_service` — service role full access (all writes).

## Gotchas

- **One active group per ticket.** The reasoning pass skips any ticket with a `pending`/`approved`/`executed` row. Don't insert a second group manually.
- **Drift.** The Inngest worker re-checks `pre_exec_context.latest_inbound_message_id` against live state. If the customer replied after the snapshot, the todo goes `superseded`, not `executed`.
- **`customer_action.payload`** is `{ actions: ActionParams[], diff_summary }` using the orchestrator's own action vocabulary (`remove_item`, `partial_refund`, `create_return`, `pause_timed`, …) — dispatched through `directActionHandlers` in [[../libraries/action-executor]].

## Migration

`supabase/migrations/20260604190000_agent_todos.sql`

## Related

[[tickets]] · [[ticket_messages]] · [[ticket_analyses]] · [[sonnet_prompts]] · [[../inngest/agent-todo-routine]] · [[../dashboard/tickets__todos]] · [[../dashboard/tickets__todos__id]] · [[../dashboard/tickets__escalated]] · [[../dashboard/branches]] · [[../lifecycles/agent-todo-system]]
