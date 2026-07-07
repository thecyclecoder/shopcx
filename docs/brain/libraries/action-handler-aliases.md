# libraries/action-handler-aliases

Reads the [[../tables/action_handler_aliases]] catalog and maps a Sonnet-emitted action type to the canonical handler key registered in [[action-executor]] `directActionHandlers`, so near-miss emissions like `cancel_subscription` → `cancel` hit real handlers instead of the executor's silent "Unknown action type" branch. Phase 1 of [[../specs/orchestrator-handler-alias-catalog-for-no-handler-misses]].

**File:** `src/lib/action-handler-aliases.ts`

## Exports

### `pickAliasTarget` — function

```ts
function pickAliasTarget(aliases: AliasRow[], workspaceId: string, sourceType: string) : string | null
```

Pure picker over an in-memory alias list. Only `active=true` rows count; a workspace-scoped row wins over a matching global (`workspace_id is null`) row. Extracted so the resolver logic can be tested without a DB — covered by `src/lib/action-executor.aliases.test.ts`.

### `resolveAlias` — function

```ts
async function resolveAlias(admin: Admin, workspaceId: string, sourceType: string) : Promise<string | null>
```

DB-backed resolver used by [[action-executor]]. Reads the workspace-scoped + global candidates in one query and delegates to `pickAliasTarget` for the win rule. DB errors are swallowed to `null` — a resolver miss lands the caller on its pre-existing "Unknown action type" branch, so a transient Postgres blip can never make the executor worse than it was before this catalog existed.

### `AliasRow` — interface

## Callers

- [[action-executor]] — `executeActionsInline` and `handleDirectAction` both wrap the `directActionHandlers[action.type]` lookup with `resolveAlias(ctx.admin, ctx.workspaceId, action.type)` on a miss; on an alias hit the caller writes a sysNote `alias resolved: {source}→{target}` for per-ticket observability, rewrites the action's `type` to the canonical handler key, and fires the handler as normal.

## Gotchas

- **Alias resolution is one-shot.** The resolver returns a single hop; it does not recurse. A catalog like `A → B → C` would not chain — the executor consults the catalog once per action, and every hop is a chance for a routing mistake.
- **Global vs. workspace precedence** is enforced by `pickAliasTarget`, not by SQL ordering — the DB query returns both candidates and the picker chooses. So a workspace-scoped INACTIVE row is a valid way to disable an inherited global mapping (see [[../tables/action_handler_aliases]] resolution rules).

---

[[../README]] · [[action-executor]] · [[../tables/action_handler_aliases]] · [[../specs/orchestrator-handler-alias-catalog-for-no-handler-misses]] · [[../../CLAUDE]]
