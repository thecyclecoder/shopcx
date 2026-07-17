/**
 * Shared pooler `pg.Pool` for the box worker's hot reads.
 *
 * The box's poll loop (scripts/builder-worker.ts) has historically hit Supabase via
 * supabase-js → PostgREST for every claim + heartbeat + presence check. Two ~every-
 * 5s reads — the `hasClaimableJob` egress guard and the `agent_jobs.kind` self-update
 * probe — are the top PostgREST-egress drivers Devi's `request_volume_pressure`
 * detector flags (each PostgREST call carries a `set_config` preamble + auth churn).
 *
 * This module opens ONE persistent `pg.Pool` off the Supabase transaction pooler
 * (`:6543`) so those hot reads become pooled connections (no preamble, no auth).
 *
 * Fail-open by construction: if the pool can't initialize (no DB password on this
 * runtime) or a query throws (pooler blip, connection cap, transient net), the
 * helpers return `null` and the caller falls back to its existing supabase-js path.
 * A pool problem must NEVER stall the 5s poll loop.
 *
 * Writes that rely on RLS / PostgREST semantics stay on supabase-js — this module
 * is READ-side only.
 *
 * Brain: docs/brain/libraries/pg-pool.md
 */
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

const PROJECT_REF = "urjbhjbygyxffrfkarqn";
const DEFAULT_HOST = "aws-1-us-east-1.pooler.supabase.com";

// Sane defaults for a worker sharing the transaction pooler with the rest of the
// app: keep the pool small (idle conns cost pool slots) and bound idle + lifetime
// so a stale connection can't linger past a DB failover.
const DEFAULT_MAX = 4;
const IDLE_TIMEOUT_MS = 10_000;
const CONN_TIMEOUT_MS = 5_000;
const MAX_LIFETIME_SECONDS = 300;

let pool: Pool | null | undefined;
let shutdownHooked = false;

function poolerConnectionString(): string | null {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!password) return null;
  const host = process.env.SUPABASE_DB_HOST || DEFAULT_HOST;
  return `postgres://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@${host}:6543/postgres`;
}

function ensureShutdownHook(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const close = () => { void closePgPool(); };
  try {
    process.once("beforeExit", close);
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  } catch {
    /* signal wiring is best-effort — never throw synchronously */
  }
}

/**
 * Lazy singleton `pg.Pool`. Returns `null` when no pooler credentials are
 * available on this runtime (dev, or a Vercel edge invocation) — callers use
 * `null` as the signal to fall back to supabase-js.
 */
export function getPgPool(): Pool | null {
  if (pool !== undefined) return pool;
  const connectionString = poolerConnectionString();
  if (!connectionString) {
    pool = null;
    return null;
  }
  const config: PoolConfig = {
    connectionString,
    max: DEFAULT_MAX,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONN_TIMEOUT_MS,
    maxLifetimeSeconds: MAX_LIFETIME_SECONDS,
  };
  try {
    const p = new Pool(config);
    // Idle-client errors (pooler restart, TCP RST) emit on the pool — without a
    // listener node crashes the process. Log + let the pool re-open on next query.
    p.on("error", (err) => {
      console.warn("[pg-pool] idle client error (continuing):", err.message);
    });
    pool = p;
    ensureShutdownHook();
    return p;
  } catch (e) {
    console.warn("[pg-pool] init failed (falling back to supabase-js):", e instanceof Error ? e.message : e);
    pool = null;
    return null;
  }
}

/**
 * Run a read query through the shared pool. Returns rows on success; returns
 * `null` if the pool is unavailable OR the query throws — callers MUST treat
 * `null` as "fall back to supabase-js" (fail-open contract).
 */
export async function pgQuery<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<T[] | null> {
  const p = getPgPool();
  if (!p) return null;
  try {
    const res = await p.query<T>(text, params as never);
    return res.rows;
  } catch (e) {
    console.warn("[pg-pool] query failed (falling back):", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Close the pool + release its slots. Idempotent. Called on worker shutdown. */
export async function closePgPool(): Promise<void> {
  const p = pool;
  if (!p) return;
  pool = null;
  try {
    await p.end();
  } catch {
    /* best-effort during shutdown */
  }
}

// ── Typed read helpers for the box poll loop's hot paths ─────────────────────

/**
 * Egress-guard read: is ANY `agent_jobs` row claimable right now? Mirrors the
 * exact predicate `claim_agent_job` uses — `status IN ('queued','queued_resume')`
 * AND `(claimed_at IS NULL OR claimed_at <= now())` — so a `false` result means
 * no lane is starved. The supabase-js version of this call is called out in
 * scripts/builder-worker.ts as "the top PostgREST-egress driver we found."
 *
 * Returns:
 *   - `true`   → at least one claimable row (poll every lane as normal)
 *   - `false`  → none claimable (idle box can skip ~20 per-kind claim RPCs)
 *   - `null`   → pool unavailable / query error (caller falls back to supabase-js)
 */
export async function hasClaimableAgentJob(): Promise<boolean | null> {
  const rows = await pgQuery<{ id: string }>(
    `SELECT id FROM agent_jobs
       WHERE status IN ('queued', 'queued_resume')
         AND (claimed_at IS NULL OR claimed_at <= now())
       LIMIT 1`,
  );
  if (rows === null) return null;
  return rows.length > 0;
}

/**
 * Every-tick self-update probe: the DISTINCT set of `kind` values across all
 * queued/queued_resume rows. The old supabase-js path pulled EVERY queued row
 * and did the distinct in JS — the biggest rows-shipped driver on a busy queue.
 *
 * Returns `null` on pool failure (caller falls back to supabase-js).
 */
export async function queuedAgentJobKinds(): Promise<string[] | null> {
  const rows = await pgQuery<{ kind: string | null }>(
    `SELECT DISTINCT kind FROM agent_jobs
       WHERE status IN ('queued', 'queued_resume')`,
  );
  if (rows === null) return null;
  const kinds: string[] = [];
  for (const r of rows) if (r.kind) kinds.push(r.kind);
  return kinds;
}

/**
 * Server-side `specs` + `spec_phases` join for a single (workspace, slug) — calls the
 * `public.get_spec_with_phases(uuid, text)` RPC through the pool (one round-trip, no
 * `set_config` preamble). Mirrors the shape supabase-js returns from the same RPC so
 * the caller can dispatch either path off the same handler.
 *
 * Returns:
 *   - `{ spec, phases }` on match
 *   - `null` on no-such-slug (empty result)
 *   - `undefined` on pool unavailable / query error (caller falls back to supabase-js)
 */
export async function getSpecWithPhases<S = unknown, P = unknown>(
  workspaceId: string,
  slug: string,
): Promise<{ spec: S; phases: P[] } | null | undefined> {
  const rows = await pgQuery<{ spec: S; phases: P[] | null }>(
    `SELECT spec, phases FROM public.get_spec_with_phases($1::uuid, $2::text)`,
    [workspaceId, slug],
  );
  if (rows === null) return undefined;
  const row = rows[0];
  if (!row || !row.spec) return null;
  return { spec: row.spec, phases: (row.phases ?? []) as P[] };
}

/**
 * spec-read-eff-board-context — cold-getSpec collapse in one pooled round-trip.
 *
 * Calls `public.get_spec_board_context(uuid, text)` (Phase 1 of
 * docs/brain/specs/spec-read-efficiency-for-scaling-fleet.md) which returns EVERYTHING
 * brain-roadmap.getSpec (src/lib/brain-roadmap.ts:1500) needs to build one SpecCard:
 *   - `spec` / `phases`      — the target `specs` + `spec_phases` join (like get_spec_with_phases)
 *   - `boardableSpecs`       — every boardable (status IS NULL OR status <> 'folded') spec + its
 *                              phases in the workspace, so `resolveBlockedBy` can fill title/status/
 *                              cleared on each entry without a second listSpecs round-trip.
 *   - `cardState`            — the target slug's `spec_card_state` row (or null) for
 *                              `overlayCardFlags` — the transient short_circuit / merged_pr flags.
 *   - `goalMemberships`      — one row per goal-MEMBER spec (slug → owning goal + main_merge_sha)
 *                              so the outside-dependent goal-blocker normalization runs without a
 *                              separate `listGoals` fan-out (goals + goal_milestones round-trips).
 *
 * Returns:
 *   - `{ spec, phases, boardableSpecs, cardState, goalMemberships }` on match
 *   - `null` on no-such-slug (the RPC always returns one row; `spec` is null when the slug is
 *     absent OR the slug is folded — folded specs are excluded from `boardableSpecs`, matching the
 *     board's isBoardableStatus filter)
 *   - `undefined` on pool unavailable / query error (caller falls back to supabase-js)
 */
export interface SpecBoardContextRow<S = unknown, P = unknown, C = unknown> {
  spec: S;
  phases: P[];
  boardableSpecs: Array<{ spec: S; phases: P[] }>;
  cardState: C | null;
  goalMemberships: Array<{
    spec_slug: string;
    goal_slug: string;
    goal_title: string;
    main_merge_sha: string | null;
  }>;
}

export async function getSpecBoardContext<S = unknown, P = unknown, C = unknown>(
  workspaceId: string,
  slug: string,
): Promise<SpecBoardContextRow<S, P, C> | null | undefined> {
  const rows = await pgQuery<{
    spec: S | null;
    phases: P[] | null;
    boardable_specs: Array<{ spec: S; phases: P[] | null }> | null;
    card_state: C | null;
    goal_memberships: Array<{
      spec_slug: string;
      goal_slug: string;
      goal_title: string;
      main_merge_sha: string | null;
    }> | null;
  }>(
    `SELECT spec, phases, boardable_specs, card_state, goal_memberships
       FROM public.get_spec_board_context($1::uuid, $2::text)`,
    [workspaceId, slug],
  );
  if (rows === null) return undefined;
  const row = rows[0];
  if (!row || !row.spec) return null;
  return {
    spec: row.spec,
    phases: (row.phases ?? []) as P[],
    boardableSpecs: (row.boardable_specs ?? []).map((r) => ({
      spec: r.spec,
      phases: (r.phases ?? []) as P[],
    })),
    cardState: row.card_state,
    goalMemberships: row.goal_memberships ?? [],
  };
}

/**
 * spec-read-eff-pool — pooled straggler read #1: `list_specs_with_phases(uuid, text, timestamptz)`.
 *
 * Phase 2 of [[docs/brain/specs/spec-read-efficiency-for-scaling-fleet]] — every whole-board reader
 * (board render, roadmap, spec-drift, roadmap-status) calls `list_specs_with_phases` via
 * PostgREST which still pays the `set_config` preamble + auth churn even though the RPC itself is
 * a single server-side join. Pooling strips the preamble off every cold read, independent of the
 * cold-getSpec fan-out collapse in Phase 1.
 *
 * Phase 5 (tag `p_since`) — added an optional incremental cursor argument. Non-null → the RPC
 * filters to specs whose `updated_at > since`, so an incremental poller ships ONLY changed rows.
 * Pass `null`/omit to preserve the pre-Phase-5 full-board behavior.
 *
 * Returns:
 *   - `Array<{ spec, phases }>` on success (empty array = no matching rows in scope / no changes)
 *   - `null` on pool unavailable / query error (caller falls back to the supabase-js RPC path)
 */
export async function listSpecsWithPhases<S = unknown, P = unknown>(
  workspaceId: string,
  scope: "active" | "archived" | "all",
  since?: string | Date | null,
): Promise<Array<{ spec: S; phases: P[] }> | null> {
  const sinceIso = since instanceof Date ? since.toISOString() : since ?? null;
  const rows = await pgQuery<{ spec: S; phases: P[] | null }>(
    `SELECT spec, phases FROM public.list_specs_with_phases($1::uuid, $2::text, $3::timestamptz)`,
    [workspaceId, scope, sinceIso],
  );
  if (rows === null) return null;
  return rows.map((r) => ({ spec: r.spec, phases: (r.phases ?? []) as P[] }));
}

/**
 * p_since — Phase 5 change-probe of docs/brain/specs/spec-read-efficiency-for-scaling-fleet.md.
 *
 * Cheap "did anything change?" gate for a full-board poller. Returns the workspace's max
 * `specs.updated_at`. Callers keep the last observed value as a high-water mark and skip the
 * whole-board re-pull when the probe returns the same (or older) timestamp — the
 * `specs_ws_updated_at_idx (workspace_id, updated_at)` index (added by
 * 20261023130000_list_specs_with_phases_p_since.sql) makes this an index-only scan.
 *
 * Returns:
 *   - `Date` on match (empty workspace ⇒ epoch 0 so a caller's comparison stays monotonic)
 *   - `null` on pool unavailable / query error (caller falls back to a full-board re-pull)
 */
export async function specsMaxUpdatedAt(workspaceId: string): Promise<Date | null> {
  const rows = await pgQuery<{ max_updated_at: string | null }>(
    `SELECT max(updated_at) AS max_updated_at FROM public.specs WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (rows === null) return null;
  const iso = rows[0]?.max_updated_at ?? null;
  // Empty workspace → epoch 0 so a caller's `probe > highWater` comparison keeps returning false
  // (nothing to fetch) instead of throwing on a null.
  return iso ? new Date(iso) : new Date(0);
}

/**
 * spec-read-eff-pool — pooled straggler read #2: `spec_card_state` full-workspace scan.
 *
 * Phase 2 of [[docs/brain/specs/spec-read-efficiency-for-scaling-fleet]] — the transient board
 * overlay (short_circuit / merged_pr flags) is read whole-workspace on every board render. Same
 * shape the PostgREST reader ships, just without the preamble.
 *
 * Returns:
 *   - `Array<row>` on success (empty array when no card_state rows exist for the workspace)
 *   - `null` on pool unavailable / query error (caller falls back to the supabase-js `.from()` path)
 */
export async function listSpecCardStates<C extends QueryResultRow = QueryResultRow>(
  workspaceId: string,
): Promise<C[] | null> {
  const rows = await pgQuery<C>(
    `SELECT workspace_id, spec_slug, status, phase_states, flags, last_merge_sha, updated_at
       FROM public.spec_card_state
       WHERE workspace_id = $1`,
    [workspaceId],
  );
  return rows;
}

/**
 * spec-read-eff-pool — pooled straggler read #3: goals + goal_milestones in one pooled call.
 *
 * Phase 2 of [[docs/brain/specs/spec-read-efficiency-for-scaling-fleet]] — the supabase-js path
 * pays TWO PostgREST round-trips (`goals` then `goal_milestones IN (goal ids)`) each with its own
 * `set_config` preamble. This helper collapses them into ONE pooled query via a jsonb aggregation
 * of each goal's milestones (same shape [[goals-table]] `goalRowFromDb` consumes), so both
 * preambles disappear AND the id round-trip is retired.
 *
 * Every workspace goal is returned; the caller applies `ListGoalsFilter` filters
 * (status/owner/parent_goal_id) in-memory over the bounded workspace set — no per-filter round
 * trip. Behavior-preserving: same rows, same filter semantics, same sort order.
 *
 * Returns:
 *   - `Array<{ goal, milestones }>` on success (empty array = no goals in the workspace)
 *   - `null` on pool unavailable / query error (caller falls back to the supabase-js two-call path)
 */
export async function listGoalsWithMilestones<G = unknown, M = unknown>(
  workspaceId: string,
): Promise<Array<{ goal: G; milestones: M[] }> | null> {
  const rows = await pgQuery<{ goal: G; milestones: M[] | null }>(
    `SELECT
       to_jsonb(g) AS goal,
       COALESCE(
         (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.position)
            FROM public.goal_milestones m WHERE m.goal_id = g.id),
         '[]'::jsonb
       ) AS milestones
     FROM public.goals g
     WHERE g.workspace_id = $1`,
    [workspaceId],
  );
  if (rows === null) return null;
  return rows.map((r) => ({ goal: r.goal, milestones: (r.milestones ?? []) as M[] }));
}

// ── spec_changed pg_notify/LISTEN wiring (Phase 4 tag `spec_changed`) ─────────
//
// Phase 4 of [[docs/brain/specs/spec-read-efficiency-for-scaling-fleet]] — turn the warm worker's
// polled spec-cache TTL into an event-driven eviction. The single write chokepoint
// [[specs-table]] `invalidateSpecCache` fires `pg_notify('spec_changed', workspace_id::text || '::' ||
// slug)` through this pool; the warm long-lived worker (scripts/builder-worker.ts) opens ONE
// dedicated pooled connection that runs `LISTEN spec_changed` and evicts the matching (ws, slug)
// entry from every downstream cache the moment the notification arrives. This lets the warm worker
// hold a much longer TTL (raised via [[specs-table]] `setSpecCacheTTLMs` + [[brain-roadmap]]
// `setWrapperCacheTTLMs`) with the 5s poll demoted to a safety-net.
//
// Fail-open by construction: no pool creds / pool errored / underlying connection doesn't support
// LISTEN (e.g. Supavisor transaction mode) → the listener never starts, the warm worker keeps the
// pre-Phase-4 15s TTL (the poll-driven refresh) as the sole source of truth. A pg_notify failure
// on the publish side is swallowed too — a raw INSERT/UPDATE writer must never fail because the
// listener side was unreachable. This is READ-side coordination; it can only shorten staleness,
// never break correctness.

/**
 * spec_changed — publish a `pg_notify('spec_changed', 'workspace_id::slug')` through the pool.
 * Fire-and-forget: any failure (no pool, transient net, blocked NOTIFY) is swallowed with a warn.
 * Called from the [[specs-table]] `invalidateSpecCache` chokepoint on every write.
 */
export async function notifySpecChanged(workspaceId: string, slug: string): Promise<void> {
  const p = getPgPool();
  if (!p) return;
  try {
    // Payload is the sole channel content — receiver splits on '::' back to (workspace_id, slug).
    // Both sides are DB-issued UUIDs / lowercase-kebab slugs (validated by [[specs-table]] writers);
    // no injection surface. Postgres NOTIFY payload is capped at 8000 bytes — well above the pair's
    // combined length (uuid + '::' + kebab-slug is < 100 bytes).
    await p.query("SELECT pg_notify('spec_changed', $1)", [`${workspaceId}::${slug}`]);
  } catch (e) {
    console.warn("[pg-pool] notifySpecChanged failed (continuing):", e instanceof Error ? e.message : e);
  }
}

let listenClient: PoolClient | null = null;
let listenStarting = false;

/**
 * spec_changed — hold ONE pooled connection running `LISTEN spec_changed` and invoke `handler`
 * for each notification (payload split on '::' → (workspaceId, slug)). Meant for the warm
 * long-lived worker (scripts/builder-worker.ts) — a single dedicated LISTEN slot is idempotent
 * (a second call while a listener is already active resolves true without reopening). Idempotent
 * shutdown via `stopSpecChangedListener` for a graceful process exit.
 *
 * Returns `true` when the LISTEN is active (either freshly opened OR already running from a prior
 * call), `false` when the pool is unavailable OR the underlying connection refused LISTEN (e.g.
 * a Supavisor transaction-mode pooler) OR any other setup error — the caller MUST treat `false`
 * as "no event-driven eviction available, keep the polled/short-TTL fallback".
 */
export async function startSpecChangedListener(
  handler: (workspaceId: string, slug: string) => void,
): Promise<boolean> {
  if (listenClient) return true;
  if (listenStarting) return true;
  const p = getPgPool();
  if (!p) return false;
  listenStarting = true;
  try {
    const client = await p.connect();
    // Errors on the LISTEN client MUST NOT crash the worker — drop the listener + let the poll
    // safety-net take over. A fresh restart / re-init can retry.
    client.on("error", (err) => {
      console.warn("[pg-pool] LISTEN spec_changed client error (dropping listener):", err.message);
      const c = listenClient;
      listenClient = null;
      if (c) {
        try {
          c.release(true); // destroy — do NOT return a LISTEN-registered connection to the pool
        } catch {
          /* best-effort */
        }
      }
    });
    client.on("notification", (msg) => {
      if (msg.channel !== "spec_changed") return;
      const payload = msg.payload ?? "";
      const sep = payload.indexOf("::");
      if (sep < 0) return;
      const workspaceId = payload.slice(0, sep);
      const slug = payload.slice(sep + 2);
      if (!workspaceId || !slug) return;
      try {
        handler(workspaceId, slug);
      } catch (e) {
        console.warn("[pg-pool] spec_changed handler threw (continuing):", e instanceof Error ? e.message : e);
      }
    });
    await client.query("LISTEN spec_changed");
    listenClient = client;
    return true;
  } catch (e) {
    console.warn("[pg-pool] startSpecChangedListener failed (falling back to poll):", e instanceof Error ? e.message : e);
    return false;
  } finally {
    listenStarting = false;
  }
}

/** Graceful shutdown: UNLISTEN + destroy the dedicated LISTEN client. Idempotent. */
export async function stopSpecChangedListener(): Promise<void> {
  const c = listenClient;
  listenClient = null;
  if (!c) return;
  try {
    await c.query("UNLISTEN spec_changed");
  } catch {
    /* best-effort */
  }
  try {
    c.release(true); // destroy — never return a LISTEN-scoped connection to the pool
  } catch {
    /* best-effort */
  }
}

/** True when the dedicated LISTEN slot is currently active. Used by the warm worker to gate the
 *  TTL raise — a raised TTL only fires when event-driven eviction is actually running. */
export function isSpecChangedListenerActive(): boolean {
  return listenClient !== null;
}
