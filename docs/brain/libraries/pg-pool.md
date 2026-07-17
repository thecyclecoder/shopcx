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
Lazy singleton `pg.Pool` off `poolerConnectionString()` (`SUPABASE_DB_URL` → `DATABASE_URL` → `postgres.<ref>:<pw>@<host>:6543/postgres`). Returns `null` when no creds are available. Small (`max: 4`) with `idleTimeoutMillis: 10s`, `connectionTimeoutMillis: 5s`, `maxLifetimeSeconds: 300` — so a stale connection can't linger past a DB failover, and the pool never hogs pooler slots. Registers a shutdown hook on first init (`beforeExit` / `SIGTERM` / `SIGINT` → `closePgPool()`).

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

## Consumers

- `scripts/builder-worker.ts` — `hasClaimableJob()` and the self-update queued-kind probe. Both wrap the pool path in a try + fall-through to the pre-existing supabase-js path when `null` is returned. Same fail-open contract as before.
- [[claim-rpc-verify]] `verifyClaimAgentJobCooldown()` — reads the live `claim_agent_job(text[])` function body via `pg_get_functiondef` to verify the cooldown predicate is present. Called from `ensureClaimAgentJobCooldownVerified` before the build/plan claim block each poll pass (throttled with a 10-minute TTL). Fails open on pool unavailability (returns `ok:true` with a "cannot verify" reason).
- [[specs-table]] `getSpec` — prefers the pooled `getSpecWithPhases` call, falls through to `admin.rpc('get_spec_with_phases', ...)` on pool unavailability. Same fail-open contract; SpecRow shape byte-identical to the pre-Phase-2 path.
- [[brain-roadmap]] `getSpec` — prefers the pooled `getSpecBoardContext` call ([[../specs/spec-read-efficiency-for-scaling-fleet]] Phase 1). Fail-open: pool unavailable / query error falls through to the pre-Phase-1 four-call path (`getSpecFromDb` + `loadWorkspaceMapsMemoized`). Consumes the exported `specRowFromDbForPool` mapper from [[specs-table]] so the RPC's `boardable_specs` array reconstructs into the SAME `SpecRow` shape the fallback returns — byte-for-byte behavior-preserving.

## Verification / measurement

`pg_stat_statements` after deploy shows the `set_config` preamble call rate + the box's `agent_jobs` existence-read rate materially reduced (the two hot reads no longer appear as PostgREST calls); the pool opens ≤ `max: 4` and closes on shutdown (no connection leak in `pg_stat_activity`).

## Notes for later phases

Phase 3 (dashboard consolidation RPC) can layer on this helper for its pooled read path where a request originates in a runtime that already has pooler creds (i.e. the box worker or an Inngest step). The dashboards must continue to reach Supabase over PostgREST/RLS — never expose `getPgPool()` from a client component.
