# inngest/meta-sync

Per-workspace Meta Page + Instagram sync — refreshes `meta_pages` and ad metadata.

**File:** `src/lib/inngest/meta-sync.ts`

## Functions

### `meta-sync-spend`
- **Trigger:** event `meta/sync-spend`
- **Retries:** 2
- **Concurrency:** `concurrency: [{ limit: 2, key: "event.data.ad_account_id" }]`


### `meta-daily-sync`
- **Trigger:** cron `0 11 * * *`
- **Retries:** 1


## Exports

### `META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED` — constant

```ts
const META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED = "meta_sync_spend_app_owner_action_required" as const
```

Stable human-blocked fingerprint returned when Meta's Data Use Checkup gate fires (graph-retry tags `metaClass = 'app_owner_action_required'`). Retrying can never clear this class — only a human completing the checkup in the Meta App Dashboard can — so we contain the error as a stable result instead of letting it flood the Inngest failure feed.

### `classifyMetaSyncSpendError` — function

```ts
function classifyMetaSyncSpendError(
  err: unknown,
  scope: { workspaceId: string; adAccountId: string; metaAccountId: string }
): { status: "meta_sync_spend_app_owner_action_required"; workspaceId: string; adAccountId: string; metaAccountId: string } | null
```

Narrow error-branch classifier. Returns the stable human-blocked result when the thrown error carries `metaClass='app_owner_action_required'`; returns null for anything else so the caller rethrows.

### `handleMetaSyncSpendError` — function

```ts
async function handleMetaSyncSpendError(
  admin: Admin,
  err: unknown,
  scope: { workspaceId: string; adAccountId: string; metaAccountId: string },
  escalate?: typeof escalateAppOwnerActionRequired
): Promise<{ status: "meta_sync_spend_app_owner_action_required"; workspaceId: string; adAccountId: string; metaAccountId: string }>
```

Handle a metaSyncSpend throw: if it's the app-owner-action-required class, explicitly book the deduped CEO card against THIS invocation's `workspaceId` (never a module-global scope, so two overlapping `meta/sync-spend` runs from different workspaces cannot cross-contaminate each other's service-role notification writes) and return the stable human-blocked result. Any other error is rethrown.

Exported so the workspace-isolation invariant is unit-testable without spinning up the Inngest handler.

## Downstream events sent

_None._

## Tables written

_None._

## Tables read (not written)

- [[../tables/meta_ad_accounts]]
- [[../tables/meta_connections]]

## Gotchas

- **App-owner-action-required errors use invocation-local scope.** The `metaSyncSpend` handler catches `metaClass='app_owner_action_required'` (Data Use Checkup) and calls `escalateAppOwnerActionRequired(admin, {...workspaceId: THIS invocation's workspace_id...})` explicitly. Never rely on `setCurrentAppOwnerActionWorkspaceScope` — that pattern is module-global and unsafe for overlapping invocations. The isolation invariant is unit-tested in `meta-sync.test.ts` with two overlapping workspace invocations.

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
