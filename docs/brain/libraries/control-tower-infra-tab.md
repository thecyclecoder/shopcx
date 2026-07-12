# libraries/control-tower-infra-tab

The per-department **Infra tab** payload builder for the Control Tower ([[../specs/control-tower-infra-sub-page]] Phase 1). Ancestry-filters the CT's three global infra feeds — [[control-tower]] `buildErrorFeedSnapshot` (source `error_events`), [[control-tower]] `getControlTowerDbPanels` DB-Health panel, and the [[../inngest/supabase-log-poll]] entries (a source inside the error feed as `source='supabase-logs'`) — to ONE [[../libraries/control-tower]] `OwnerFunction`, so the org mirror's third tier (department drill-in → Infra tab) can trace a red rollup down to the exact `error_events` row / DB-Health proposal that caused it.

**Files:** `src/lib/control-tower/infra-tab.ts` · `src/app/api/developer/control-tower/infra/route.ts`

## Why this exists

Before Phase 1, the CT's three infra feeds were **flat**. A red rollup on `retention` still cost the CEO N hundred hand-filtered rows before it named the actual bad row. The three-tier org mirror ([[../specs/control-tower-switch-controls-three-tier]] Phase 1) gave every department a drill-in — this module fills its Infra tab with the ancestry-owned slice of each feed. The routing spine reuses the canonical registry ([[control-tower-node-registry]] `resolveNodeOwner`) so a department can't own a row its node ancestry doesn't cover.

## Owner resolution — `resolveErrorEventOwner(source, sample)`

The spine of the per-department filter. Takes one `error_events` row's `source` + `sample` JSON, returns the `OwnerFunction` that owns it or `null` when nothing in the sample maps to a registered node id / known route prefix. The route defaults an unresolved row to `platform` (matching where the ancestry falls off the tree in [[control-tower-node-registry]] `resolveNodeOwnerOrOrphanDefault`).

Candidates checked, in order:

1. **`sample.function_id`** — set on `inngest` failures (matches a [[control-tower]] `MONITORED_LOOPS.id`) and sometimes on `vercel` / `supabase` rows whose caller added it. Handed to `resolveNodeOwner` — the canonical lookup returns the row's declared owner without any extra table.
2. **`sample.surface`** on `source='client'` — `portal` and `storefront` both resolve to `retention` (the customer-facing lanes: Sol / Cora / the portal SDK).
3. **`sample.path`** on `vercel` (or a `supabase` row whose context named a path) — routed via `routeOwnerFromPath`, a coarse URL-prefix → OwnerFunction map:
   - `/api/portal/*`, `/api/webhooks/{shopify,appstle,braintree,stripe}` → `retention`
   - `/api/orchestrator/*`, `/api/tickets`, `/api/ticket-*` → `cs`
   - `/api/webhooks/{meta,klaviyo}` → `growth`
   - `/api/developer/*`, `/api/webhooks/vercel-logs`, `/api/client-errors` → `platform`

A `supabase-logs` row (Postgres/auth log incidents polled by [[../inngest/supabase-log-poll]] `pollSupabaseLogs`) has neither a `function_id` nor a `path` — DB-level rows always fall through to `platform`.

## `buildInfraTabPayload(admin, owner, workspaceId)`

Called by `GET /api/developer/control-tower/infra?owner=<fn>`. Returns:

```ts
interface InfraTabPayload {
  generatedAt: string;
  owner: OwnerFunction;
  errorFeed: {
    incidents: InfraTabErrorIncident[];       // ErrorIncident + resolvedOwner (echoed for the UI hint)
    bySource: Record<ErrorSource, number>;    // filtered counts per source
    totalOccurrences: number;                 // sum of `count` across the surviving incidents
  };
  dbHealth: DbHealthPanel | null;             // ONLY under `platform` (Devi's Nano lane); null elsewhere
}
```

Behaviour:

- Reads the last 7 days of `error_events` (mirrors [[control-tower]] `FEED_LOOKBACK_MS`), keeps ONLY rows whose `resolveErrorEventOwner` matches `owner`. For `owner='platform'`, the fall-through rows (`resolveErrorEventOwner === null`) are also included — the ancestry-off-tree default, matching [[control-tower-node-registry]].
- **DB Health panel is `platform`-only.** DB is Devi's — no other department gets it. For every other owner, `dbHealth: null` and the client omits the panel.
- The route is owner-gated (workspace_members.role='owner') and read-only.

## Route: `GET /api/developer/control-tower/infra?owner=<fn>`

Owner-gated wrapper around `buildInfraTabPayload`. Rejects a request without `?owner=<function>` in the OWNER_FUNCTIONS union with `400`. See `src/app/api/developer/control-tower/infra/route.ts`.

## Client — `InfraTab` in `src/app/dashboard/developer/control-tower/page.tsx`

Mounts inside every `DepartmentSection` drill-in ([[../specs/control-tower-switch-controls-three-tier]] Phase 1) as a **Loops | Infra** tab-switcher. **Lazy** — the fetch fires the FIRST time the CEO clicks Infra on that section (the initial render never touches this route). Once requested, the 15 s poll tick re-fetches alongside the loops payload so an open Infra tab stays live.

## Gotchas

- **A row's `sample` is untrusted third-party JSON.** Every accessor guards on `typeof === 'string'` — a malformed sample can't crash the filter.
- **The URL-prefix routing is coarse on purpose.** The right long-term answer is to widen `error_events` to store a `surface` column at write time (`recordError` would fill it from the callsite). Until that lands, coarse route routing gives the CEO 90 % of the win without a migration.
- **The DB Health panel is a rollup count in the Infra tab**, not the full Nano panel — the full panel still lives at the page level (below every department card). The Infra tab surfaces the count so the drill-in view is self-contained; the CEO scrolls down for the full detail.

## Related

[[../specs/control-tower-infra-sub-page]] · [[../specs/control-tower-switch-controls-three-tier]] · [[control-tower-node-registry]] · [[control-tower]] · [[../tables/error_events]] · [[../inngest/supabase-log-poll]] · [[../dashboard/control-tower]]
