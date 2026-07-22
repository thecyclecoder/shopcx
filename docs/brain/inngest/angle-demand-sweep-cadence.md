# inngest/angle-demand-sweep-cadence

The **daily palette-refresh loop** — grounds [[../tables/product_angle_palette]]`.search_demand` in real search-volume evidence instead of the seed author's judgement, and surfaces is_active=false drafts for previously-uncovered high-tier ingredient×problem lanes so Dahlia can auto-fan-out without an owner hand-authoring every angle. Phase 3 of the demand-sourced-angle-sweep spec; M2 of the [[../lifecycles/quant-desk-reweight-loop|v3 Ad Creative Engine goal]] "wire the engine into Dahlia + seed all 6 products."

**File:** `src/lib/inngest/angle-demand-sweep-cadence.ts`

## Functions

### `angle-demand-sweep-cadence-cron`
- **Trigger:** cron `30 10 * * *` (daily — offset 30 min after the sibling `acquisition-research-cadence-cron` at `0 10` so the two Growth crons don't contend for the same DB connections).
- **Retries:** 1
- Scope: ad-tool workspaces (those with [[../tables/ad_campaigns]] rows). Per workspace, in a `sweep-${workspaceId}` step:
  1. Enumerates `products` scoped to `status='active'`.
  2. For each active product, calls [[../libraries/angle-demand-sweep]] `runSweepForProduct({admin, workspaceId, productId})` — the executor iterates ingredient × PROBLEM_LANES, refreshes existing rows via `refreshAngleSearchDemand`, upserts is_active=false `dahlia_fanned` drafts for high-tier no-match lanes, and writes one `director_activity` audit row per product (`action_kind='angle_demand_sweep_ran'`, `director_function='growth'`).
  3. Aggregates counts + providers into a `WorkspaceSweepResult` returned to the outer step.
- Ends with a Control-Tower heartbeat (`emit-heartbeat` calling [[../libraries/control-tower|emitCronHeartbeat]] with the cron id `angle-demand-sweep-cadence-cron`) — the runtime artifact the MONITORED_LOOPS tile evaluates against. No beat within `livenessWindowMs` (30h for a daily cron per the CLAUDE.md monitor-cadence invariant) → RED alert on the CEO's Control Tower.
- **Best-effort per product** — a single product's sweep failure logs + continues; one bad product must never break the workspace loop.

### `angle-demand-sweep-cadence-manual`
- **Trigger:** event `ads/angle-demand-sweep.cadence { workspaceId?, productId? }` — on-demand fan-out.
  - `{ workspaceId, productId }` → one product sweep (returns one `WorkspaceSweepResult`).
  - `{ workspaceId }` → every active product in that workspace.
  - `{}` → every ad-tool workspace's active products (same scope as the cron).
- No heartbeat (manual — the cron owns the liveness tile).

## Node registry / kill-switch

- **Owner:** `growth` — declared in [[../libraries/control-tower]] `MONITORED_LOOPS`. [[../libraries/control-tower-node-registry|`resolveNodeOwner('angle-demand-sweep-cadence-cron')`]] returns `growth`, so the org-chart roster, kill-switch route validation, and grader scoping all agree.
- **Kill-switch:** fail-open per [[../tables/kill_switches]] (MISSING ROW ⇒ ON). The CEO flips it OFF via `POST /api/developer/control-tower/switch` with `{ nodeId: 'angle-demand-sweep-cadence-cron', off: true }`; the route validates the id against the node registry (this cron's MONITORED_LOOPS entry). Flipping the ancestor `growth` cascades OFF to this cron and every other Growth-owned node in one write.
- **Heartbeat:** end-of-run `emitCronHeartbeat('angle-demand-sweep-cadence-cron')` writes the [[../tables/loop_heartbeats]] row the monitor reads for the 30h liveness window.

## Downstream tables written (via SDKs — never raw)
- [[../tables/product_angle_palette]] — via [[../libraries/angle-palette]] `upsertAngle` (drafts, is_active=false) and `refreshAngleSearchDemand` (targeted search_demand + notes patch on existing rows).
- [[../tables/director_activity]] — one row per product sweep (via [[../libraries/director-activity]] `recordDirectorActivity`, best-effort).
- [[../tables/loop_heartbeats]] — one end-of-run row via `emitCronHeartbeat`.

## Reads (via SDKs — never raw)
- [[../tables/products]] — active-status filter.
- [[../tables/product_seo_keywords]] — via [[../libraries/angle-demand-sweep]] `fetchSearchDemand` (workspace-scoped ilike on `keyword`).
- [[../tables/product_ingredients]] + benefits + reviews + media — via [[../libraries/product-intelligence]] `getProductIntelligence` (ingredient names for the sweep).
- [[../tables/product_angle_palette]] — via [[../libraries/angle-palette]] `listAnglePalette` (`includeInactive:true` so a drafted-but-un-promoted row is not re-drafted).

## Gotchas

- **NEVER flips is_active on its own** — that stays owner-gated. A high-tier no-match lane surfaces a draft (is_active=false, source='dahlia_fanned'); an owner promotes it via the angles page. The sweep also NEVER touches is_active on the refresh path (see `refreshAngleSearchDemand` — patch is scoped to `search_demand + notes + updated_at`).
- **Owner-gated per the north-star rail** — the sweep is a bounded proxy; the Growth Director (Max) owns the objective. Every write is auditable in `director_activity` (`action_kind='angle_demand_sweep_ran'`), and the kill-switch lets the CEO stop it in one flip.
- **Idempotent** — every re-run re-refreshes existing rows to the current tier and re-checks each no-match lane; the palette's `(workspace, product, theme, problem)` unique key prevents draft duplication.

---

[[../README]] · [[../libraries/angle-demand-sweep]] · [[../libraries/angle-palette]] · [[../tables/product_angle_palette]] · [[../tables/product_seo_keywords]] · [[../libraries/control-tower]] · [[../libraries/director-activity]] · [[../../CLAUDE]]
