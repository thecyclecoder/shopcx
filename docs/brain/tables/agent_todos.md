# agent_todos

Async approval queue for the Agent To-Do system. One row per proposed action. The **box-hosted escalation triage** ([[../specs/box-escalation-triage]] — the hourly solver→skeptic→quorum sweep, `runEscalationTriageJob`) writes `pending` rows for escalated tickets on quorum; the admin Improve flow + the box ticket-Improve agent ([[../specs/box-ticket-improve]]) also produce rows; humans approve/reject on [[../dashboard/tickets__todos]]. Approval fires the Inngest `agent-todo-execute` worker ([[../inngest/agent-todo-routine]]) for **every** kept action type.

> **The Anthropic-cloud "agent-todo routine" that used to write these rows is RETIRED** ([[../specs/box-escalation-triage]]). The box ([[../recipes/build-box-setup]]) is now the sole producer, and **system-level todos no longer exist** — rule changes are proposed [[sonnet_prompts]], code/analyzer fixes are committed `docs/brain/specs/` files. See [[../lifecycles/agent-todo-system]].

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

## `action_type` enum — the **four kept types**

| Value | Approver | Executor |
|---|---|---|
| `customer_reply` | owner OR admin | Inngest `agent-todo-execute` worker |
| `customer_action` | owner OR admin | Inngest worker → `directActionHandlers` |
| `ticket_close` | owner OR admin | Inngest worker |
| `ticket_analysis_rescore` | owner OR admin | Inngest `agent-todo-execute` worker (`isInngestExecutable()`) |

The TS union lives in `src/lib/agent-todos/constants.ts`; `canApprove()` is the role gate. `ticket_analysis_rescore` is now executed by the **Inngest worker on approval** (moved out of the deleted routine — the approve route `src/app/api/todos/[id]/approve/route.ts` fires `agent-todo/execute` for it via `isInngestExecutable()`); it does NOT auto-close the ticket (no customer-facing todo in the group).

### Retired system-level types

`sonnet_prompt_new｜sonnet_prompt_edit｜grader_prompt_edit｜escalation_rule_fix｜brain_doc_edit｜code_change` are **no longer `agent_todos`** ([[../specs/box-escalation-triage]]). They are now:
- rule / grader changes → **proposed [[sonnet_prompts]]** (`status='proposed'`, `derived_from_ticket_id`), admin/Zach-approvable.
- code / analyzer / brain / escalation-rule fixes → **committed `docs/brain/specs/{slug}.md`** (owner=cs, `**Derived-from-ticket:**`), surfaced on [[../dashboard/roadmap]] to commission a build.

The DB CHECK that tightens `action_type` to the four kept values was added **`NOT VALID`** (`supabase/migrations/20260620160100_agent_todos_prune_action_types.sql`) — so historical rows carrying retired types **survive as audit** (only new inserts are constrained).

## Indexes

- `agent_todos_ws_status_created_idx` `(workspace_id, status, created_at desc)` — list-view paging.
- `agent_todos_source_ticket_idx` `(source_ticket_id)` — linked-todos block + active-group guard.
- `agent_todos_group_idx` `(group_id)` — group expansion.

## RLS

- `agent_todos_select` — workspace members read their workspace rows.
- `agent_todos_service` — service role full access (all writes).

## Gotchas

- **One active group per ticket.** The triage sweep (`selectEscalatedForTriage`) skips any ticket with a `pending`/`approved`/`executed` row. Don't insert a second group manually.
- **Drift.** The Inngest worker re-checks `pre_exec_context.latest_inbound_message_id` against live state. If the customer replied after the snapshot, the todo goes `superseded`, not `executed`.
- **`customer_action.payload`** is `{ actions: ActionParams[], diff_summary }` using the orchestrator's own action vocabulary (`remove_item`, `partial_refund`, `create_return`, `pause_timed`, …) — dispatched through `directActionHandlers` in [[../libraries/action-executor]].

## Migration

`supabase/migrations/20260604190000_agent_todos.sql` + `20260620160100_agent_todos_prune_action_types.sql` (NOT-VALID CHECK pruning `action_type` to the four kept types)

## Related

[[tickets]] · [[ticket_messages]] · [[ticket_analyses]] · [[sonnet_prompts]] · [[triage_runs]] · [[../inngest/triage-escalations]] · [[../inngest/agent-todo-routine]] · [[../specs/box-escalation-triage]] · [[../dashboard/tickets__todos]] · [[../dashboard/tickets__todos__id]] · [[../dashboard/tickets__escalated]] · [[../dashboard/branches]] · [[../lifecycles/agent-todo-system]]
