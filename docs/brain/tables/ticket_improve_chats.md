# ticket_improve_chats

The DB-backed home for the **box-hosted ticket Improve agent** ([[../specs/box-ticket-improve]]). The ticket detail "Improve" tab ([[../dashboard]] `tickets/[id]/page.tsx`) is a **ticket-bound, resumable Max session**: one row per ticket. Opening the tab loads-or-creates the ticket's session; each user turn spawns a short-lived `kind='ticket-improve'` [[agent_jobs]] row that resumes the box's `claude -p` Max session ([[box_session_id]]) to investigate read-only and either reply or **propose an approval-gated action plan**. The markdown transcript here is the human-readable mirror + cross-device resume; the proposed plan is parked in `pending_plan` until the founder / CX manager approves it. Sibling of [[roadmap_chats]] (shares the session primitive with [[../specs/box-spec-chat]]). **One row per ticket.**

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` · the job's `spec_slug` (the session subject) |
| `workspace_id` | `uuid` | → [[workspaces]].id · ON DELETE CASCADE |
| `user_id` | `uuid?` | who opened the session (founder or CX manager) |
| `ticket_id` | `uuid` | → [[tickets]].id · ON DELETE CASCADE · the ticket this session is permanently bound to (auto ticket-binding — the human never states which ticket) |
| `box_session_id` | `text?` | the box `claude -p` session id · turn 1 starts fresh, later turns `claude --resume <box_session_id>` |
| `messages` | `jsonb` | the `[{role,content}]` transcript (mirror of the box session) · default `[]` |
| `turn_status` | `text` | `idle｜thinking｜error｜awaiting_approval` · default `idle` |
| `pending_plan` | `jsonb?` | the typed action plan the box proposed (`{summary, actions[]}`), awaiting approval |
| `last_error` | `text?` | surfaced in the UI on an `error` turn (retry by sending again) |
| `status` | `text` | `active｜resolved` · default `active` (flips `resolved` once a plan's closeout closes the ticket) |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` bumped every write |

## `turn_status` enum

`idle` (ready) → `thinking` (a box turn is in flight; the UI polls) → `idle` (reply landed) **or** `awaiting_approval` (a plan is parked in `pending_plan`) **or** `error` (`last_error` set; sending again retries). Approving/declining the plan returns to `idle`.

## `pending_plan` shape

`{ summary, actions: ImprovePlanAction[] }`. Each action has a `kind` ∈ `customer_action｜sonnet_prompt｜grader_rule｜rescore｜ticket_spec｜resolve_sequence` plus the matching payload (`action｜prompt｜rule｜spec｜resolve`), an `id`, a `label`, and a `status` (`pending｜approved｜declined｜done｜failed`). See [[../libraries/ticket-improve-chats]] + [[../libraries/improve-plan-executor]].

## Indexes / RLS

- `ticket_improve_chats_ticket_idx (ticket_id)` **UNIQUE** — load-or-create keys off this (one session per ticket) · `ticket_improve_chats_ws_idx (workspace_id, updated_at desc)`.
- RLS: `ticket_improve_chats_select` (workspace members read) · `ticket_improve_chats_service` (service role all writes). The route + worker write via `createAdminClient()` / the worker's service-role client.

## Reads/writes

- `src/lib/ticket-improve-chats.ts` ([[../libraries/ticket-improve-chats]]) — `loadOrCreateSession`, `loadSession`, `patchSession` + the shared plan types.
- `src/app/api/tickets/[id]/improve/route.ts` — `POST {action:'send'}` (append + enqueue a turn) / `POST {action:'execute'}` (run the approved plan via [[../libraries/improve-plan-executor]]) / `GET` (poll the session).
- `scripts/builder-worker.ts` → `runTicketImproveJob` — claims the `ticket-improve` job, runs the box turn, writes `box_session_id` + the assistant message + `turn_status`/`pending_plan`.

## Gotchas

- **Ticket-bound, one per ticket.** Pivoting to a different ticket = opening Improve on *that* ticket (its own row). The UNIQUE `ticket_id` index enforces it.
- **The box never mutates.** It only proposes; execution runs server-side in the route (which holds prod creds), gated by explicit human approval — the [[../operational-rules]] § North star supervision boundary.
- **Sending a new message while a plan is parked drops the plan** (a pivot/redirect) — the route clears `pending_plan` and enqueues a fresh turn.
