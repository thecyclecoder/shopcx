# libraries/proposed-action-aliases

The Phase-2 recorder + Haiku suggester behind [[../tables/proposed_action_aliases]]. Called by [[action-executor]] on every "Unknown action type" silent-miss; upserts a `(workspace, source_type)` queue row, bumps `occurrences`, and — once occurrences reach 3 — asks Haiku to propose a canonical handler key from the passed-in `directActionHandlers` list.

**File:** `src/lib/proposed-action-aliases.ts`

## Exports

### `recordUnknownActionType` — function

```ts
async function recordUnknownActionType(args: RecordArgs) : Promise<void>
```

Fire-and-forget upsert of the queue row. Any error is swallowed — the caller is already about to surface an `Unknown action type` failure to the customer; this recording is telemetry only and must not change customer-facing behavior. Guarded so a declined/approved row is never re-prompted or overwritten (`.eq("status", "pending").is("suggested_target", null)` on the suggestion write).

### `suggestTargetHandler` — function

```ts
async function suggestTargetHandler(sourceType: string, handlerKeys: string[]) : Promise<Suggestion | null>
```

Ask Haiku (`claude-haiku-4-5-20251001`) to pick the best-matching canonical handler key. Returns null on any error or on a `no_match` sentinel; also returns null when `ANTHROPIC_API_KEY` is unset so a spec-test / CI run without a key resolves cleanly.

### `buildSuggestPrompt` / `parseSuggestion` — functions

Exposed for unit tests. `parseSuggestion` rejects any target that is not in the passed-in `handlerKeys` list — an out-of-set match would silently teach the executor to route to a non-existent handler, which is exactly the bug this queue exists to catch.

### `RecordArgs` — interface

## Callers

- [[action-executor]] — `executeActionsInline` and `handleDirectAction` both call `recordUnknownActionType` on the silent-miss branch (before falling through to the `Unknown action type` result). The passed-in `handlerKeys` are `Object.keys(directActionHandlers)` — sourced live at call time so a newly-added handler is proposed by name on the very next miss.

## Gotchas

- **The Haiku call runs on the hot request path**, not a background cron. Latency is bounded by `max_tokens: 200` and a single-shot request; the caller wraps the whole recording in try/catch so a slow Anthropic API can never surface to the customer.
- **`declined` is a soft-stop, not a delete.** A declined row keeps counting occurrences (for observability) but skips the suggestion path. Do NOT re-prompt on a declined row — an admin decided that source_type is not a valid alias candidate and re-suggesting would spam their queue.
- **The workspace_id filter isn't optional.** `recordUnknownActionType` scopes every read + write with `.eq("workspace_id", workspaceId)` so a concurrent hit in a different workspace cannot be touched by this update.

---

[[../README]] · [[action-executor]] · [[action-handler-aliases]] · [[../tables/proposed_action_aliases]] · [[../specs/orchestrator-handler-alias-catalog-for-no-handler-misses]] · [[../../CLAUDE]]
