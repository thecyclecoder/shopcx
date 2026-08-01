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

### `installDefaultAppOwnerActionEscalationHandler` wire

`installDefaultAppOwnerActionEscalationHandler(admin)` installs a handler on
[[meta__graph-retry]] that fires the CEO card automatically when an
app-owner-action-required error is thrown AND a workspace scope is set via
`setCurrentAppOwnerActionWorkspaceScope(workspaceId)`. The scope is a module-level
slot because `graphFetchJson` doesn't know which workspace it's serving; a caller
(typically an Inngest function like [[../inngest/today-sync]]) sets the scope at
its own boundary and clears it at exit.

## Dedupe key shape

`app_owner_action_required:<workspaceId>:<yyyy-mm-dd>` — one card per workspace
per UTC day. Same-day occurrences collapse to the same card; a new day produces
a fresh card (so a persistent gate — e.g., a workspace that never clears its
Data Use Checkup — surfaces once per day, not once per retry).

## Gotchas

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

- [[../inngest/today-sync]] — installs the handler and sets the workspace scope
  before the Meta-account loop runs, so a Data Use Checkup 400 raises at most
  one card per workspace per day instead of flooding the error feed.

## Related

[[meta__graph-retry]] · [[../tables/dashboard_notifications]] ·
[[../inngest/today-sync]] · [[../functions/platform]]

---

[[../README]] · [[../../CLAUDE]]
