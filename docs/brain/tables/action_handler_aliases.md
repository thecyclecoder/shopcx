# action_handler_aliases

The **handler-alias catalog** the orchestrator's action executor consults before it falls through to its silent "Unknown action type" branch. Maps a Sonnet-emitted action type (e.g. `cancel_subscription`) to the canonical handler key registered in [[../libraries/action-executor]] `directActionHandlers` (e.g. `cancel`), so near-miss emissions hit real handlers instead of being dropped. Phase 1 of [[../specs/orchestrator-handler-alias-catalog-for-no-handler-misses]] — M3 "Right-cost routing" of [[../goals/guaranteed-ticket-handling]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | ✓ | → [[workspaces]].id · ON DELETE CASCADE · **null = GLOBAL** (applies to every workspace) |
| `source_type` | `text` | — | what Sonnet emitted (e.g. `cancel_subscription`) |
| `target_type` | `text` | — | the canonical handler key it should map to (e.g. `cancel`) |
| `active` | `boolean` | — | default `true` · soft-disable a mapping without deleting it (used for shadow-observation before flipping any default) |
| `created_at` | `timestamptz` | — | default `now()` |

**Indexes:**
- `action_handler_aliases_global_uidx` — partial unique on `(source_type)` where `workspace_id is null` (one global row per source_type)
- `action_handler_aliases_workspace_uidx` — partial unique on `(workspace_id, source_type)` where `workspace_id is not null` (one workspace override per source_type)
- `action_handler_aliases_lookup_idx` — `(source_type, workspace_id, active)` for the executor's hot resolveAlias lookup

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id (nullable).

## Global seeds

Seeded in the same migration — the most common misses observable in production before the catalog existed:

| source_type | target_type |
|---|---|
| `cancel_subscription` | `cancel` |
| `refund_partial` | `partial_refund` |
| `pause_subscription` | `pause` |
| `resume_subscription` | `resume` |

## Resolution rules

Implemented by [[../libraries/action-handler-aliases]] `pickAliasTarget`:

1. Only rows with `active=true` count. An inactive row is treated as though it does not exist — that is how a workspace **disables** an inherited global mapping without deleting the shared row.
2. A workspace-scoped row (`workspace_id = ctx.workspaceId`) wins over a matching global row (`workspace_id is null`). That is how a workspace **overrides** a global to a different target.
3. If neither a workspace nor a global row matches, the resolver returns `null` and the caller falls through to its pre-existing `Unknown action type` branch — so a resolver miss is never worse than the pre-catalog behavior.

## Invariants

- **`workspace_id is null` is the global row.** Two partial-unique indexes enforce one-global-per-source-type and one-workspace-override-per-source-type without letting Postgres' distinct-null semantics duplicate the row.
- **Alias resolution is one-shot.** The executor consults the catalog exactly once per action; a chained alias (`A → B → C`) is intentionally not supported — every hop is a chance for a routing mistake.
- **On a hit the executor writes a sysNote** `alias resolved: {source}→{target}` so the mapping is auditable per ticket.

## RLS
Workspace-member SELECT (including the null-workspace globals), service-role write.

## Callers

- [[../libraries/action-executor]] — reads via [[../libraries/action-handler-aliases]] `resolveAlias` on every handler miss before falling through to `Unknown action type` (both call sites: `executeActionsInline` and `handleDirectAction`).

---

[[../README]] · [[../libraries/action-executor]] · [[../libraries/action-handler-aliases]] · [[../specs/orchestrator-handler-alias-catalog-for-no-handler-misses]] · [[../goals/guaranteed-ticket-handling]] · [[../../CLAUDE]]
