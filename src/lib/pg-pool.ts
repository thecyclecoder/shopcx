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
import { Pool, type PoolConfig, type QueryResultRow } from "pg";

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
