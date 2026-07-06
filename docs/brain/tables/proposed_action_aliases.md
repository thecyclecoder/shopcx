# proposed_action_aliases

The **review queue** for Sonnet-emitted action types that missed every registered handler AND the [[action_handler_aliases]] catalog — Phase 2 of [[../specs/orchestrator-handler-alias-catalog-for-no-handler-misses]]. Written by [[../libraries/action-executor]] on every silent-miss hit (via [[../libraries/proposed-action-aliases]] `recordUnknownActionType`); reviewed by an admin on `/dashboard/settings/ai/handler-aliases`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `source_type` | `text` | — | the Sonnet-emitted action_type that missed |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id · ON DELETE SET NULL · most-recent example |
| `occurrences` | `int` | — | default 1 · bumps on every subsequent hit |
| `first_seen` / `last_seen` | `timestamptz` | — | default `now()` |
| `suggested_target` | `text` | ✓ | populated by the Phase-2 Haiku call once `occurrences >= 3` |
| `suggested_at` | `timestamptz` | ✓ | |
| `suggested_model` | `text` | ✓ | e.g. `claude-haiku-4-5-20251001` |
| `suggested_reasoning` | `text` | ✓ | one short sentence from Haiku |
| `status` | `text` | — | default `pending` · CHECK ∈ `pending` \| `approved` \| `declined` |
| `reviewed_at` / `reviewed_by` | `timestamptz` / `uuid` | ✓ | `reviewed_by` → `auth.users`.id · ON DELETE SET NULL |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(workspace_id, source_type)` — one row per (workspace, source_type). The executor upserts on it.

**Indexes:**
- `(workspace_id, status, last_seen desc)` — the admin queue lookup
- `(last_seen desc)` — the shadow-harness top-N over the last 30 days

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `ticket_id` → [[tickets]].id · `reviewed_by` → `auth.users`.id.

## Invariants

- **`pending` gates the Sonnet call.** Once a row is `approved` or `declined`, `recordUnknownActionType` skips the Haiku suggestion path — an already-decided proposal must not be re-prompted or overwritten. The write is compare-and-set: `.eq("status", "pending").is("suggested_target", null)` so two concurrent hits crossing the threshold cannot race a suggestion in twice.
- **`declined` still counts.** A declined row keeps bumping `occurrences` on further hits (for observability) but never gets a fresh suggestion. The executor still records the miss.
- **Approve → dual write.** The `/api/workspaces/[id]/handler-aliases/[proposalId]` PATCH route inserts a workspace-scoped [[action_handler_aliases]] row (upsert on the partial-unique `(workspace_id, source_type)`) AND flips the proposal row to `approved` (compare-and-set on `status='pending'`), so a stale approve from a background tab cannot re-open a declined row.
- **`suggested_target` is never trusted blindly.** The Haiku parser rejects any target that is not in the passed-in `directActionHandlers` key set; an out-of-set match would silently teach the executor to route to a non-existent handler, which is exactly the bug this queue exists to catch.

## RLS
Workspace-member SELECT (an admin only sees their own workspace's queue), service-role write. Approve/decline route additionally checks `owner`/`admin` role before mutating.

## Callers

- [[../libraries/action-executor]] — via [[../libraries/proposed-action-aliases]] `recordUnknownActionType` on the silent-miss branch of both `executeActionsInline` and `handleDirectAction`.
- `src/app/api/workspaces/[id]/handler-aliases/route.ts` — GET (list queue + active catalog).
- `src/app/api/workspaces/[id]/handler-aliases/[proposalId]/route.ts` — PATCH (approve/decline).
- `src/app/dashboard/settings/ai/handler-aliases/page.tsx` — admin queue UI.
- `scripts/_shadow-handler-aliases.ts` — read-only top-N shadow report over the last 30 days (also scans historical `ticket_messages` sysNotes so pre-Phase-2 hits still surface).

---

[[../README]] · [[action_handler_aliases]] · [[../libraries/action-executor]] · [[../libraries/proposed-action-aliases]] · [[../specs/orchestrator-handler-alias-catalog-for-no-handler-misses]] · [[../goals/guaranteed-ticket-handling]] · [[../../CLAUDE]]
