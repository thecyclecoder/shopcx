# libraries/meta/app-owner-action-escalation

The CEO-facing surface for a Meta capability that requires the workspace OWNER
to clear a gate in the Meta App Dashboard. Companion to [[meta__graph-retry]]
`classifyAppOwnerActionRequired` — when Graph classifies a response as
app-owner-action-required (a Meta-side gate a human must clear), this SDK raises
a deduped `dashboard_notifications` card that names the CALLING FUNCTION and
links to the Meta App Dashboard so the owner can act.

**Motivation:** the 5-min today-sync cron was logging the yearly "Data Use Checkup"
error as `console.error` per active ad account per tick (~576/day), flooding the
Control Tower error feed with identical entries that carried no additional
information beyond the first occurrence. The only fix is a human logging into the
Meta App Dashboard, so the correct pattern is one deduped CEO card per workspace
per day, not a recurring error. This SDK turns "the 5-min cron logs an identical
HTTP 400 error every tick per active ad account (~576/day)" into "one deduped CEO
card per workspace per UTC day naming the action required and where to take it".

**File:** `src/lib/meta/app-owner-action-escalation.ts`

## Exports

### `escalateAppOwnerActionRequired` — function

```ts
async function escalateAppOwnerActionRequired(
  admin: Admin,
  input: {
    workspaceId: string;
    label: string;                   // the graphFetchJson label, e.g. "GET act_9999/insights"
    status: number;                  // HTTP status (typically 400)
    error: GraphError;               // the tagged throw carrying metaClass='app_owner_action_required'
    affectedAdAccountIds?: string[]; // optional list of blocked ad account IDs
    nowMs?: number;                  // tests pin this so the dedupe day is deterministic
  },
): Promise<{ emitted: boolean }>
```
Raises the CEO card. Idempotent per (workspace, UTC day) — confirming predicate
is `metadata->>dedupe_key`, and we insert only after the SELECT returns zero
rows. Returns `{emitted:false}` on a same-day duplicate or a DB write failure
(write failures are logged, never rethrown — an escalation SDK that CAN throw
would drop the caller into a nested error path just as the CEO card was supposed
to make things easier).

### `runWithAppOwnerActionWorkspaceScope` — scoped helper

```ts
export function runWithAppOwnerActionWorkspaceScope<T>(
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T>
```

Bind the app-owner-action workspace scope to `workspaceId` for the duration of
`fn` (and every awaited continuation reachable from it, transitively). The scope
is held in an [[https://nodejs.org/docs/latest/api/async_context.html|AsyncLocalStorage]]
store, NOT a process-global mutable variable. Nested calls shadow the outer
scope; two concurrent publishes for different workspaces each see only their own.
**MUST wrap every await that could raise a Meta `app_owner_action_required`
error** — the retired `setCurrentAppOwnerActionWorkspaceScope` module-global was
a race: publish A sets scope=A, publish B sets scope=B, publish A's Graph call
fires, handler reads B — the card books against the wrong workspace. AsyncLocalStorage
binds the scope to the async chain, not the module, closing that race. Callers:
[[../inngest/today-sync]] (wraps the Meta-account loop), [[../inngest/media-buyer-test-cadence]]
(wraps each `pullOneCadenceTarget`).

### `installDefaultAppOwnerActionEscalationHandler` wire

`installDefaultAppOwnerActionEscalationHandler(admin)` installs a handler on
[[meta__graph-retry]] that fires the CEO card automatically when an
app-owner-action-required error is thrown AND a workspace scope is set via
`runWithAppOwnerActionWorkspaceScope(workspaceId, fn)`. The handler consults
the scope from the SAME async chain that made the Graph call; two overlapping
publishes for different workspaces each see their own scope — no cross-workspace
card leak.

## Dedupe key shape

`app_owner_action_required:<workspaceId>:<yyyy-mm-dd>` — one card per workspace
per UTC day. Same-day occurrences collapse to the same card; a new day produces
a fresh card (so a persistent gate — e.g., a workspace that never clears its
Data Use Checkup — surfaces once per day, not once per retry).

## Gotchas

- **AsyncLocalStorage scope binding is mandatory for isolation.** [[fix-ad-tool-app-owner-action-scope-isolation]]
  Phase 1 (2026-08-01) replaced the module-global `setCurrentAppOwnerActionWorkspaceScope(workspaceId) + finally cleanup`
  pattern with `runWithAppOwnerActionWorkspaceScope(workspaceId, fn)`, which binds the scope to the async chain, not the
  module. The old pattern was a race: publish A sets scope=A, publish B sets scope=B, A's Graph call fires and handler
  reads B — the card books against the wrong workspace. Every caller that fires a Graph call that could raise
  `app_owner_action_required` MUST wrap it via `runWithAppOwnerActionWorkspaceScope`; a naked Graph call sees no scope
  and the handler is a no-op (the throw still carries `metaClass` so the caller can escalate explicitly if needed).
- **Dedupe is per (workspace, UTC day).** A persistent gate (e.g., an uncleared
  Data Use Checkup) surfaces once per day per workspace, not once per retry.
  But this is intentional: a workspace owner who clears the gate on Tuesday will
  see it again on Wednesday if their refresh doesn't stick, and that's a signal.
- **Write failures are silent.** The insert is wrapped in a try/catch that logs
  and returns `{emitted:false}`. Never rethrows — a broken CEO card must not
  mask the underlying app-owner-action-required throw.
- **Message is truncated.** `title` at 200 chars, `body` at 4000 chars,
  `meta_message` metadata at 2000 chars — the standard `dashboard_notifications`
  budget.
- **`link` deep-links to `https://developers.facebook.com/apps/`** — the CEO's
  next step is navigating to their Meta app and completing the flagged action
  (typically the Data Use Checkup).
- **Affected ad accounts are surfaced.** `affectedAdAccountIds` is optional; when
  provided, the card body names the specific accounts blocked so the CEO knows
  which ones to clear.

## Callers

- [[../inngest/today-sync]] — installs the handler; wraps the Meta-account loop
  in `runWithAppOwnerActionWorkspaceScope(conn.workspace_id, async () => {...})` so
  a Data Use Checkup 400 raises at most one card per workspace per day instead of
  flooding the error feed.
- [[../inngest/media-buyer-test-cadence]] — wraps each `pullOneCadenceTarget` call
  in `runWithAppOwnerActionWorkspaceScope(t.workspaceId, async () => {...})` so
  each workspace's cadence run surfaces its own escalations.
- [[../inngest/media-buyer-all-customers-refresh]] — installs the handler; wraps
  each per-group (workspace, audience) refresh in `runWithAppOwnerActionWorkspaceScope(g.workspaceId, async () => {...})`
  so a Data Use Checkup 400 surfaces one deduped card per workspace and other workspaces' refreshes continue.
- [[../inngest/ad-tool]] `ad-tool-publish-to-meta` — installs the handler; wraps
  the entire publish flow in `runWithAppOwnerActionWorkspaceScope(workspace_id, async () => {...})`
  so a Data Use Checkup 400 from any Graph call (uploadAdVideo, createAdCreative, createAd, etc.)
  surfaces one deduped CEO card scoped to THIS invocation's workspace. When a catch sees
  `metaClass === 'app_owner_action_required'`, the publisher fails the job gracefully with reason
  `meta_app_owner_action_required`, clears `publish_active`, and returns normally (no rethrow).
- [[../inngest/meta-performance]] `meta-iteration-run` (Phase 5) — calls
  `escalateAppOwnerActionRequired` directly from the catch block with
  `workspaceId` from `event.data.workspace_id` (explicit argument, not a scope).
  When an ingest/decision/attribution stage throws `app_owner_action_required`
  (e.g., Data Use Checkup), the run catches it, escalates one deduped CEO card
  scoped to THIS invocation's workspace, records the run as human-blocked via
  `finishRun()`, and returns without rethrow. Two overlapping runs for different
  workspaces each see only their own workspace_id, with no cross-contamination
  risk from module-global state or shared async scope.

## Tests

- `src/lib/meta/app-owner-action-escalation.workspace-scope.test.ts` — registered
  as `test:app-owner-action-escalation-workspace-scope`. Proves two overlapping
  app-owner-action scopes for different workspace IDs stay isolated when the
  escalation handler fires from an interleaved async chain.

## Related

[[meta__graph-retry]] · [[../tables/dashboard_notifications]] ·
[[../inngest/today-sync]] · [[../functions/platform]]

---

[[../README]] · [[../../CLAUDE]]
