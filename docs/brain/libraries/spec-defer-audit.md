# libraries/spec-defer-audit

The **spec-defer-audit** library — the ONE audited+surfaced path for any PROGRAMMATIC (non-human) spec deferral. Enforces the **no-silent-spec-defer** invariant ([[../operational-rules]] § No silent spec defers): every non-human flip of a spec to `deferred` records WHO + WHY and surfaces a one-click un-defer to the CEO.

**File:** `src/lib/agents/spec-defer-audit.ts`

## Why

A spec parked to `deferred` by an autonomous flow with no audit row and no CEO notification is a supervisability gap — the CEO can't tell who parked it or why, and can't override it. (Observed live: the weekly kpi-drift loop-repair spec `kpi-audit-regression-coverage-current-state`, `repair_sig: loop:kpi_drift:regression_coverage_pct:weekly`, was flipped to `deferred` by the loop/repair flow with no `director_activity` row and no notification.) This module is the single chokepoint that makes a programmatic defer auditable + surfaced.

Ada's dispose-downgrade ([[agents-spec-dispose]]) was the original good shape — `director_activity(spec_dispose_downgrade)` + a CEO notification. This module GENERALIZES that shape and exposes the CEO-notification primitive Ada's lane now reuses (one notification surface, one dedupe convention).

## Exports

### `auditedProgrammaticDefer(input): Promise<AuditedDeferResult>`

Park a spec to `deferred` programmatically with full provenance, in three steps (best-effort, never throws):
1. **flip** `flags.deferred` via [[spec-card-state]] `markSpecCardDeferred` — appends a `spec_status_history` row (actor + reason). This is the load-bearing write; a failure here aborts and returns `{ok:false}`.
2. **audit** — a `director_activity(spec_deferred_programmatic)` row: `actor`, a CONCRETE `reason`, and `metadata` (carries `programmatic:true`, `surfaced`, plus caller context like `repair_signatures`).
3. **surface** — `emitDeferNotification` posts a CEO "Spec deferred — <why>" notification with a one-click un-defer deep-link (unless `skipNotification`).

`input`: `{ admin, workspaceId, slug, actor, directorFunction, reason, metadata?, skipNotification? }`. `actor` must be CONCRETE (e.g. `director:platform`, `loop-repair:<sig>`, `worker:bo`). `reason` must be CONCRETE — for a loop/repair defer name the loop/signature AND the why (resolved / superseded / pending-deploy). Returns `{ ok, audited, surfaced, reason? }`.

### `emitDeferNotification(admin, workspaceId, slug, actor, reason, opts?): Promise<{ ok, reason? }>`

The shared CEO-notification primitive: inserts one `dashboard_notifications` row of type `agent_approval_request` ("Spec deferred — {slug}"), routed to the CEO, deep-linking to the spec card where the existing un-defer / Build affordances live. Deduped on `metadata.dedupe_key` (default `spec-defer:{slug}`). `opts` lets a caller override the dedupe key / escalation kind / body prefix — Ada's lane passes `ada-downgrade:{slug}` + her director voice so the two surfaces stay distinct.

## Director_activity action kind

- `spec_deferred_programmatic` — every programmatic (non-human) defer. `actor` records who parked it; `reason` the concrete why; `metadata` may carry `repair_defer:true` + `repair_signatures:[…]` for a loop/repair park.

## Callers

- `scripts/builder-worker.ts` → `applySpecStatusActionInline` — a director chat-flip with `deferred:true` routes through `auditedProgrammaticDefer` (with repair-signature enrichment for a repair-signed spec). Un-deferring (`deferred:false`) stays a plain `markSpecCardDeferred` (un-park is not a silent park).
- `src/lib/agents/spec-dispose.ts` → `emitDowngradeNotification` reuses `emitDeferNotification`.

## Exempt path (human, not routed here)

`POST /api/roadmap/priority` (the CEO's dashboard Defer button) → `markSpecCardDeferred` with actor `owner:{user.id}`. A deliberate human action already provenanced via `spec_status_history`; it does not (and need not) route through this helper.

## Brain links

[[../operational-rules]] · [[agents-spec-dispose]] · [[spec-card-state]] · [[director-activity]] · [[../tables/director_activity]] · [[../tables/dashboard_notifications]] · [[../specs/spec-review-agent]]
