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
| `seen_at` | `timestamptz?` | per-session **read marker** for the Improve Queue ([[../specs/improve-queue-mark-read]]) · null = never read · "Mark read" sets it to the row's current `updated_at`; a later box turn bumps `updated_at` past it → re-surfaces as unread |
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

## Improve Queue surface

A workspace-scoped, read-only view of this table powers the **Improve Queue** ([[../dashboard/tickets__improve]], `GET /api/tickets/improve-queue`): the founder / CX manager fire off several box Improve turns, walk away, and glance at which the box has answered. The route reads active rows (`status='active'`) joined to `tickets.subject` + `customers` (name), ordered `updated_at desc`, and derives a `queue_state`:

- `awaiting_approval` → **Needs approval** · `error` → **Error** · `idle` **+ last `messages` entry is the assistant's** → **Answered** (these three are the "waiting" states).
- `thinking` → **Thinking…** ("In progress").
- `idle` with no assistant-last message → not surfaced.

**Read/unread ([[../specs/improve-queue-mark-read]]):** each waiting row also carries `unread = seen_at IS NULL OR updated_at > seen_at` (the box answered since you last looked). The nav badge `counts.waiting` counts **unread** waiting rows only. Unread rows show under **"Waiting on you"** (each with a **Mark read** button → `POST /api/tickets/improve-queue/seen {ticket_id}`, which sets `seen_at = updated_at`); read-but-still-waiting rows drop to a collapsible **"Earlier"** group (greyed, never lost) until the next box turn bumps `updated_at` past `seen_at` and re-surfaces them. Opening the ticket's Improve tab **auto-marks read** (the tab POSTs `…/seen` on load + when a fresh reply lands while you watch). Reading ≠ approving: a still-parked `pending_plan` keeps its **Needs approval** chip even once read.

The queue only *surfaces + links* (deep-link to the ticket's Improve tab); you still Approve / reply on the ticket. See [[../specs/improve-queue]] + [[../specs/improve-queue-mark-read]].

## Gotchas

- **Ticket-bound, one per ticket.** Pivoting to a different ticket = opening Improve on *that* ticket (its own row). The UNIQUE `ticket_id` index enforces it.
- **The box never mutates.** It only proposes; execution runs server-side in the route (which holds prod creds), gated by explicit human approval — the [[../operational-rules]] § North star supervision boundary.
- **Sending a new message while a plan is parked drops the plan** (a pivot/redirect) — the route clears `pending_plan` and enqueues a fresh turn.
