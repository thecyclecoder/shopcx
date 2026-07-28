# libraries/meta/dead-verb-escalation

The CEO-facing surface for a Meta capability that VANISHED. Companion to
[[meta__graph-retry]] `isPermanentGraphError` — when Graph classifies a
response as permanent (a removed / deprecated API surface), this SDK raises a
deduped `dashboard_notifications` card that names both the CALLING FUNCTION
and the CAPABILITY LOST (Meta code + subcode + canonical message).

**Motivation:** the incident on 2026-07-27 when the CEO went to crown two
Superfood Tabs winners by hand and the cold-scaler mint failed in his face —
Meta had removed Advantage+ Shopping Campaign creation weeks earlier (code
`100` subcode `2490568`), but `getOrCreateColdScalerCampaign` had zero live
callers so the breakage sat undetected. A whole autonomous capability went to
zero silently. This SDK turns "the endpoint quietly failed" into "the next
occurrence is a message, not an archaeology exercise".

**File:** `src/lib/meta/dead-verb-escalation.ts`

## Exports

### `escalateDeadMetaVerb` — function

```ts
async function escalateDeadMetaVerb(
  admin: Admin,
  input: {
    workspaceId: string;
    label: string;              // the graphFetchJson label, e.g. "POST act_9999/campaigns"
    status: number;             // HTTP status (typically 400)
    error: GraphError;          // the tagged throw carrying metaCode + metaSubcode + metaClass
    capability?: string;        // optional caller-supplied capability name
    callingFunction?: string;   // optional caller-supplied function name
    nowMs?: number;             // tests pin this so the dedupe day is deterministic
  },
): Promise<{ emitted: boolean }>
```
Raises the CEO card. Idempotent per (workspace, capabilitySignature, UTC day)
— confirming predicate is `metadata->>dedupe_key`, and we insert only after
the SELECT returns zero rows. Returns `{emitted:false}` on a same-day
duplicate or a DB write failure (write failures are logged, never rethrown —
an escalation SDK that CAN throw would drop the caller into a nested error
path just as the CEO card was supposed to make things easier).

### `deadVerbCapabilitySignature` — function

```ts
function deadVerbCapabilitySignature(err: GraphError, fallbackLabel: string): string
```
Build the dedupe-key input: `meta_<code>_<subcode>` when both are present,
`meta_<code>` when only the code is set, `label:<label>` when neither is set.
Same-code:subcode pair on the same UTC day collapses to one card; a different
removed endpoint (different pair) surfaces independently.

### `registerPermanentGraphErrorHandler` wire

`installDefaultDeadVerbEscalationHandler(admin)` installs a handler on
[[meta__graph-retry]] that fires the CEO card automatically when a permanent-
class error is thrown AND a workspace scope is set via
`setCurrentDeadVerbWorkspaceScope(workspaceId)`. The scope is a module-level
slot because `graphFetchJson` doesn't know which workspace it's serving; a
caller (an Inngest function, a media-buyer runner) sets the scope at its
own boundary and clears it at exit.

## Dedupe key shape

`dead_meta_verb:<workspaceId>:<capabilitySignature>:<yyyy-mm-dd>` — same shape
as the sibling escalations in [[media-buyer-agent]] (`escalateUnderProvisionedCohort`,
`escalateMediaBuyerExecuteFailure`) so the dashboard-side de-duplication
pattern is consistent across every autonomous rail.

## Gotchas

- **Dedupe is per (workspace, capability, UTC day).** A persistent removed
  endpoint surfaces once per day per workspace, not once per retry — but a
  DIFFERENT removed capability that also throws that same day gets its own
  card (dedupe is signature-scoped, not blanket).
- **Write failures are silent.** The insert is wrapped in a try/catch that
  logs and returns `{emitted:false}`. Never rethrows — a broken CEO card must
  not mask the underlying capability loss.
- **Message is truncated.** `title` at 200 chars, `body` at 4000 chars,
  `meta_message` metadata at 2000 chars — the standard `dashboard_notifications`
  budget.
- **`link` deep-links to `/dashboard/marketing/ads`** — the CEO's next step
  is to change code, and marketing/ads is where the cold-scaler / media-buyer
  surfaces live.

## Callers

- No live callers yet; Phase 2 introduces this SDK. Future graduate-flow /
  cold-scaler / any Meta-touching pass that catches a permanent throw calls
  `escalateDeadMetaVerb` (or is covered automatically via the
  registered handler once `setCurrentDeadVerbWorkspaceScope` is set).

## Related

[[meta__graph-retry]] · [[../tables/dashboard_notifications]] ·
[[media-buyer-agent]] (sibling escalation pattern) ·
[[../specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]] ·
[[../functions/growth]]

---

[[../README]] · [[../../CLAUDE]]
