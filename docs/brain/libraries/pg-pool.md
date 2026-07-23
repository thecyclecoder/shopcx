# libraries/pg-pool

Shared **`pg.Pool` for the box worker's hot reads** ([[../specs/cut-internal-egress-pooler-and-spec-rpcs]] Phase 1). One persistent pooled Postgres connection for the every-tick reads the poll loop fires (the top PostgREST-egress drivers Devi's `request_volume_pressure` detector flags), keeping writes on supabase-js.

**File:** `src/lib/pg-pool.ts` · consumers: `scripts/builder-worker.ts` (poll loop egress guard + queued-kind self-update probe)

## Why

Before this module, the poll loop (`scripts/builder-worker.ts`) reached Supabase for every claim / heartbeat / presence-check via supabase-js → PostgREST. Two ~every-5s reads dominated internal egress:

- **`hasClaimableJob()`** — a `SELECT ... LIMIT 1` "is anything claimable?" existence check called every tick. The code comment already flagged it as *"the top PostgREST-egress driver we found."* Each PostgREST call carries a `set_config` preamble + auth re-establishment.
- **The self-update queued-kind probe** — a `SELECT kind FROM agent_jobs WHERE status IN ('queued','queued_resume')` pulling EVERY queued row and DISTINCT-ing them in JS. The biggest rows-shipped driver on a busy queue.

Both are pure reads. Moving them onto a persistent `pg.Pool` off the transaction pooler (`:6543`) eliminates the preamble + auth churn and (for the kind probe) pushes the DISTINCT into Postgres. Writes that rely on RLS / PostgREST semantics stay on supabase-js — this module is **READ-side only**.

## Fail-open by construction

If the pool can't initialize (no `SUPABASE_DB_PASSWORD` / `SUPABASE_DB_URL` on this runtime, e.g. dev or a Vercel edge invocation) OR any query throws (pooler blip, connection cap, transient net), the helpers return `null`. Callers MUST treat `null` as **"fall back to the supabase-js path"** — a pool problem must NEVER stall the 5s poll loop.

## Exports

### `getPgPool(): Pool | null`
Lazy singleton `pg.Pool` off `poolerConnectionString()` (`SUPABASE_DB_URL` → `DATABASE_URL` → `postgres.<ref>:<pw>@<host>:6543/postgres`). Returns `null` when no creds are available. Small (`max`: **1 on Vercel, 4 on the box** — see below) with `idleTimeoutMillis: 10s`, `connectionTimeoutMillis: 5s`, `maxLifetimeSeconds: 300` — so a stale connection can't linger past a DB failover, and the pool never hogs pooler slots. Registers a shutdown hook on first init (`beforeExit` / `SIGTERM` / `SIGINT` → `closePgPool()`).

#### `max` is runtime-aware — `process.env.VERCEL ? 1 : 4`

The pool is a **per-process singleton**, so the real cost is `max × process count`, and the two runtimes
that reach this module scale process count very differently:

| Runtime | Process count | `max` | Why |
|---|---|---|---|
| Box worker | Bounded, long-lived (`MAX_CONCURRENT` builds + the concurrency-1 lanes) | 4 | The poll loop wants a few warm connections; process count can't run away. |
| Vercel | Fluid instances scale OUT with traffic, sharing nothing between siblings | 1 | At `max: 4` a burst multiplies straight into the Supavisor queue. An instance serving a handful of concurrent requests needs ~1 connection. |

Context: Supabase alerted 2026-07-21 that connections were stacking in the pooler queue during a traffic
burst while the instance itself sat idle. Measured at the time: Supavisor **pool size 15** (below the
project default of 20 for XL compute — a manual throttle nobody had revisited), `max_client_conn` 1000
fixed, cluster `max_connections` 240 with ~33 backends in use. `SUPABASE_DB_PASSWORD` is set in Vercel
Production, so every serverless instance touching a pooled spec/goal read opened its own pool. Capping at
1 turns the burst term from `4 × instances` into `1 × instances`.

`VERCEL` is set to `"1"` on every Vercel runtime (build + all function invocations) and is unset on the
box, so this needs no new configuration to stay correct.

### `pgQuery<T>(text, params?): Promise<T[] | null>`
Read query through the shared pool. Returns rows on success; returns `null` on init failure OR query throw. Consumers must handle `null` as fall-back.

### `closePgPool(): Promise<void>`
Idempotent. Called by the shutdown hook — end the pool + release its pooler slots so a graceful worker exit leaves no leaked connection in `pg_stat_activity`.

### `hasClaimableAgentJob(): Promise<boolean | null>`
Egress-guard read — mirrors the exact predicate `claim_agent_job` uses (`status IN ('queued','queued_resume')` AND `(claimed_at IS NULL OR claimed_at <= now())`) so a `false` result means no lane is starved. `null` on pool failure → caller (builder-worker's `hasClaimableJob`) falls back to supabase-js.

### `queuedAgentJobKinds(): Promise<string[] | null>`
**Phase 2 addition** ([[../specs/db-load-cut-getspec-amplifier-claim-fan-sidebar-spray]] Phase 2, tag `db-load-claim-consolidation`) — DISTINCT kinds across all queued/queued_resume rows in one server-side query. Feeds the poll loop's per-lane claim-gate ([[scripts/builder-worker.ts]]) so per-kind claim blocks skip the RPC for kinds that have no queued row (prior gate was kind-agnostic, firing all 41 RPCs when ANY single kind had work). Pool path pushes the DISTINCT to Postgres (rows-shipped drop); `null` on failure → caller falls back to the supabase-js path and issues RPCs as before (fail-open — no lane is starved on pool unavailability). Cheap indexed read against the existing `agent_jobs` table, same contract as `hasClaimableAgentJob`.

### `getSpecWithPhases<S, P>(workspaceId, slug): Promise<{ spec, phases } | null | undefined>`
Server-side single-spec + phases join via the `public.get_spec_with_phases(uuid, text)` RPC ([[../specs/cut-internal-egress-pooler-and-spec-rpcs]] Phase 2, sibling of `list_specs_with_phases`). One pooled query — no PostgREST preamble, no auth churn, no two-round-trip `.from()` fan-out. Return contract:
- `{ spec, phases }` on match
- `null` when the slug does not exist (empty result)
- `undefined` when the pool is unavailable / the query errored — the [[specs-table]] `getSpec` caller MUST treat this as "fall back to the supabase-js RPC path".

### `getSpecBoardContext<S, P, C>(workspaceId, slug): Promise<SpecBoardContextRow | null | undefined>`
**Phase 1 addition** ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 1, tag `spec-read-eff-board-context`) — server-side collapse of the cold `brain-roadmap.getSpec` fan-out. Calls `public.get_spec_board_context(uuid, text)` (migration `20261023120000_get_spec_board_context_rpc.sql`) which returns EVERYTHING the wrapper needs to build one SpecCard in a single pooled round-trip:
- `spec` / `phases` — the target `specs` + `spec_phases` join (same shape as `get_spec_with_phases`).
- `boardableSpecs` — every boardable (`status IS NULL OR status <> 'folded'`) spec in the workspace with its phases, so `resolveBlockedBy` can fill title/status/cleared on each Blocked-by entry without a separate `listSpecs` round-trip.
- `cardState` — the target slug's `spec_card_state` row (or `null`) for `overlayCardFlags` — the transient `short_circuit` / `merged_pr` flags that aren't on `public.specs` yet.
- `goalMemberships` — one row per goal-MEMBER spec (slug → `{ goal_slug, goal_title, main_merge_sha }`) so the outside-dependent goal-blocker normalization at [[blocker-goal-normalize]] runs without a separate `listGoals` fan-out (goals + goal_milestones round-trips).

Return contract mirrors `getSpecWithPhases`:
- `{ spec, phases, boardableSpecs, cardState, goalMemberships }` on match
- `null` on no-such-slug (RPC always returns exactly one row; `spec IS NULL` is the "not found" signal)
- `undefined` on pool unavailable / query error — the [[brain-roadmap]] `getSpec` caller MUST treat this as "fall back to the pre-RPC four-call path" so a pool blip never wedges a cold spec read.

Retires the 4–6 network round-trips a cold `brain-roadmap.getSpec` used to pay (get_spec_with_phases + list_specs_with_phases + goals + goal_milestones + spec_card_state scan). The biggest per-subprocess win as the agent/director fleet scales — every fresh `claude -p` re-pays those round-trips cold because the in-memory spec cache is per-process.

### `listSpecsWithPhases<S, P>(workspaceId, scope): Promise<Array<{ spec, phases }> | null>`
**Phase 2 addition** ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 2, tag `spec-read-eff-pool`) — pooled path to the existing `public.list_specs_with_phases(uuid, text)` RPC (the same server-side spec+phases join `listSpecs` already dispatches to). Strips the PostgREST `set_config` preamble + auth churn off every whole-board read (board render, roadmap, spec-drift, roadmap-status). Behavior-preserving — same rows, same scope enum (`'active' | 'archived' | 'all'`). Returns `null` on pool unavailable / query error → the caller ([[specs-table]] `listSpecs`) falls through to the pre-existing `admin.rpc('list_specs_with_phases', ...)` path.

### `listSpecCardStates<C>(workspaceId): Promise<C[] | null>`
**Phase 2 addition** ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 2, tag `spec-read-eff-pool`) — pooled full-workspace scan of `public.spec_card_state`, the transient board overlay (`short_circuit` / `merged_pr` flags) every render pulls. Same column set the PostgREST reader ships, without the preamble. Returns `null` on pool unavailable / query error → the caller ([[spec-card-state]] `getSpecCardStates`) falls through to the pre-existing `admin.from('spec_card_state').select(...)` path.

### `listGoalsWithMilestones<G, M>(workspaceId): Promise<Array<{ goal, milestones }> | null>`
**Phase 2 addition** ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 2, tag `spec-read-eff-pool`) — pooled goals + goal_milestones collapse. The supabase-js path paid TWO PostgREST round-trips (`goals` then `goal_milestones IN (ids)`) each with its own `set_config` preamble; this helper does ONE pooled query with `to_jsonb(g)` + a per-goal `jsonb_agg(to_jsonb(m) ORDER BY m.position)` subselect. No new RPC (matches the Phase 2 "no new integration" constraint) — the join is inline SQL against the existing tables. The caller ([[goals-table]] `listGoals`) filters (status/owner/parent_goal_id) in-memory over the bounded workspace set — behavior-preserving vs the DB-level filter. Returns `null` on pool unavailable / query error → the caller falls through to the pre-existing two-call `admin.from('goals').select(...)` + `.from('goal_milestones').in('goal_id', ids)` path.

### `notifySpecChanged(workspaceId, slug): Promise<void>`
**Phase 4 addition** ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 4, tag `spec_changed`) — publish a `pg_notify('spec_changed', 'workspaceId::slug')` through the pool. Fire-and-forget: any failure (no pool, transient net, blocked NOTIFY) is swallowed with a warn so a raw INSERT/UPDATE writer can NEVER fail because the notification rail was unreachable. Called from the [[specs-table]] `invalidateSpecCache` chokepoint on every write, so every cache-eviction event on any process is broadcast to every warm process running `LISTEN spec_changed` — the event-driven eviction that lets the warm worker's TTL be raised to minutes. Payload is UUID + '::' + kebab slug, well under the 8000-byte NOTIFY cap.

### `startSpecChangedListener(handler): Promise<boolean>`
**Phase 4 addition** ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 4, tag `spec_changed`) — hold ONE dedicated pooled connection running `LISTEN spec_changed` and invoke `handler(workspaceId, slug)` for each notification (payload split on '::'). Idempotent: a second call while a listener is already active returns `true` without reopening. Returns `false` when the pool is unavailable OR the underlying connection refused `LISTEN` (e.g. a Supavisor transaction-mode pooler) OR any other setup error — the caller MUST treat `false` as "no event-driven eviction available, keep the polled/short-TTL fallback." Wired from [[builder-worker]] (`scripts/builder-worker.ts`) startup to call [[specs-table]] `invalidateSpecCache` on each event — same chokepoint the in-process writers use, so the in-process cache + every subscribed wrapper ([[brain-roadmap]] `getSpec` / `getRoadmap`) evict in lockstep. Errors on the LISTEN client drop the listener + let the poll safety-net take over; the client is destroyed (never returned to the shared pool) so a LISTEN-scoped connection can't leak to another caller.

### `stopSpecChangedListener(): Promise<void>` / `isSpecChangedListenerActive(): boolean`
**Phase 4 addition** ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 4, tag `spec_changed`) — graceful shutdown (`UNLISTEN` + destroy) and an active-slot probe the warm worker uses to gate the TTL raise. A raised TTL only fires AFTER the LISTEN slot is confirmed active by `isSpecChangedListenerActive()`, so a failed listener startup can never park a long TTL without the event-driven eviction that backs it.

> ⚠️ **The `spec_changed` listener above runs on the shared pool (`:6543`, transaction pooler), which does NOT deliver `LISTEN`/`NOTIFY`** (verified 2026-07-22: a LISTEN on `:6543` never receives; the same on `:5432` does). So on the box it almost certainly returns `false` and the code lives on its poll/short-TTL fallback — harmless (fail-open) but the event-driven eviction isn't actually firing. The `agent_job_queued` listener below fixes this class by connecting via the **session pooler (`:5432`)**; the `spec_changed` listener could be migrated the same way as a follow-up.

### `startAgentJobQueuedListener(handler): Promise<boolean>` / `stopAgentJobQueuedListener()` / `isAgentJobQueuedListenerActive()`
**box-listen-notify-instant-claims** — event-driven box claims. Holds ONE dedicated **session-mode (`:5432`)** `pg.Client` running `LISTEN agent_job_queued` and invokes `handler(kind)` on each notification (payload = the job `kind`, used as a wake signal). Backed by the `agent_job_queued_notify_trg` trigger on [[../tables/agent_jobs]] (migration `20261201120000`), which `pg_notify`s when a row becomes claimable (INSERT of a queued row, a status transition into `queued`/`queued_resume`, or a `claimed_at` change on a queued row — the build-gate cooldown clearing).

- Uses `sessionConnectionString()` (`SUPABASE_DB_SESSION_URL`, else the pooler string with `:6543`→`:5432`) because the transaction pooler does not deliver `LISTEN`. It opens a raw dedicated `Client`, NOT the shared pool.
- Fail-open: returns `false` when no session creds / the connection refused LISTEN / any setup error → the caller keeps its poll loop (which is also the backstop for a NOTIFY missed while disconnected — `NOTIFY` is fire-and-forget, not durable). Idempotent (a second call while active returns `true`). Client errors drop the listener and let the poll take over; `closePgPool` calls `stopAgentJobQueuedListener` so a graceful exit leaks no backend.
- Consumed by [[builder-worker]] startup: the handler calls `signalPollWake()` to cut the `POLL_MS` sleep short, so a newly-queued job is claimed within **milliseconds** instead of up to a full tick. **Verified end-to-end on prod 2026-07-22** (trigger → pg_notify → `:5432` LISTEN delivered, both INSERT + requeue paths). The claim itself stays the atomic `claim_agent_job` (`FOR UPDATE SKIP LOCKED`) — the NOTIFY is only a wake signal, so concurrent lanes still can't double-claim.

### `listSpecsWithPhases<S, P>(workspaceId, scope, since?): Promise<Array<{ spec, phases }> | null>` — **Phase 5 delta cursor**
**Phase 5 extension** ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 5, tag `p_since`) — added an optional `since` argument (`Date | string | null`). Non-null → the RPC filters to specs whose `updated_at > since`, so an incremental poller ships ONLY changed rows. `null` / omitted preserves the pre-Phase-5 full-board behavior. Backed by migration `20261023130000_list_specs_with_phases_p_since.sql` — the RPC signature is now `(uuid, text, timestamptz default null)` and the `p_since IS NULL OR s.updated_at > p_since` predicate lives inside the WHERE clause. The migration also adds the `specs_ws_updated_at_idx (workspace_id, updated_at)` index so the delta filter (and the probe below) stay index-friendly.

### `specsMaxUpdatedAt(workspaceId): Promise<Date | null>`
**Phase 5 addition** ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 5, tag `p_since`) — cheap "did anything change?" change-probe. Runs `SELECT max(updated_at) FROM public.specs WHERE workspace_id = $1` through the pool (index-only scan on `specs_ws_updated_at_idx`); returns a `Date` on match (`epoch 0` for an empty workspace so a caller's `probe > highWater` comparison stays monotonic), or `null` on pool unavailable / query error. Callers keep a per-workspace high-water mark and skip the whole-board re-pull when the probe hasn't advanced — the [[brain-roadmap]] `getRoadmap` wrapper cache (Phase 3 `spec-read-eff-roadmap-cache`) already consumes this: on a stale entry it probes first and extends the TTL when nothing has changed, so an idle workspace amortizes to ZERO whole-board scans between real writes.

## Consumers

- `scripts/builder-worker.ts` — `hasClaimableJob()` and the self-update queued-kind probe. Both wrap the pool path in a try + fall-through to the pre-existing supabase-js path when `null` is returned. Same fail-open contract as before.
- [[claim-rpc-verify]] `verifyClaimAgentJobCooldown()` — reads the live `claim_agent_job(text[])` function body via `pg_get_functiondef` to verify the cooldown predicate is present. Called from `ensureClaimAgentJobCooldownVerified` before the build/plan claim block each poll pass (throttled with a 10-minute TTL). Fails open on pool unavailability (returns `ok:true` with a "cannot verify" reason).
- [[specs-table]] `getSpec` — prefers the pooled `getSpecWithPhases` call, falls through to `admin.rpc('get_spec_with_phases', ...)` on pool unavailability. Same fail-open contract; SpecRow shape byte-identical to the pre-Phase-2 path.
- [[brain-roadmap]] `getSpec` — prefers the pooled `getSpecBoardContext` call ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 1). Fail-open: pool unavailable / query error falls through to the pre-Phase-1 four-call path (`getSpecFromDb` + `loadWorkspaceMapsMemoized`). Consumes the exported `specRowFromDbForPool` mapper from [[specs-table]] so the RPC's `boardable_specs` array reconstructs into the SAME `SpecRow` shape the fallback returns — byte-for-byte behavior-preserving.
- [[specs-table]] `listSpecs` — prefers the pooled `listSpecsWithPhases` call ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 2). Fail-open: pool unavailable / query error falls through to `admin.rpc('list_specs_with_phases', ...)`. `SpecRow` shape byte-identical either way (both dispatch to the same server-side RPC; only the transport differs).
- [[spec-card-state]] `getSpecCardStates` — prefers the pooled `listSpecCardStates` call ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 2). Fail-open: pool unavailable / query error falls through to `admin.from('spec_card_state').select(...)`.
- [[goals-table]] `listGoals` — prefers the pooled `listGoalsWithMilestones` call ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 2). Fail-open: pool unavailable / query error falls through to the pre-existing supabase-js two-call path. Filters are applied in-memory over the bounded workspace set (behavior-preserving vs the pre-Phase-2 DB-level filter).
- [[specs-table]] `invalidateSpecCache` — publishes `pg_notify('spec_changed', 'workspaceId::slug')` via `notifySpecChanged` on every write ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 4). Fire-and-forget; a pg_notify error is swallowed so a writer path never fails because the notification rail was unreachable.
- [[builder-worker]] (`scripts/builder-worker.ts`) — startup registers `startSpecChangedListener` with a handler that calls `invalidateSpecCache(ws, slug)` on each event, then raises the [[specs-table]] `SPEC_CACHE_TTL_MS` + [[brain-roadmap]] wrapper TTL to 5 minutes via `setSpecCacheTTLMs` / `setWrapperCacheTTLMs` ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 4). Only raises on `isSpecChangedListenerActive()` — a failed LISTEN start (no pool creds / transaction-mode pooler / transient) leaves the 15s TTL + poll fallback in effect (pre-Phase-4 behavior).

## Verification / measurement

`pg_stat_statements` after deploy shows the `set_config` preamble call rate + the box's `agent_jobs` existence-read rate materially reduced (the two hot reads no longer appear as PostgREST calls); the pool opens ≤ `max: 4` and closes on shutdown (no connection leak in `pg_stat_activity`).

## Notes for later phases

Phase 3 (dashboard consolidation RPC) can layer on this helper for its pooled read path where a request originates in a runtime that already has pooler creds (i.e. the box worker or an Inngest step). The dashboards must continue to reach Supabase over PostgREST/RLS — never expose `getPgPool()` from a client component.
