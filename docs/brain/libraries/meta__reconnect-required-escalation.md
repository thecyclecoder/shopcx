# libraries/meta/reconnect-required-escalation

The CEO-facing surface for a Meta `reconnect_required` classification — the
sibling of [[meta__app-owner-action-escalation]] for the SECOND human-blocked
Meta class. Companion to [[meta__graph-retry]] `classifyReconnectRequired`:
when Graph tags a response as `reconnect_required`, this SDK confirms the
stored per-workspace user token is dead via a `debug_token` probe and only
then raises a deduped `dashboard_notifications` card pointing at the in-app
integrations page — never the Meta App Dashboard, which is the WRONG remedy
for this class.

**Motivation — the 2026-08-02 Meta incident.** After the CEO completed the
Data Use Checkup, Meta switched to a SECOND, undocumented phrasing —
HTTP 400 `"API access blocked."` — on every call made with the stored USER
token, while the APP token (`{app_id}|{secret}`) still returned 200 and
webhook subscriptions stayed active. That user-token-dead / app-token-live
asymmetry is the whole diagnostic: nothing was left to fix in the App
Dashboard; the stored user token had been invalidated by the lapsed checkup
and only OAuth re-consent restored access. Raising the sibling
`app_owner_action_required` card for THIS state sent the founder down the
wrong remedy path (App Dashboard has nothing to do) while spend continued
unmeasured. This SDK is that split.

**File:** `src/lib/meta/reconnect-required-escalation.ts`

## Exports

### `escalateReconnectRequired` — function

```ts
async function escalateReconnectRequired(
  admin: Admin,
  input: {
    workspaceId: string;
    label: string;                   // graphFetchJson label, e.g. "GET act_9999/insights"
    status: number;                  // HTTP status (typically 400)
    error: GraphError;               // the tagged throw carrying metaClass='reconnect_required'
    affectedAdAccountIds?: string[]; // optional list of blocked ad account IDs
    nowMs?: number;                  // tests pin this so the dedupe day is deterministic
    probeDebugToken?: DebugTokenProbe; // DI hook for tests; defaults to the real Meta probe
  },
): Promise<{ emitted: boolean }>
```

Raises the CEO card ONLY when the stored user token is CONFIRMED invalid.
Returns `{emitted:false}` on any of:
- the debug_token probe was unreachable (fail-closed on unreliable probe),
- the probe reported the token VALID (the string trigger was a false positive),
- the prior-card lookup found today's row (dedupe hit),
- or the insert failed (logged, never rethrown).

### `defaultProbeDebugToken` — const

```ts
export const defaultProbeDebugToken: DebugTokenProbe;
```

The production probe. Reads `workspaces.meta_user_access_token_encrypted`,
decrypts via [[crypto]] `decrypt`, and calls
`GET https://graph.facebook.com/v21.0/debug_token?input_token={t}&access_token={app_id}|{app_secret}`
using the APP token (which keeps working in the reconnect_required state — that
asymmetry is the diagnostic). Reads `META_APP_ID`/`META_APP_SECRET` from
process env. Returns `{reachable:false}` on any network / decode / config
failure so the caller fails closed (no card on an unreliable probe).

### `runWithReconnectRequiredWorkspaceScope` — scoped helper

```ts
export function runWithReconnectRequiredWorkspaceScope<T>(
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T>
```

Bind the reconnect-required workspace scope to `workspaceId` for the duration
of `fn` (and every awaited continuation reachable from it, transitively). The
scope is held in an
[[https://nodejs.org/docs/latest/api/async_context.html|AsyncLocalStorage]]
store — SAME non-racy pattern as
[[meta__app-owner-action-escalation]] `runWithAppOwnerActionWorkspaceScope`;
two overlapping publishes for different workspaces each see only their own.
**MUST wrap every await that could raise a Meta `reconnect_required` error**
— a naked Graph call sees no scope and the handler is a no-op (the throw
still carries `metaClass='reconnect_required'` so the caller can escalate
explicitly if needed).

### `installDefaultReconnectRequiredEscalationHandler` — wire

`installDefaultReconnectRequiredEscalationHandler(admin)` installs a handler
on [[meta__graph-retry]] via `registerReconnectRequiredHandler` that fires
this SDK automatically when a reconnect_required error is thrown AND a
workspace scope is set via `runWithReconnectRequiredWorkspaceScope(workspaceId, fn)`.
The handler consults the scope from the SAME async chain that made the
Graph call.

## Dedupe key shape

`reconnect_required:<workspaceId>:<yyyy-mm-dd>` — one card per workspace per
UTC day. Same-day occurrences collapse to the same card. Distinct key
namespace from the app-owner sibling so the two classes' cards never collide
per workspace-day.

## Card copy — routes to reconnection, not the App Dashboard

- **Title:** "Meta connection needs to be re-authorized — ad spend running unmeasured"
- **Link:** `/dashboard/settings/integrations/meta` (in-product; never the Meta App Dashboard)
- **Body must state:**
  - Meta invalidated the stored access token; the app itself is fine.
  - Ads are still delivering and spend is still accruing UNMEASURED while disconnected.
  - Fix is to reconnect at the integrations page.
  - Both `ads_read` AND `ads_management` must remain granted on the Meta consent screen — dropping either leaves spend sync broken with a different error (both were verified present on the 2026-08-02 recovery).

## Confirm-before-escalate rule (the diagnostic)

`classifyReconnectRequired` in [[meta__graph-retry]] classifies purely on a
string trigger (`"api access blocked"`), and the seed phrasing was observed
EXACTLY ONCE across a ~40-minute window on 2026-08-02. This SDK stops a
single-sighting string from misrouting the founder by probing Meta's
`debug_token` endpoint BEFORE any card is raised:

| debug_token verdict | outcome |
|---|---|
| unreachable (network / decode / config error) | `{emitted:false}`, warn — fail closed |
| `data.is_valid = true` | `{emitted:false}`, warn — string trigger was a false positive |
| `data.is_valid = false` | proceed to dedupe + insert |

Do NOT 'simplify' the confirmation away in a future refactor. The whole
reason this SDK exists is to keep a one-time Meta string oddity from producing
a wrong-remedy card.

## Workspace-scope isolation

The prior-card `SELECT` filters on `.eq("workspace_id", input.workspaceId)`
— mandatory per two already-folded specs that exist BECAUSE this exact class
of prior-card query leaked across workspaces
([[../specs/meta-sync-spend-escalation-workspace-scope-isolation]],
[[../specs/fix-ad-tool-app-owner-action-scope-isolation]]). The
`runWithReconnectRequiredWorkspaceScope` AsyncLocalStorage wrapper carries
the workspace id along the async chain, so two overlapping publishes for
different workspaces each see their own scope and cards never leak between
them.

Regression guard: `src/lib/meta/reconnect-required-escalation.workspace-scope.test.ts`
registered as `test:reconnect-required-escalation-workspace-scope`.

## Gotchas

- **The debug_token probe is the gate, not the classifier.** A `reconnect_required` tag from `classifyReconnectRequired` is a TRIGGER, not proof. The card only fires when `data.is_valid === false` from the debug_token call. Removing the probe would allow a single-sighting string oddity to book a founder-facing card.
- **AsyncLocalStorage scope binding is mandatory.** Follow the exact pattern from [[meta__app-owner-action-escalation]] — nested calls shadow the outer scope; overlapping chains see only their own. A module-global setter would race under concurrent publishes.
- **Dedupe is per (workspace, UTC day).** A persistent invalid-token state surfaces once per day per workspace, not once per retry or per active ad account.
- **Write failures are silent.** The insert is wrapped in a try/catch that logs and returns `{emitted:false}`. A broken CEO card must not mask the underlying reconnect_required throw.
- **APP_ID / APP_SECRET must be set for the probe.** The default probe requires `process.env.META_APP_ID` + `process.env.META_APP_SECRET`. If either is missing, the probe returns `{reachable:false}` and no card is raised — a missing env is not proof of token death.
- **Never reads `meta_connections.access_token_encrypted`.** The spec pins `workspaces.meta_user_access_token_encrypted` as the canonical column for this probe — the 2026-08-02 incident specifically involved the workspaces-level token going stale.
- **Link is `/dashboard/settings/integrations/meta` — NEVER the Meta App Dashboard.** The App Dashboard is the app-owner-action-required remedy; using it here would be the misrouting this SDK exists to prevent.

## Callers

- [[../inngest/today-sync]] — installs the handler alongside the app-owner sibling; nests both `runWith*WorkspaceScope` wrappers around the Meta-account loop so either human-blocked class routes to the correct card per workspace per day.
- [[../inngest/media-buyer-test-cadence]] — installs the handler alongside the app-owner sibling at cron start; `pullOneCadenceTarget` nests both scope wrappers so each per-target catch that funnels through `isHumanBlockedGraphError` tags `humanBlocked:true` and the summarizer excludes it from the allFailed rethrow.
- [[../inngest/media-buyer-all-customers-refresh]] — installs the handler alongside the app-owner sibling; the per-group refresh nests both scope wrappers and the catch discriminates the `skipped` reason as `"app_owner_action_required"` vs `"reconnect_required"` on `isReconnectRequiredError(err)`.
- [[../inngest/meta-sync]] `handleMetaSyncSpendError` — routes to `escalateReconnectRequired` (not the app-owner escalation) when `classifyMetaSyncSpendError` returns the `meta_sync_spend_reconnect_required` fingerprint. Explicit-argument workspace scope (no ALS) — the workspaceId flows through `scope.workspaceId`.
- [[../inngest/meta-performance]] `meta-iteration-run` via [[../inngest/meta-performance-app-owner-action]] `escalateReconnectRequiredForIterationRun` — same explicit-argument shape as its app-owner sibling; two overlapping runs for different workspaces can never cross-contaminate.

## Tests

- `src/lib/meta/reconnect-required-escalation.workspace-scope.test.ts` — registered as `test:reconnect-required-escalation-workspace-scope`. Proves: two overlapping scopes stay isolated across interleaved awaits; the prior-card SELECT filters on `workspace_id`; the debug_token probe is the gate (unreachable / VALID / thrown all skip the card); same-day dedupe collapses to one card; card body routes to the integrations page + names `ads_read` + `ads_management` + `unmeasured` and never mentions the App Dashboard; the installed handler resolves its workspace from the ALS store at fire time.

## Related

[[meta__graph-retry]] · [[meta__app-owner-action-escalation]] ·
[[../tables/dashboard_notifications]] · [[../integrations/meta-marketing]] ·
[[../functions/platform]]

---

[[../README]] · [[../../CLAUDE]]
