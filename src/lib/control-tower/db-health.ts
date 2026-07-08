/**
 * DB Health Agent — watch Postgres health, ROOT-CAUSE the slow ones via EXPLAIN, and PROPOSE
 * (never auto-apply) the matching fix (docs/brain/specs/db-health-agent.md, Phase 1).
 *
 * North star (supervisable autonomy, like the Repair Agent): the box DETECTS — it reads pg_stat_*
 * via the pooler, runs EXPLAIN on top offenders, and classifies WHY each is slow — but DDL / deletes
 * are higher-stakes (a bad index slows writes; a retention delete loses data), so the agent NEVER
 * applies them. It authors a single-phase fix spec and SURFACES it for one-tap owner Build. A tool
 * optimizing a bounded proxy (DB perf/size), supervised by Platform.
 *
 * This file is PURE detection + classification + dedup + spec-templating (no fs/pg/network at module
 * load) plus the two admin-client surface helpers (enqueue a deduped proposal · read the panel). The
 * raw pg reads (pg_stat_statements, EXPLAIN, pg_class sizes, pg_stat_user_*) live on the box
 * (scripts/builder-worker.ts) — the deployed runtime can't reach the pooler the way EXPLAIN needs —
 * exactly like the migration-drift check. The box feeds this module the rows; the LOGIC stays
 * testable. See docs/brain/libraries/db-health.md.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  DB_HEALTH_SLOWQ_LOOP_ID,
  DB_HEALTH_SIZE_LOOP_ID,
  DB_HEALTH_INSTANCE_LOOP_ID,
} from "@/lib/control-tower/registry";
import { isAllowlisted } from "@/lib/control-tower/migration-drift";

export { DB_HEALTH_SLOWQ_LOOP_ID, DB_HEALTH_SIZE_LOOP_ID, DB_HEALTH_INSTANCE_LOOP_ID };

type Admin = ReturnType<typeof createAdminClient>;

// ── Taxonomy ─────────────────────────────────────────────────────────────────

/** The diagnosed root cause of a finding — what the proposed fix must address. */
export type DbHealthCause =
  // slow-query causes (from EXPLAIN, or the seq_scan stats when no plan is available):
  | "seq_scan" // Seq Scan on a big table — a missing/wrong index for the WHERE/JOIN predicate.
  | "no_index_match" // an index exists but the predicate can't use it (function/cast/leading-wildcard).
  | "sort_spill" // a Sort/Hash spilled to disk (external merge) — work_mem or an index-for-order-by.
  | "full_aggregate" // a full-table aggregate / DISTINCT scan (the control_tower_loop_beats class).
  | "missing_limit" // an unbounded result set with no LIMIT.
  | "high_call_volume" // fast PER CALL but hammered — a hot endpoint dominating total time by VOLUME, not per-call cost → reduce calls / cache / a hot-predicate (or GIN) index. Never a vacuum.
  | "bloat_stale_stats" // the plan is bad because stats are stale / the table is bloated → vacuum/analyze.
  // size/index/bloat causes (from the daily sweep):
  | "unbounded_growth" // a table growing fast with no apparent retention (the loop_heartbeats case).
  | "missing_index" // a large table with a high seq_scan share vs idx_scan.
  | "unused_index" // an idx_scan=0 index on a large table (pure write overhead + bloat).
  | "bloat_vacuum_lag" // a hot table with a high dead-tuple ratio + stale autovacuum.
  // instance-saturation causes (from the periodic instance-health pass — pg_stat_database + pg_stat_activity + pg_roles.rolconfig):
  | "statement_timeout_pressure" // live queries are running past a large fraction of the per-role statement_timeout ceiling (the `authenticated` 8s cap) — they'll be killed under load.
  | "temp_spill_pressure" // pg_stat_database.temp_files/temp_bytes crossed the window flag — hash/sort work_mem is spilling to disk on the instance, dragging every heavy query.
  | "connection_saturation" // active+waiting backends are eating a big fraction of max_connections — new sessions will queue/error before they can run.
  | "cache_pressure" // blks_hit / (blks_hit + blks_read) fell below the floor — the working set is spilling out of shared_buffers (memory tier).
  | "rollback_error_rate" // pg_stat_database.xact_rollback / total transactions crossed the flag — clients are being killed / rolling back at a rate that indicates ongoing pressure (the 2026-07-02 incident's 7.43%).
  // request-volume / egress cause (db-health-request-volume, from the slow-query pass's pg_stat_statements aggregate):
  | "request_volume_pressure"; // total PostgREST request rate and/or rows shipped/hr crossed the flag — an internal polling / row-shipping firehose (the driver of egress + the auth-preamble churn), fixed upstream (cache / batch / widen poll / reuse connections / an aggregate RPC), never a per-query index.

/** What the proposed fix spec asks the owner to build. The agent never runs these — it proposes. */
export type DbHealthFixKind =
  | "retention_cron"
  | "add_index"
  | "drop_index"
  | "query_rewrite"
  | "reduce_calls" // a hot, fast-per-call query → cut the call frequency / cache / add a hot-predicate (GIN for an array `@>`) index. NOT a vacuum.
  | "vacuum_tuning"
  // Escalation-shaped instance-saturation fix kinds — advisory only, never auto-appliable (a compute
  // tier / work_mem change is high-stakes, surface-don't-apply per operational-rules § North star).
  // Phase 1 records them so FIX_KIND_BY_CAUSE stays exhaustive over the new causes; Phase 2 wires
  // the advisory guidance into buildFixSpecMarkdown + surfaces them through enqueueDbHealthProposal.
  | "raise_compute" // working set > shared_buffers / sustained memory+temp pressure → recommend the next compute tier.
  | "raise_work_mem" // temp-spill pressure → recommend a bounded per-connection work_mem bump.
  | "investigate_timeouts"; // rollback/timeout pressure → point at the top statement_timeout offenders from the slow-query pass.

/** Which pass produced the finding (drives the loop_id + panel grouping). */
export type DbHealthCategory = "slow_query" | "growth" | "index" | "bloat" | "instance";

const FIX_KIND_BY_CAUSE: Record<DbHealthCause, DbHealthFixKind> = {
  seq_scan: "add_index",
  no_index_match: "query_rewrite",
  sort_spill: "add_index",
  full_aggregate: "query_rewrite",
  missing_limit: "query_rewrite",
  high_call_volume: "reduce_calls",
  bloat_stale_stats: "vacuum_tuning",
  unbounded_growth: "retention_cron",
  missing_index: "add_index",
  unused_index: "drop_index",
  bloat_vacuum_lag: "vacuum_tuning",
  // Instance-saturation → escalation-shaped fixes (Phase 2 wires the advisory templating).
  statement_timeout_pressure: "investigate_timeouts",
  temp_spill_pressure: "raise_work_mem",
  connection_saturation: "raise_compute",
  cache_pressure: "raise_compute",
  rollback_error_rate: "investigate_timeouts",
  request_volume_pressure: "reduce_calls",
};

// ── Input row shapes (what the box reads + hands us) ──────────────────────────

/** A pg_stat_statements row (the columns the box selects). */
export interface SlowQueryRow {
  queryid: string;
  query: string;
  calls: number;
  total_exec_time: number; // ms
  mean_exec_time: number; // ms
  stddev_exec_time: number; // ms
  rows: number;
}

/** A per-table snapshot row (what the size sweep inserts into db_table_size_history + reads back). */
export interface TableSizeRow {
  table_name: string;
  total_bytes: number;
  row_estimate: number;
  seq_scan: number;
  idx_scan: number;
  n_live_tup: number;
  n_dead_tup: number;
  last_autovacuum: string | null;
  captured_at?: string;
}

/** A pg_stat_user_indexes row joined with the index size (the box selects these). */
export interface IndexStatRow {
  table_name: string;
  index_name: string;
  idx_scan: number;
  index_bytes: number;
  is_unique: boolean;
  is_primary: boolean;
}

/**
 * Instance-health input — the per-pass signal snapshot the box reads and hands the pure classifier
 * (db-health-instance-saturation-detector Phase 1). Aggregate over the shopcx database (the box
 * SELECTs `pg_stat_database` filtered to `datname = current_database()` and folds the counters, then
 * probes `pg_stat_activity` for live sessions and `pg_roles.rolconfig` for the `authenticated`
 * role's `statement_timeout` — the 8s ceiling queries die against on load). Kept as raw counters +
 * derived probes; the classifier does the ratios so the thresholds live in ONE place.
 */
export interface InstanceHealthInput {
  /** pg_stat_database.xact_commit for this database (successful commits). */
  xactCommit: number;
  /** pg_stat_database.xact_rollback for this database (rollbacks — includes client-side aborts + statement_timeout kills). */
  xactRollback: number;
  /** pg_stat_database.deadlocks — a rising count means the app is fighting itself. */
  deadlocks: number;
  /** pg_stat_database.temp_files — count of on-disk temp files this database has written (hash/sort spills). */
  tempFiles: number;
  /** pg_stat_database.temp_bytes — cumulative bytes written to temp files (the 883 GB in the 2026-07-02 incident). */
  tempBytes: number;
  /** pg_stat_database.blks_hit — buffer-cache hits. */
  blksHit: number;
  /** pg_stat_database.blks_read — disk reads (the ones that missed the cache). */
  blksRead: number;
  /** pg_stat_activity: count of backends running a query right now (state='active'). */
  activeBackends: number;
  /** pg_stat_activity: count of backends waiting on a lock (wait_event_type='Lock'). */
  waitingBackends: number;
  /** current_setting('max_connections')::int — the ceiling active+waiting compete for. */
  maxConnections: number;
  /**
   * pg_stat_activity: count of live queries whose elapsed time is past a big fraction of the
   * `authenticated` statement_timeout (see INSTANCE_TIMEOUT_HEADROOM_FRACTION). >0 means at least
   * one live query is about to be killed by the 8s ceiling; a proxy for "the timeout is the reason
   * we roll back", visible BEFORE the rollback lands.
   *
   * db-investigate-timeouts-instance: this count is FILTERED to `usename = 'authenticated'` at the
   * SQL layer — only queries running under the role subject to the 8s ceiling can be killed by it.
   * `supabase_admin` dashboard queries + `postgres` / `service_role` writes have their own timeouts
   * (or none) and don't belong in this signal; leaving them in it produced false positives that the
   * instance pass had no way to distinguish from a real app-side offender. Mirrors `isForeignQuery`
   * in the slow-query path.
   */
  statementsNearTimeout: number;
  /**
   * Up to a few near-timeout offender samples (the same row set the count is derived from), so the
   * finding evidence can name the OFFENDER — not just "1 live query near timeout" — and the operator
   * can route to the right slow-query fix without a separate pg_stat_activity probe. Each sample
   * carries the (normalized) query text + how long it had been running when we sampled it. Optional
   * — the count alone still fires the signal; samples enrich the evidence when the box captured them.
   * db-investigate-timeouts-instance.
   */
  nearTimeoutSamples?: NearTimeoutSample[];
  /**
   * pg_roles.rolconfig for role='authenticated' (the Supabase REST/anon-key role): the statement
   * timeout, in milliseconds, that kills a query under load. `null` when unset (no ceiling on that
   * role). Quoted verbatim in the evidence so the operator sees the exact ceiling being hit.
   */
  authenticatedStatementTimeoutMs: number | null;
  /**
   * db-health-temp-spill-attribution (2026-07-08): the top pg_stat_statements offenders by
   * `temp_blks_written`, so a `temp_spill_pressure` finding can NAME which query is spilling — not
   * just "the instance is spilling". pg_stat_database.temp_bytes is an instance aggregate with no
   * query attribution; the previous instance pass proposed a generic `raise_work_mem` bump and never
   * fingered the offender, so a single unindexed disk-sort (the subscriptions LTV scan: 9 MB/call ×
   * 35K calls = 314 GB, 98% of all spill) hid inside the aggregate for a week. Optional — the
   * aggregate flag still fires without it; offenders make the proposal actionable at the source.
   */
  tempOffenders?: TempSpillOffender[];
  /**
   * db-health-temp-spill-rate (2026-07-08): `pg_stat_database.temp_bytes` is CUMULATIVE since the last
   * stats reset — and Supabase's `postgres` role isn't superuser, so `pg_stat_reset()` is denied and
   * the counter can't be zeroed after a fix. A pure cumulative flag therefore stays lit forever once
   * tripped (the 314 GB the subscriptions scan left behind never drops). So the pass also passes the
   * PRIOR instance-pass reading (`tempBytesPrev` = the last heartbeat's temp_bytes, `tempReadingAgeHours`
   * = hours since it) and `analyzeInstanceHealth` prefers the RATE (Δbytes / Δhours): an active spiller
   * keeps the rate high, a fixed one drops it to ~0 so the finding SELF-CLEARS. Absent (first pass /
   * unreadable prior) ⇒ fall back to the cumulative flag (preserves acute-incident detection).
   */
  tempBytesPrev?: number;
  /** Hours since the prior instance-pass reading that produced `tempBytesPrev`. */
  tempReadingAgeHours?: number;
}

/**
 * One temp-file-spilling query the box captured from pg_stat_statements (ordered by temp_blks_written)
 * when the instance pass ran. Names the OFFENDER behind an instance-level temp_spill_pressure signal so
 * the fix targets the query (an index on the ORDER BY / GROUP BY, or a rewrite) rather than a blanket
 * work_mem bump. db-health-temp-spill-attribution.
 */
export interface TempSpillOffender {
  queryid: string;
  query: string;
  calls: number;
  /** Cumulative temp bytes this query wrote in the stats window (temp_blks_written × block size). */
  tempBytes: number;
}

/**
 * One near-timeout live-query offender the box captured out of pg_stat_activity when the instance
 * pass ran. Enriches the `statement_timeout_pressure` finding's evidence with the OFFENDER (query
 * text + how long it had been running) so the operator can route to the right slow-query fix
 * without a separate probe. db-investigate-timeouts-instance.
 */
export interface NearTimeoutSample {
  /** Whole seconds the query had already been running when we sampled it. */
  durationSec: number;
  /** Trimmed query text from pg_stat_activity.query (a normalized `$1` statement in Supabase). */
  query: string;
}

// ── Thresholds (tunable constants — the bounded proxy's guardrails) ───────────

/** A query under this mean AND under the total-time floor isn't worth a proposal (noise). */
export const SLOW_QUERY_MIN_MEAN_MS = 100;
/** …but a cheap-per-call query run enough to dominate total DB time still qualifies. */
export const SLOW_QUERY_MIN_TOTAL_MS = 30_000; // 30s cumulative in the stats window
/**
 * The slow-per-call vs high-call-volume boundary (the accuracy upgrade — db-health-agent-accuracy).
 * At/above this mean a query is a genuine PER-CALL problem (EXPLAIN → index/rewrite — the orders-class
 * win). BELOW it, a query only ranks high because it's *hammered* (e.g. 4ms × 1.27M calls = a hot
 * poll), so the fix is to reduce calls / cache / add a hot-predicate (or GIN) index — never a vacuum.
 * Sub-~20ms is the unambiguous volume case; we resolve the 20–50ms grey zone toward volume too, since
 * a sub-50ms query rarely justifies a new index from its plan alone. */
export const SLOW_PER_CALL_MEAN_MS = 50;
/** Only consider tables at least this big for growth/index/bloat (small tables aren't worth DDL). */
export const SIZE_MIN_BYTES = 200 * 1024 * 1024; // 200 MB
/** Day-over-day growth at or above this fraction on a sizeable table ⇒ "growing fast". */
export const GROWTH_FLAG_FRACTION = 0.25; // +25%/day
/** A high seq_scan share on a big table ⇒ a likely missing index. */
export const SEQ_SCAN_SHARE_FLAG = 0.5;
/** …only when the absolute seq_scan count shows the full scans actually happen. */
export const SEQ_SCAN_MIN_ABS = 10_000;
/** An idx_scan=0 index at least this big is pure write overhead ⇒ propose a drop. */
export const UNUSED_INDEX_MIN_BYTES = 50 * 1024 * 1024; // 50 MB
/** A dead-tuple ratio at/above this on a big table whose autovacuum is stale ⇒ bloat. */
export const BLOAT_DEAD_RATIO_FLAG = 0.2;
export const BLOAT_AUTOVACUUM_STALE_MS = 24 * 60 * 60 * 1000; // last autovacuum older than a day

// ── Instance-saturation thresholds (db-health-instance-saturation-detector Phase 1) ─
// The 2026-07-02 incident (86.8% DATABASE errors on Observability, dashboards timing out) was invisible
// to the per-query slow-query pass because it was INSTANCE-level: xact_rollback 7.43%, 883 GB
// temp_bytes, MEMORY 79%, `authenticated`/`authenticator` statement_timeout=8s catching queries under
// load. These thresholds are the bounded proxy that lets the instance pass surface the same signature.
/** xact_rollback / (xact_commit + xact_rollback) at or above this ⇒ rollback_error_rate. Incident was 0.0743. */
export const INSTANCE_ROLLBACK_RATIO_FLAG = 0.05; // 5%
/** cumulative temp_bytes over the sampled window at or above this ⇒ temp_spill_pressure (the fallback flag when there's no prior reading to rate against). Incident was 883 GB. */
export const INSTANCE_TEMP_BYTES_WINDOW_FLAG = 100 * 1024 * 1024 * 1024; // 100 GB
/** db-health-temp-spill-rate: temp-file spill RATE (Δtemp_bytes / Δhours between passes) at or above this ⇒ temp_spill_pressure. Preferred over the cumulative flag because it SELF-CLEARS once the spill stops (the cumulative counter can't be reset — Supabase's postgres role isn't superuser). The 314 GB subscriptions runaway averaged ~3 GB/hr; 2 GB/hr is "actively spilling hard". */
export const INSTANCE_TEMP_BYTES_RATE_FLAG = 2 * 1024 * 1024 * 1024; // 2 GB/hr
/** blks_hit / (blks_hit + blks_read) BELOW this ⇒ cache_pressure (working set spilling out of shared_buffers). Incident was 0.9869. */
export const INSTANCE_CACHE_HIT_FLOOR = 0.99;
/** (active + waiting) / max_connections at or above this ⇒ connection_saturation. */
export const INSTANCE_CONN_UTIL_FLAG = 0.8; // 80%
/** A live query past this fraction of the `authenticated` statement_timeout is "near timeout" — driving the timeout-pressure signal BEFORE the rollback lands. */
export const INSTANCE_TIMEOUT_HEADROOM_FRACTION = 0.5;

// ── Request-volume / egress thresholds (db-health-request-volume, 2026-07-08) ──
// Nothing in Devi watched aggregate request VOLUME — so an internal polling firehose (the box worker +
// dashboards: ~78K PostgREST requests/hr, ~182K rows shipped/hr, plus ~349K fresh auth sessions from
// un-reused connections) drove egress + the 8M-call auth-preamble churn with no signal. These are the
// escalation line: above them, the pass surfaces the top internal callers for an upstream fix
// (cache / batch / widen the poll interval / reuse connections / an aggregate RPC), never a per-query
// index. Tunable — set to the sustained rate that means "someone is polling too hard", not normal load.
/** Sustained PostgREST request rate (sum(calls)/window-hours) at or above this ⇒ request_volume_pressure. */
export const REQUEST_VOLUME_CALLS_PER_HR_FLAG = 100_000;
/** Rows shipped to clients per hour (sum(rows)/window-hours) at or above this ⇒ request_volume_pressure (egress proxy). */
export const REQUEST_VOLUME_ROWS_PER_HR_FLAG = 100_000;
/** Ignore windows shorter than this — a just-reset pg_stat_statements gives a noisy rate. */
export const REQUEST_VOLUME_MIN_WINDOW_HOURS = 1;

// ── Phase 2 trend thresholds (project the size-history forward, not just day-over-day) ──
/** Need at least this many snapshots in the window to fit a trend (fewer ⇒ no projection — honest). */
export const TREND_MIN_POINTS = 3;
/** …and the snapshots must span at least this many days (a one-day spread isn't a trend). */
export const TREND_MIN_SPAN_DAYS = 2;
/** Project growth this far ahead — a table whose linear fit crosses the ceiling within this window is flagged. */
export const GROWTH_TREND_HORIZON_DAYS = 30;
/** The size a single table crossing is operationally significant (loop_heartbeats was 4.5 GB at crisis). */
export const GROWTH_TREND_CEILING_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
/** A bloat TREND fires at a lower dead ratio than the single-snapshot flag — to catch it earlier… */
export const BLOAT_TREND_MIN_RATIO = 0.1; // below BLOAT_DEAD_RATIO_FLAG (0.2) on purpose
/** …but only when the dead-tuple ratio has CLIMBED at least this much across the window (genuinely worsening). */
export const BLOAT_TREND_RISE = 0.05; // +5 points dead-tuple ratio over the window

/** Tables already covered by a retention cron — never re-propose retention for these. Keep SHORT;
 *  the right answer for a real unbounded table is to build its retention, not to allowlist it.
 *  loop_heartbeats got its prune cron (loop-heartbeats-retention). */
export const RETENTION_AWARE_TABLES: string[] = ["loop_heartbeats"];

/**
 * Sunset / retiring-system allowlist (db-health-agent-accuracy spec — gap 3). A table being turned
 * off must NOT get a perf/size/bloat proposal — we don't tune what we're decommissioning. Mirrors
 * the [[control-tower-migration-drift-check]] sunset allowlist (same `prefix*`/exact match semantics
 * via `isAllowlisted`). Keep SHORT: the right answer for a table we keep is a fix, not an allowlist.
 * Klaviyo (`klaviyo_*`) is being turned off as the in-house messaging/marketing stack replaces it. */
export const DB_HEALTH_SUNSET_ALLOWLIST: string[] = [
  // Klaviyo — replaced by the in-house messaging/marketing stack; tables retired as the sync winds down.
  "klaviyo_*",
];

/**
 * Does this query touch a sunset/retiring table (so it must NOT produce a proposal)? Shape-based scan
 * of the normalized query text for any allowlist entry — a `prefix*` entry matches any identifier
 * starting with the prefix (`klaviyo_*` → `klaviyo_profiles`, `public.klaviyo_events`, …), an exact
 * entry matches the whole table token. Mirrors the migration-drift allowlist semantics, applied to a
 * query instead of a single table name. */
export function isSunsetQuery(query: string, allowlist: string[] = DB_HEALTH_SUNSET_ALLOWLIST): boolean {
  const q = (query || "").toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    if (e.endsWith("*")) return q.includes(e.slice(0, -1)); // prefix match anywhere in the text
    return new RegExp(`\\b${e.replace(/[^a-z0-9_]/g, "")}\\b`).test(q); // exact identifier token
  });
}

/**
 * Foreign / not-ours query filter (db-health-agent-accuracy spec — gap 1). Mirrors the [[repair-agent]]
 * `foreign-app-noise` class: a query we don't own is never our proposal. Shape-based — matches the
 * Supabase Realtime WAL decoder (`SELECT wal->>'type' …`), PostgREST internals (`pgrst_*`), the
 * `pg_catalog` / `information_schema` system catalogs, the `realtime`/`_realtime` schema, and
 * `supabase_admin`-role maintenance queries. None of these index/vacuum/rewrite proposals are ours to
 * make — they belong to Supabase/PostgREST, not the `public.*` app schema. */
const FOREIGN_QUERY_RES: RegExp[] = [
  /wal\s*->>/i, // Supabase Realtime WAL decoder (logical-replication change feed)
  /\bpgrst_/i, // PostgREST internal helper functions / prepared statements
  /\bpg_catalog\b/i, // Postgres system catalog (schema-qualified)
  // Unqualified pg_catalog tables — PostgREST's schema-introspection query references these WITHOUT a
  // `pg_catalog.` prefix, so `\bpg_catalog\b` alone missed it and the introspection query (queryid
  // 4272184973515172242) fell through to a bogus add_index proposal on `(query)` (2026-07-04 db_health
  // noise). Whole-word catalog identifiers only appear in system/introspection SQL, never a public.* app
  // query. Deliberately NOT matching `pg_stat*` (a query reading pg_stat_statements is still not ours).
  /\bpg_(class|attribute|attrdef|namespace|constraint|type|proc|enum|index|inherits|description|depend|rewrite|trigger|policy|am|range|collation|operator|cast|sequence|roles|auth_members|database|tablespace)\b/i,
  /\binformation_schema\b/i, // SQL-standard catalog views
  /\b_?realtime\s*\./i, // realtime / _realtime schema-qualified objects (subscriptions, etc.)
  /\bsupabase_admin\b/i, // supabase_admin-role maintenance/replication queries
];

/**
 * A maintenance command (VACUUM / ANALYZE / CLUSTER / REINDEX) that surfaced in pg_stat_statements is not
 * an app slow-query to optimize — it has no calling endpoint to cache, no WHERE predicate to index, and no
 * poll interval to widen. Without this guard a one-off `VACUUM (ANALYZE) public.orders` (~5s, calls=1)
 * falls through the EXPLAIN-unavailable branch (it isn't a SELECT, so `isSafeSelect` is false) and is
 * misclassified as `high_call_volume` → a nonsense `reduce_calls` proposal (queryids -7677994386067890637
 * and 2919954756727600022, both rejected 2026-07-04). Anchored at the statement start so it only fires on a
 * query that IS a maintenance command, not one that merely mentions the word.
 */
const MAINTENANCE_CMD_RE = /^\s*\(*\s*(vacuum|analyze|cluster|reindex)\b/i;
export function isMaintenanceCommand(query: string): boolean {
  return MAINTENANCE_CMD_RE.test(query || "");
}

export function isForeignQuery(query: string): boolean {
  const q = query || "";
  return FOREIGN_QUERY_RES.some((re) => re.test(q));
}

// db-health-request-volume (2026-07-08): INFRASTRUCTURAL queries — the PostgREST per-request preamble
// (`set_config('role' | 'request.*' | 'search_path' | 'request.jwt.*', …)`) and the GoTrue auth
// server's own session/identity reads. These are issued by the platform on EVERY authenticated
// request; they have NO app endpoint to cache, NO predicate to index, and NO poll interval to widen.
// The slow-query pass kept re-proposing a DOOMED `reduce_calls` fix for the 8M-call set_config preamble
// (queryid -7821780334453251234: proposed + built 3× over 6/23–7/7, always returning) because a spec
// build can't reduce a per-request preamble. The lever for these is REQUEST VOLUME itself, surfaced in
// aggregate by analyzeRequestVolume — never a per-query proposal. Distinct from isForeignQuery (which
// filters queries we don't OWN); an infra query is ours-by-platform but not spec-fixable.
const INFRASTRUCTURAL_QUERY_RES: RegExp[] = [
  /\bset_config\s*\(\s*'(?:role|search_path|request\.|request\.jwt)/i, // PostgREST per-request preamble (named args)
  /^\s*\(*\s*select\s+set_config\s*\(\s*\$\d/i, // normalized preamble AT STATEMENT START (`SELECT set_config($2, $1, $3)`) — anchored so a mutation CTE that merely references set_config for response headers is NOT swept in
  /\bfrom\s+auth\./i, // GoTrue auth schema (schema-qualified)
  /\bfrom\s+(?:mfa_amr_claims|mfa_factors|mfa_challenges|flow_state|saml_relay_states|refresh_tokens|one_time_tokens|sso_providers|sso_domains|saml_providers)\b/i, // GoTrue internal tables
  /\b(?:refresh_token_hmac_key|identities\.identity_data|sessions\.aal|users\.confirmation_token|users\.email_change_token)\b/i, // GoTrue-distinctive columns (bare-table session/identity/user reads)
];

/**
 * Is this a platform-infrastructural query (PostgREST request preamble / GoTrue auth reads) rather than
 * an app query? These are issued per-request by the platform itself — there is no proposal that reduces
 * them (no endpoint, no predicate, no poll interval). analyzeSlowQuery skips them so Devi never churns a
 * doomed `reduce_calls` spec; analyzeRequestVolume surfaces their VOLUME in aggregate instead.
 */
export function isInfrastructuralQuery(query: string): boolean {
  const q = query || "";
  return INFRASTRUCTURAL_QUERY_RES.some((re) => re.test(q));
}

// ── A finding ────────────────────────────────────────────────────────────────

export interface DbHealthFinding {
  /** Stable dedupe key (one open proposal per signature). e.g. `dbhealth:growth:loop_heartbeats`. */
  signature: string;
  category: DbHealthCategory;
  cause: DbHealthCause;
  fixKind: DbHealthFixKind;
  /** the implicated table (or the index, for unused_index). */
  table: string;
  /** short human label for the panel/spec title. */
  title: string;
  /** a one-line impact summary used for ranking + the panel. */
  impact: string;
  /** numeric impact score (bigger = more urgent) — drives ranking. */
  score: number;
  /** the evidence block quoted verbatim into the spec (the EXPLAIN plan, the size delta, the stats). */
  evidence: string;
  /** the proposed fix spec's slug + title (authored to docs/brain/specs on owner Build). */
  specSlug: string;
  specTitle: string;
}

// ── Slow-query classification (the EXPLAIN root-cause brain) ──────────────────

const WRITE_DDL_RE =
  /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|vacuum|analyze|reindex|copy|call|do)\b/i;

/**
 * Is this normalized query safe to EXPLAIN (a read-only SELECT/WITH)? We NEVER EXPLAIN a write — a
 * plain EXPLAIN doesn't execute, but EXPLAIN (ANALYZE) would, so the box only ever ANALYZEs a query
 * this returns true for, and a defensive check here keeps a write off the EXPLAIN path entirely.
 */
export function isSafeSelect(query: string): boolean {
  const q = query.trim().replace(/^\(+/, "").toLowerCase();
  if (!(q.startsWith("select") || q.startsWith("with"))) return false;
  // A WITH ... can wrap a writable CTE (INSERT/UPDATE/DELETE inside) — reject any write keyword.
  if (q.startsWith("with") && WRITE_DDL_RE.test(query)) return false;
  return true;
}

/** Truncate + collapse a query for display in a spec/panel (never dump a 5KB statement). */
export function shortQuery(query: string, max = 400): string {
  const one = query.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export interface ExplainClassification {
  cause: DbHealthCause;
  /** tables a Seq Scan was observed on (for the index proposal target). */
  seqScanTables: string[];
  /** a human hint for the proposed fix ("add an index on the WHERE/JOIN predicate of X"). */
  hint: string;
}

const SEQ_SCAN_RE = /Seq Scan on (?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
/** Any index-driven node in an EXPLAIN plan — a Bitmap Index Scan / Index Scan / Index Only Scan on
 *  a table, plus a Bitmap Heap Scan (the fetch node that pairs with a Bitmap Index Scan). If the plan
 *  is index-driven, a VACUUM never fixes it — the agent-mandate-hardening-dbhealth guardrail keys off
 *  this predicate to refuse to fall back to `bloat_stale_stats` / `vacuum_tuning`. */
const INDEX_SCAN_RE = /\b(Index Only Scan|Index Scan|Bitmap Index Scan|Bitmap Heap Scan)\b/i;

/**
 * Classify an EXPLAIN (text) plan into a root cause. Pure string analysis over the plan text — the
 * box passes whatever EXPLAIN produced (plain, or EXPLAIN (ANALYZE, BUFFERS) for a confirmed-safe
 * SELECT). Order matters: a disk sort/spill and a full aggregate are more specific than a bare seq
 * scan, so they win when both appear.
 *
 * agent-mandate-hardening-dbhealth guardrail (rolled coaching): the "no Seq Scan isolated" fallback
 * does NOT return `bloat_stale_stats` — that classification maps to `vacuum_tuning`, and a vacuum
 * cannot fix an index-driven or unknown-shape plan. The rolled coaching (Devi 4.8/10 over 10 unstuck
 * attempts, tickets `tags @> $3` at 4ms×1.27M dismissed as "vacuum won't help", sms
 * `message_sid = $1` at 31ms×157k dismissed as "smells like missing index") is unambiguous: vacuum
 * belongs to the size-sweep bloat path (analyzeBloat / analyzeBloatTrend — real dead-tuple + stale
 * autovacuum evidence), never here. So:
 *  - Index-driven plan (Bitmap/Index Scan present, no Seq Scan) → `no_index_match` — a covering /
 *    composite / GIN index (for `@>`/`<@`) is what stabilizes the plan; NEVER a vacuum.
 *  - No scan-node bottleneck could be isolated at all → `high_call_volume` — the safe framing is
 *    call-volume pressure (reduce calls / cache / widen the poll). NEVER a vacuum.
 */
export function classifyExplainPlan(planText: string): ExplainClassification {
  const plan = planText || "";
  const seqScanTables: string[] = [];
  let m: RegExpExecArray | null;
  SEQ_SCAN_RE.lastIndex = 0;
  while ((m = SEQ_SCAN_RE.exec(plan))) if (!seqScanTables.includes(m[1])) seqScanTables.push(m[1]);

  // A sort/hash spilling to disk — work_mem pressure or a missing index-for-order-by.
  if (/Sort Method:[^\n]*\b(external merge|external sort)\b/i.test(plan) || /\bDisk:\s*\d+kB/i.test(plan)) {
    return { cause: "sort_spill", seqScanTables, hint: "a Sort spilled to disk (external merge) — add an index matching the ORDER BY, or raise work_mem" };
  }
  // A full-table aggregate / DISTINCT scan over a big relation (the control_tower_loop_beats class).
  if ((/\b(HashAggregate|GroupAggregate)\b/i.test(plan) || /\bUnique\b/i.test(plan)) && seqScanTables.length > 0) {
    return { cause: "full_aggregate", seqScanTables, hint: `a full-table aggregate/DISTINCT scan over ${seqScanTables.join(", ")} — drive the set from a bounded list or a covering index instead of scanning the whole table` };
  }
  // A bare Seq Scan on a table the filter removed most rows from — a missing index on the predicate.
  if (seqScanTables.length > 0) {
    const removed = /Rows Removed by Filter:\s*(\d+)/i.exec(plan);
    const detail = removed ? ` (${removed[1]} rows removed by filter)` : "";
    return { cause: "seq_scan", seqScanTables, hint: `Seq Scan on ${seqScanTables.join(", ")}${detail} — add an index on the WHERE/JOIN predicate column(s)` };
  }
  // Index-driven plan (Bitmap Index Scan / Index Scan / Index Only Scan present, no Seq Scan) — the
  // plan already uses an index, so a VACUUM cannot help. This is plan instability from a MISSING
  // covering/composite/GIN index (or the existing index doesn't fully cover the predicate). Cited by
  // owner dismissals: tickets q6690… Bitmap Index Scan on idx_tickets_tags_gin ("vacuum won't help
  // — needs a GIN"), sms_campaign_recipients q7780… Index Scan on sms_campaign_recipients_message_sid_idx
  // ("smells like a missing index, not vacuum/bloat"). Never emit bloat_stale_stats here.
  if (INDEX_SCAN_RE.test(plan)) {
    return {
      cause: "no_index_match",
      seqScanTables,
      hint: "the plan is index-driven (Bitmap/Index Scan present) — the residual filter / plan instability points at a MISSING covering or composite index (or a GIN index for an array/JSONB `@>` predicate). A VACUUM cannot help an index-driven plan; vacuum belongs to the size-sweep bloat path (real dead-tuple + stale autovacuum evidence).",
    };
  }
  // No scan bottleneck could be isolated at all (pure Aggregate / Limit / Sort / etc.). The safe
  // read is call-volume pressure — NEVER stale stats / vacuum, which this path has no evidence for.
  return {
    cause: "high_call_volume",
    seqScanTables,
    hint: "no scan bottleneck could be isolated in the plan — treat as call-volume pressure (reduce calls / cache / widen the poll interval). A vacuum is only correct with a real dead-tuple signal (analyzeBloat / analyzeBloatTrend), NEVER as the ambiguous no-Seq-Scan fallback.",
  };
}

/**
 * Build a slow-query finding from a pg_stat_statements row + (optionally) its EXPLAIN plan. Returns
 * null when the query isn't over the impact floor (not worth a proposal). When `planText` is null
 * (the box couldn't EXPLAIN it — a parameterized statement on a pre-GENERIC_PLAN server), we still
 * propose, but the cause falls back to a conservative "full_aggregate/seq_scan unknown" read of the
 * query text and the fix is a query-rewrite REVIEW rather than a specific index.
 */
export function analyzeSlowQuery(row: SlowQueryRow, planText: string | null): DbHealthFinding | null {
  // Gap 1 — a query we don't own (Supabase Realtime WAL decoder, PostgREST internals, pg_catalog /
  // information_schema, the realtime schema, supabase_admin) is NEVER our proposal. Filter first.
  if (isForeignQuery(row.query)) return null;
  // Gap 3 — a query against a sunset/retiring table (Klaviyo) gets no proposal: we don't tune what
  // we're turning off.
  if (isSunsetQuery(row.query)) return null;
  // Gap 4 (2026-07-04) — a maintenance command (VACUUM/ANALYZE/CLUSTER/REINDEX) is not an app slow-query;
  // there's no endpoint to cache or predicate to index. Without this it misclassifies as high_call_volume
  // → a nonsense reduce_calls proposal.
  if (isMaintenanceCommand(row.query)) return null;
  // Gap 5 (db-health-request-volume, 2026-07-08) — the PostgREST per-request preamble
  // (set_config) and GoTrue auth reads are infrastructural: no endpoint/predicate/poll to fix, so a
  // `reduce_calls` spec is un-buildable and just churns (queryid -7821780334453251234 was proposed +
  // built 3× and always returned). Skip the per-query proposal; analyzeRequestVolume surfaces their
  // aggregate volume as an escalation instead.
  if (isInfrastructuralQuery(row.query)) return null;

  const overFloor = row.mean_exec_time >= SLOW_QUERY_MIN_MEAN_MS || row.total_exec_time >= SLOW_QUERY_MIN_TOTAL_MS;
  if (!overFloor) return null;

  // Gap 2 — slow-per-call (a genuine per-call cost → EXPLAIN → index/rewrite, the orders-class win)
  // vs high-call-volume (fast per call but hammered → reduce calls / cache / a hot-predicate or GIN
  // index, NEVER a vacuum). Keyed off mean_exec_time.
  const highCallVolume = row.mean_exec_time < SLOW_PER_CALL_MEAN_MS;
  const cls = planText ? classifyExplainPlan(planText) : null;

  let cause: DbHealthCause;
  let hint: string;
  let planBlock: string;
  const arrayPredicate = /@>|<@/.test(row.query); // array/JSONB containment (e.g. `tags @> …`) → GIN
  const erraticPlan = row.stddev_exec_time > row.mean_exec_time;
  if (highCallVolume) {
    cause = "high_call_volume";
    const meanMs = Math.round(row.mean_exec_time);
    const calls = row.calls.toLocaleString();
    hint = arrayPredicate
      ? `fast per call (${meanMs}ms mean) but run ${calls} times — a hot endpoint dominating total DB time by VOLUME, not per-call cost. It uses an array/JSONB containment predicate (\`@>\`): add a GIN index on that column so each call is cheaper, and reduce how often it runs (cache the result / batch / widen the poll). Do NOT vacuum — the per-call time is already fine.`
      : `fast per call (${meanMs}ms mean) but run ${calls} times — a hot endpoint dominating total DB time by VOLUME, not per-call cost. Reduce how often it runs (cache the result / batch / widen the poll interval) and/or add a covering or partial index for the hot predicate. Do NOT vacuum — the per-call time is already fine.`;
    planBlock = planText
      ? planText.trim()
      : "(high call volume — the per-call time is already fine; EXPLAIN is not the lever here, call frequency is)";
  } else if (cls) {
    cause = cls.cause;
    hint = cls.hint;
    planBlock = planText!.trim();
    // agent-mandate-hardening-dbhealth guardrail (rolled coaching): stddev > mean is the "erratic
    // plan" tell — plan instability from a MISSING covering/composite/GIN index, never bloat. A
    // vacuum cannot fix plan instability. Upgrade any bloat_stale_stats classification to
    // no_index_match under erratic-stddev, and add the GIN framing when the predicate uses `@>`.
    // (classifyExplainPlan no longer emits bloat_stale_stats as its fallback, but this belt-and-
    // -suspenders catches the case where a caller passes an already-classified plan.)
    if (erraticPlan && (cause === "bloat_stale_stats" || cause === "no_index_match")) {
      cause = "no_index_match";
      hint = arrayPredicate
        ? `erratic plan (stddev ${Math.round(row.stddev_exec_time)}ms > mean ${Math.round(row.mean_exec_time)}ms) with an array/JSONB containment predicate (\`@>\`) — add a GIN index on that column so the plan is stable. A vacuum cannot fix plan instability.`
        : `erratic plan (stddev ${Math.round(row.stddev_exec_time)}ms > mean ${Math.round(row.mean_exec_time)}ms) — plan instability from a MISSING covering or composite index on the hot predicate. Do NOT propose a vacuum — vacuum cannot fix plan instability.`;
    }
  } else {
    // No plan (couldn't EXPLAIN). agent-mandate-hardening-dbhealth guardrail: the no-plan branch
    // NEVER falls back to bloat_stale_stats/vacuum_tuning either — a vacuum without a real dead-
    // tuple signal is always the wrong fix. Prefer high_call_volume (reduce calls / cache) as the
    // safe fallback; a real aggregate-without-LIMIT still becomes full_aggregate.
    const q = row.query.toLowerCase();
    if (/\b(count|sum|avg|min|max|group by|distinct)\b/.test(q) && !/\blimit\b/.test(q)) {
      cause = "full_aggregate";
      hint = "a full-table aggregate/DISTINCT with no LIMIT (no plan available — EXPLAIN was blocked) — review whether it can be bounded or index-driven";
    } else if (!/\blimit\b/.test(q) && /\bselect\b/.test(q)) {
      cause = "missing_limit";
      hint = "an unbounded SELECT (no plan available) — review whether a LIMIT or a tighter predicate applies";
    } else {
      cause = "high_call_volume";
      hint = arrayPredicate
        ? "slow query without an EXPLAIN plan (parameterized statement, plan blocked) — it uses an array/JSONB containment predicate (`@>`), so a GIN index is the likely lever. Treat as call-volume pressure (reduce calls / cache) rather than a vacuum — vacuum belongs to the size-sweep bloat path (real dead-tuple + stale autovacuum evidence), not here."
        : "slow query without an EXPLAIN plan (parameterized statement, plan blocked) — treat as call-volume pressure (reduce calls / cache / widen the poll interval). A vacuum is only correct with a real dead-tuple signal, which this path never measures.";
    }
    planBlock = "(EXPLAIN unavailable — pg_stat_statements normalized text could not be planned)";
  }

  // agent-mandate-hardening-dbhealth guardrail: from the slow-query path, ROUTE no_index_match →
  // add_index. The rolled coaching's example dismissals ("smells like a missing index, not vacuum",
  // "needs a GIN on tags") all resolve to add_index; a plain query_rewrite (the FIX_KIND_BY_CAUSE
  // default for no_index_match) buries the actionable "which index" lever. Also enforce the
  // invariant that the slow-query path NEVER emits vacuum_tuning — the size-sweep bloat path
  // (analyzeBloat / analyzeBloatTrend) is the only source of a vacuum proposal.
  let fixKind: DbHealthFixKind;
  if (cause === "seq_scan" || cause === "sort_spill" || cause === "no_index_match") fixKind = "add_index";
  else fixKind = FIX_KIND_BY_CAUSE[cause];
  if (fixKind === "vacuum_tuning") {
    // Belt-and-suspenders: if some future edit reintroduces a vacuum path here, snap it back to the
    // safe fallback (high_call_volume / reduce_calls) rather than surface a rolled-coaching-class
    // regression. The tests below assert this invariant so a regression fails loudly.
    cause = "high_call_volume";
    hint = "coaching guardrail: the slow-query path never proposes a vacuum. Vacuum belongs to the size-sweep bloat path (real dead-tuple + stale autovacuum). Treat this as call-volume pressure and re-evaluate on the size sweep.";
    fixKind = "reduce_calls";
  }
  const table = (cls ? cls.seqScanTables[0] : "") || "";
  const sigTable = table ? `:${table}` : "";
  const signature = `dbhealth:slowq:${row.queryid}${sigTable}`;
  const impact = `${Math.round(row.mean_exec_time)}ms mean × ${row.calls} calls = ${Math.round(row.total_exec_time / 1000)}s total${row.stddev_exec_time > row.mean_exec_time ? " (erratic plan — high stddev)" : ""}`;
  const evidence = [
    `Query (pg_stat_statements ${row.queryid}):`,
    "```sql",
    shortQuery(row.query, 800),
    "```",
    `Stats: calls=${row.calls}, mean=${Math.round(row.mean_exec_time)}ms, total=${Math.round(row.total_exec_time)}ms, stddev=${Math.round(row.stddev_exec_time)}ms, rows=${row.rows}`,
    ``,
    `EXPLAIN:`,
    "```",
    planBlock,
    "```",
    ``,
    `Diagnosed cause: ${cause} — ${hint}`,
  ].join("\n");

  return {
    signature,
    category: "slow_query",
    cause,
    fixKind,
    table: table || "(query)",
    title: `Slow query ${row.queryid}${table ? ` on ${table}` : ""} — ${cause.replace(/_/g, " ")}`,
    impact,
    score: row.total_exec_time,
    evidence,
    specSlug: slugFor(fixKind, table || `q${row.queryid}`),
    specTitle: specTitleFor(cause, table || `query ${row.queryid}`, hint),
  };
}

// ── Size / growth classification ─────────────────────────────────────────────

/**
 * Compute growth findings from the latest snapshot + a prior snapshot ~a day earlier, keyed by
 * table. Flags a sizeable table that grew ≥ GROWTH_FLAG_FRACTION day-over-day with no retention
 * allowlist entry — the loop_heartbeats class (append-only, oldest row keeps receding). When there
 * is no prior snapshot yet (first run), nothing is flagged (no rate to compute) — honest, not a
 * false alarm.
 */
export function analyzeGrowth(latest: TableSizeRow[], prior: TableSizeRow[]): DbHealthFinding[] {
  const priorBy = new Map(prior.map((r) => [r.table_name, r]));
  const out: DbHealthFinding[] = [];
  for (const cur of latest) {
    if (cur.total_bytes < SIZE_MIN_BYTES) continue;
    if (RETENTION_AWARE_TABLES.includes(cur.table_name)) continue;
    if (isAllowlisted(cur.table_name, DB_HEALTH_SUNSET_ALLOWLIST)) continue; // sunset table — don't tune what we're turning off
    const was = priorBy.get(cur.table_name);
    if (!was || was.total_bytes <= 0) continue;
    const frac = (cur.total_bytes - was.total_bytes) / was.total_bytes;
    if (frac < GROWTH_FLAG_FRACTION) continue;
    const rowDelta = cur.row_estimate - was.row_estimate;
    const signature = `dbhealth:growth:${cur.table_name}`;
    const impact = `+${pct(frac)} day-over-day (${humanBytes(was.total_bytes)} → ${humanBytes(cur.total_bytes)}, +${rowDelta.toLocaleString()} rows)`;
    out.push({
      signature,
      category: "growth",
      cause: "unbounded_growth",
      fixKind: "retention_cron",
      table: cur.table_name,
      title: `${cur.table_name} growing unbounded — +${pct(frac)}/day`,
      impact,
      score: cur.total_bytes * (1 + frac),
      evidence: [
        `Table: ${cur.table_name}`,
        `Size: ${humanBytes(was.total_bytes)} → ${humanBytes(cur.total_bytes)} (+${pct(frac)} in ~1 day)`,
        `Rows: ${was.row_estimate.toLocaleString()} → ${cur.row_estimate.toLocaleString()} (+${rowDelta.toLocaleString()})`,
        `No retention cron is known for this table (not in RETENTION_AWARE_TABLES). Append-only growth at this rate has no natural ceiling — the loop_heartbeats 21.7M-row class.`,
      ].join("\n"),
      specSlug: slugFor("retention_cron", cur.table_name),
      specTitle: `Add a retention cron for ${cur.table_name} (unbounded growth)`,
    });
  }
  return out;
}

/**
 * Compute missing-index + unused-index findings from the per-table stats + the per-index stats.
 *   - missing_index: a big table with a high seq_scan SHARE (seq_scan / (seq_scan+idx_scan)) and a
 *     meaningful absolute seq_scan count → propose an index (the exact column comes from the slow
 *     query that hits it; here we flag the table + cite the scan ratio).
 *   - unused_index: a non-primary, non-unique index with idx_scan=0 and a real on-disk size → propose
 *     a drop (pure write overhead + bloat). Primary/unique indexes are never proposed for drop.
 */
export function analyzeIndexUsage(tables: TableSizeRow[], indexes: IndexStatRow[]): DbHealthFinding[] {
  const out: DbHealthFinding[] = [];
  for (const t of tables) {
    if (t.total_bytes < SIZE_MIN_BYTES) continue;
    if (isAllowlisted(t.table_name, DB_HEALTH_SUNSET_ALLOWLIST)) continue; // sunset table — skip
    const scans = t.seq_scan + t.idx_scan;
    if (scans <= 0) continue;
    const share = t.seq_scan / scans;
    if (share >= SEQ_SCAN_SHARE_FLAG && t.seq_scan >= SEQ_SCAN_MIN_ABS) {
      out.push({
        signature: `dbhealth:missing-index:${t.table_name}`,
        category: "index",
        cause: "missing_index",
        fixKind: "add_index",
        table: t.table_name,
        title: `${t.table_name} — ${pct(share)} of scans are seq scans (likely missing index)`,
        impact: `${pct(share)} seq-scan share over ${scans.toLocaleString()} scans (${t.seq_scan.toLocaleString()} seq / ${t.idx_scan.toLocaleString()} idx) on ${humanBytes(t.total_bytes)}`,
        score: t.total_bytes * share,
        evidence: [
          `Table: ${t.table_name} (${humanBytes(t.total_bytes)}, ~${t.row_estimate.toLocaleString()} rows)`,
          `Scans: ${t.seq_scan.toLocaleString()} seq vs ${t.idx_scan.toLocaleString()} idx → ${pct(share)} seq-scan share.`,
          `A large table read mostly by full scans is paying a missing-index tax. Correlate with the slow-query pass to get the exact predicate column for the index.`,
        ].join("\n"),
        specSlug: slugFor("add_index", t.table_name),
        specTitle: `Add an index to ${t.table_name} (high seq-scan share)`,
      });
    }
  }
  for (const ix of indexes) {
    if (isAllowlisted(ix.table_name, DB_HEALTH_SUNSET_ALLOWLIST)) continue; // sunset table — skip its indexes
    if (ix.is_primary || ix.is_unique) continue; // never propose dropping a PK / unique constraint index.
    if (ix.idx_scan > 0) continue;
    if (ix.index_bytes < UNUSED_INDEX_MIN_BYTES) continue;
    out.push({
      signature: `dbhealth:unused-index:${ix.index_name}`,
      category: "index",
      cause: "unused_index",
      fixKind: "drop_index",
      table: ix.index_name,
      title: `${ix.index_name} — never scanned (${humanBytes(ix.index_bytes)} of write overhead)`,
      impact: `idx_scan=0 on ${humanBytes(ix.index_bytes)} (table ${ix.table_name})`,
      score: ix.index_bytes,
      evidence: [
        `Index: ${ix.index_name} on ${ix.table_name}`,
        `Scans: idx_scan = 0 since the last stats reset; size = ${humanBytes(ix.index_bytes)}.`,
        `An index that is never read is pure write amplification + bloat. Confirm it isn't reserved for a constraint / a rare report before dropping (CONCURRENTLY).`,
      ].join("\n"),
      specSlug: slugFor("drop_index", ix.index_name),
      specTitle: `Drop the unused index ${ix.index_name}`,
    });
  }
  return out;
}

/**
 * Compute bloat findings: a big table with a high dead-tuple ratio whose autovacuum is stale → a
 * VACUUM / autovacuum-tuning proposal. (Phase 1 surfaces it; Phase 2 deepens the autovacuum-lag
 * trend per the spec.)
 */
export function analyzeBloat(tables: TableSizeRow[], now: number): DbHealthFinding[] {
  const out: DbHealthFinding[] = [];
  for (const t of tables) {
    if (t.total_bytes < SIZE_MIN_BYTES) continue;
    if (isAllowlisted(t.table_name, DB_HEALTH_SUNSET_ALLOWLIST)) continue; // sunset table — skip
    const total = t.n_live_tup + t.n_dead_tup;
    if (total <= 0) continue;
    const deadRatio = t.n_dead_tup / total;
    if (deadRatio < BLOAT_DEAD_RATIO_FLAG) continue;
    const lastVac = t.last_autovacuum ? Date.parse(t.last_autovacuum) : NaN;
    const stale = Number.isNaN(lastVac) || now - lastVac > BLOAT_AUTOVACUUM_STALE_MS;
    if (!stale) continue;
    out.push({
      signature: `dbhealth:bloat:${t.table_name}`,
      category: "bloat",
      cause: "bloat_vacuum_lag",
      fixKind: "vacuum_tuning",
      table: t.table_name,
      title: `${t.table_name} — ${pct(deadRatio)} dead tuples, autovacuum lagging`,
      impact: `${pct(deadRatio)} dead (${t.n_dead_tup.toLocaleString()} / ${total.toLocaleString()}), last autovacuum ${t.last_autovacuum ?? "never"}`,
      score: t.total_bytes * deadRatio,
      evidence: [
        `Table: ${t.table_name} (${humanBytes(t.total_bytes)})`,
        `Dead tuples: ${t.n_dead_tup.toLocaleString()} / ${total.toLocaleString()} = ${pct(deadRatio)}.`,
        `Last autovacuum: ${t.last_autovacuum ?? "never"} (stale). A bloated hot table slows every scan + wastes disk — propose a VACUUM (ANALYZE) + a per-table autovacuum_*_scale_factor tune.`,
      ].join("\n"),
      specSlug: slugFor("vacuum_tuning", t.table_name),
      specTitle: `Vacuum / autovacuum-tune ${t.table_name} (bloat)`,
    });
  }
  return out;
}

// ── Instance-health classification (db-health-instance-saturation-detector Phase 1) ─
//
// The per-query slow-query pass EXPLAINs each statement in isolation on an idle pooler connection,
// so it is BLIND to instance-level saturation — the class of miss that let the 2026-07-02 outage
// (86.8% DATABASE errors, 30 min of dashboard timeouts) go unflagged. This classifier reads the
// aggregate `pg_stat_database` counters + a `pg_stat_activity` probe + the per-role
// `statement_timeout` and emits findings that quote the real numbers as evidence — mirror
// analyzeBloat / analyzeSlowQuery so the operator sees the exact ratio/count that tripped the flag.
// PURE (no fs/pg/network) — the box reads the signals, this module classifies.

/** Optional threshold overrides — accepts a partial so callers only override what they need. */
export interface InstanceHealthThresholds {
  rollbackRatioFlag?: number;
  tempBytesWindowFlag?: number;
  tempBytesRateFlag?: number;
  cacheHitFloor?: number;
  connUtilFlag?: number;
  timeoutHeadroomFraction?: number;
}

/**
 * Classify instance-level saturation from the box's periodic pg_stat_database + pg_stat_activity
 * snapshot. Emits ≥0 `category:'instance'` findings. Each finding QUOTES the offending numbers in
 * the evidence string (rollback ratio × commit/rollback counts, temp_bytes × temp_files,
 * cache-hit ratio × blks_hit/blks_read, connection util × active+waiting/max_connections, the
 * `authenticated` statement_timeout ceiling) so the operator can verify the diagnosis without a
 * separate DB probe. Order is deterministic (timeout → temp → rollback → cache → connection) so a
 * dedup collapse under `dedupeFindings` is stable across passes.
 */
export function analyzeInstanceHealth(
  input: InstanceHealthInput,
  thresholds: InstanceHealthThresholds = {},
): DbHealthFinding[] {
  const rollbackFlag = thresholds.rollbackRatioFlag ?? INSTANCE_ROLLBACK_RATIO_FLAG;
  const tempFlag = thresholds.tempBytesWindowFlag ?? INSTANCE_TEMP_BYTES_WINDOW_FLAG;
  const tempRateFlag = thresholds.tempBytesRateFlag ?? INSTANCE_TEMP_BYTES_RATE_FLAG;
  const cacheFloor = thresholds.cacheHitFloor ?? INSTANCE_CACHE_HIT_FLOOR;
  const connFlag = thresholds.connUtilFlag ?? INSTANCE_CONN_UTIL_FLAG;
  const timeoutHeadroom = thresholds.timeoutHeadroomFraction ?? INSTANCE_TIMEOUT_HEADROOM_FRACTION;

  const findings: DbHealthFinding[] = [];
  const totalXact = input.xactCommit + input.xactRollback;
  const rollbackRatio = totalXact > 0 ? input.xactRollback / totalXact : 0;
  const totalBlks = input.blksHit + input.blksRead;
  const cacheHitRatio = totalBlks > 0 ? input.blksHit / totalBlks : 1; // 0 reads ⇒ effectively 100% (nothing to miss)
  const connUtil = input.maxConnections > 0 ? (input.activeBackends + input.waitingBackends) / input.maxConnections : 0;
  const timeoutSecs = input.authenticatedStatementTimeoutMs != null ? input.authenticatedStatementTimeoutMs / 1000 : null;

  // 1) statement_timeout_pressure — live queries running past a big fraction of the `authenticated`
  //    ceiling. This fires BEFORE the rollback lands, so an operator sees the pressure early.
  //    db-investigate-timeouts-instance: when the box captured OFFENDER samples out of
  //    pg_stat_activity, name them in the evidence — the operator can route the offender to the
  //    right slow-query fix without a separate probe. Filtered at the SQL layer to `authenticated`
  //    (only queries under that role are subject to the 8s ceiling).
  if (input.statementsNearTimeout > 0 && input.authenticatedStatementTimeoutMs != null) {
    const impact = `${input.statementsNearTimeout} live query(ies) past ${pct(timeoutHeadroom)} of the ${timeoutSecs}s \`authenticated\` statement_timeout — about to be killed`;
    const samples = (input.nearTimeoutSamples ?? []).slice(0, 3);
    const sampleLines = samples.length > 0
      ? [
          `Near-timeout offender${samples.length === 1 ? "" : "s"} (from pg_stat_activity, \`authenticated\` role only):`,
          ...samples.map((s) => `  - ${s.durationSec}s — \`${previewQuery(s.query)}\``),
        ]
      : [];
    findings.push({
      signature: `dbhealth:instance:statement_timeout_pressure`,
      category: "instance",
      cause: "statement_timeout_pressure",
      fixKind: "investigate_timeouts",
      table: "(instance)",
      title: `Live queries approaching the ${timeoutSecs}s statement_timeout ceiling`,
      impact,
      score: input.statementsNearTimeout * 1_000_000, // rank ahead of temp/rollback — this is an active kill signal
      evidence: [
        `Per-role \`authenticated\` \`statement_timeout\` = ${input.authenticatedStatementTimeoutMs} ms (${timeoutSecs}s) — queries exceeding this are killed.`,
        `Live queries past ${pct(timeoutHeadroom)} of the ceiling: ${input.statementsNearTimeout}.`,
        ...sampleLines,
        `Rollback ratio (context): ${pct(rollbackRatio)} of ${totalXact.toLocaleString()} transactions (${input.xactRollback.toLocaleString()} rolled back).`,
        `This is the 2026-07-02-class signal: queries running under load hit the ${timeoutSecs}s ceiling and roll back — the per-query slow-query pass EXPLAINs each statement in isolation on an idle pooler connection so it never sees this.`,
      ].join("\n"),
      specSlug: slugFor("investigate_timeouts", "instance"),
      specTitle: specTitleFor("statement_timeout_pressure", "the instance", `${input.statementsNearTimeout} live queries past ${pct(timeoutHeadroom)} of the ${timeoutSecs}s ceiling`),
    });
  }

  // 2) temp_spill_pressure — cumulative temp_bytes crossed the window flag (883 GB in the incident).
  //    Hash/sort work_mem is spilling to disk on every heavy query, dragging the whole instance.
  //    db-health-temp-spill-attribution (2026-07-08): pg_stat_database.temp_bytes is an instance
  //    aggregate with NO query attribution, so the previous pass could only propose a generic
  //    `raise_work_mem` bump — and a single unindexed disk-sort (the subscriptions LTV scan: 314 GB,
  //    98% of all spill) hid inside the aggregate for a week. When the box captured the top
  //    temp_blks_written offenders, NAME them and point the fix at the dominant spiller (an
  //    index/rewrite at the source, not a blanket work_mem bump).
  // db-health-temp-spill-rate: prefer the RATE (Δtemp_bytes / Δhours since the prior pass) so the
  // finding SELF-CLEARS once the spill stops — the cumulative counter can't be reset (Supabase's
  // postgres role isn't superuser). Fall back to the cumulative flag only when there's no prior
  // reading to rate against (first pass / unreadable prior), which preserves acute-incident detection.
  const haveTempRate = input.tempBytesPrev != null && (input.tempReadingAgeHours ?? 0) > 0;
  const tempDelta = haveTempRate ? Math.max(0, input.tempBytes - (input.tempBytesPrev as number)) : 0;
  const tempRatePerHr = haveTempRate ? tempDelta / (input.tempReadingAgeHours as number) : 0;
  const tempTripped = haveTempRate ? tempRatePerHr >= tempRateFlag : input.tempBytes >= tempFlag;
  if (tempTripped) {
    const ageH = (input.tempReadingAgeHours as number) ?? 0;
    const impact = haveTempRate
      ? `spilling ${humanBytes(tempRatePerHr)}/hr to temp files (${humanBytes(tempDelta)} in the last ${ageH.toFixed(1)}h; ${input.tempFiles.toLocaleString()} files cumulative) — hash/sort work_mem is undersized`
      : `${humanBytes(input.tempBytes)} spilled to temp files (${input.tempFiles.toLocaleString()} files) — hash/sort work_mem is undersized`;
    const offenders = (input.tempOffenders ?? []).filter((o) => o.tempBytes > 0).slice(0, 5);
    const dominant = offenders[0];
    const offenderLines = offenders.length > 0
      ? [
          ``,
          `Top temp-spill offenders (pg_stat_statements by temp_blks_written — the per-query attribution pg_stat_database cannot give):`,
          ...offenders.map(
            (o) => `  - ${humanBytes(o.tempBytes)} over ${o.calls.toLocaleString()} calls${isInfrastructuralQuery(o.query) ? " [infrastructural]" : ""} — \`${previewQuery(o.query)}\``,
          ),
          dominant && !isInfrastructuralQuery(dominant.query)
            ? `The dominant spiller (queryid ${dominant.queryid}) is an APP query — an index on its ORDER BY / GROUP BY, or a rewrite into a set-returning/aggregate RPC, eliminates the spill AT THE SOURCE. A work_mem bump is the fallback, not the fix.`
            : `Confirm the dominant spiller's plan (a Sort/Hash reporting \`external merge\` / \`Disk: NkB\`) before proposing a work_mem bump — an index on the sort/group key is often the cheaper win.`,
        ]
      : [];
    const spillEvidenceLine = haveTempRate
      ? `Spill RATE: ${humanBytes(tempRatePerHr)}/hr (Δ ${humanBytes(tempDelta)} over ${ageH.toFixed(1)}h since the prior pass) — rate flag ${humanBytes(tempRateFlag)}/hr. pg_stat_database.temp_bytes is ${humanBytes(input.tempBytes)} cumulative, but it can't be reset without superuser, so the RATE is the self-clearing signal.`
      : `pg_stat_database.temp_bytes: ${humanBytes(input.tempBytes)} (${input.tempBytes.toLocaleString()} bytes) — cumulative window flag is ${humanBytes(tempFlag)} (no prior reading to compute a rate; cumulative fallback).`;
    findings.push({
      signature: `dbhealth:instance:temp_spill_pressure`,
      category: "instance",
      cause: "temp_spill_pressure",
      fixKind: "raise_work_mem",
      table: "(instance)",
      title: haveTempRate
        ? `Temp-spill pressure — ${humanBytes(tempRatePerHr)}/hr spilling`
        : `Temp-spill pressure — ${humanBytes(input.tempBytes)} across ${input.tempFiles.toLocaleString()} files`,
      impact,
      score: haveTempRate ? tempRatePerHr : input.tempBytes,
      evidence: [
        `pg_stat_database.temp_files: ${input.tempFiles.toLocaleString()} on-disk temp files (cumulative).`,
        spillEvidenceLine,
        `The 2026-07-02 incident hit ${humanBytes(883 * 1024 * 1024 * 1024)} across 92,832 files — the operator-visible signature of an undersized work_mem: every hash/sort >work_mem spills, dragging every heavy query.`,
        ...offenderLines,
      ].join("\n"),
      specSlug: slugFor("raise_work_mem", "instance"),
      specTitle: specTitleFor("temp_spill_pressure", "the instance", impact),
    });
  }

  // 3) rollback_error_rate — a systemic rollback ratio. Not a slow-query problem (a single bad
  //    query wouldn't move the aggregate ratio); either the timeout is catching everyone or the app
  //    is fighting itself (deadlocks).
  if (totalXact > 0 && rollbackRatio >= rollbackFlag) {
    const impact = `${pct(rollbackRatio)} of ${totalXact.toLocaleString()} transactions rolled back (${input.xactRollback.toLocaleString()} rollbacks, ${input.deadlocks.toLocaleString()} deadlocks)`;
    findings.push({
      signature: `dbhealth:instance:rollback_error_rate`,
      category: "instance",
      cause: "rollback_error_rate",
      fixKind: "investigate_timeouts",
      table: "(instance)",
      title: `Rollback rate ${pct(rollbackRatio)} — instance under duress`,
      impact,
      score: rollbackRatio * 100_000,
      evidence: [
        `pg_stat_database counters: xact_commit=${input.xactCommit.toLocaleString()}, xact_rollback=${input.xactRollback.toLocaleString()} → rollback ratio ${pct(rollbackRatio)} (flag ≥ ${pct(rollbackFlag)}).`,
        `Deadlocks: ${input.deadlocks.toLocaleString()}.`,
        input.authenticatedStatementTimeoutMs != null
          ? `Per-role \`authenticated\` \`statement_timeout\` = ${timeoutSecs}s — this ceiling kills a query into a rollback under load, the leading suspect when the ratio spikes.`
          : `No per-role statement_timeout set on the \`authenticated\` role — investigate client-side aborts / deadlocks first.`,
        `A single slow query can't move the aggregate ratio; a ${pct(rollbackRatio)} rollback rate is a systemic signal — the 2026-07-02 incident hit 7.43% while dashboards were timing out.`,
      ].join("\n"),
      specSlug: slugFor("investigate_timeouts", "instance-rollback"),
      specTitle: specTitleFor("rollback_error_rate", "the instance", `${pct(rollbackRatio)} rollback ratio over ${totalXact.toLocaleString()} transactions`),
    });
  }

  // 4) cache_pressure — the working set has outgrown shared_buffers (memory tier problem).
  if (totalBlks > 0 && cacheHitRatio < cacheFloor) {
    const impact = `${pct(cacheHitRatio)} cache-hit ratio (${input.blksHit.toLocaleString()} hits / ${input.blksRead.toLocaleString()} disk reads) — working set is spilling out of shared_buffers`;
    findings.push({
      signature: `dbhealth:instance:cache_pressure`,
      category: "instance",
      cause: "cache_pressure",
      fixKind: "raise_compute",
      table: "(instance)",
      title: `Cache-hit ratio ${pct(cacheHitRatio)} — memory tier undersized`,
      impact,
      score: (cacheFloor - cacheHitRatio) * 10_000,
      evidence: [
        `pg_stat_database: blks_hit=${input.blksHit.toLocaleString()}, blks_read=${input.blksRead.toLocaleString()} → cache-hit ratio ${pct(cacheHitRatio)} (floor ${pct(cacheFloor)}).`,
        `A cache-hit ratio below the floor means the hot working set no longer fits in shared_buffers; every miss is a disk read that competes for the same latency budget the statement_timeout enforces.`,
        `The 2026-07-02 incident showed 0.9869 under load — right below the floor — while MEMORY hit 79% and dashboards timed out.`,
      ].join("\n"),
      specSlug: slugFor("raise_compute", "instance-cache"),
      specTitle: specTitleFor("cache_pressure", "the instance", `${pct(cacheHitRatio)} cache-hit ratio`),
    });
  }

  // 5) connection_saturation — active+waiting eating a big fraction of max_connections. Not enough
  //    slack to accept the next session; new REST requests will queue or error before running.
  if (input.maxConnections > 0 && connUtil >= connFlag) {
    const impact = `${pct(connUtil)} of max_connections in use (${input.activeBackends.toLocaleString()} active + ${input.waitingBackends.toLocaleString()} waiting / ${input.maxConnections.toLocaleString()} max)`;
    findings.push({
      signature: `dbhealth:instance:connection_saturation`,
      category: "instance",
      cause: "connection_saturation",
      fixKind: "raise_compute",
      table: "(instance)",
      title: `Connection saturation — ${pct(connUtil)} of max_connections`,
      impact,
      score: connUtil * 10_000,
      evidence: [
        `pg_stat_activity: ${input.activeBackends.toLocaleString()} active + ${input.waitingBackends.toLocaleString()} waiting = ${(input.activeBackends + input.waitingBackends).toLocaleString()} of ${input.maxConnections.toLocaleString()} max_connections → ${pct(connUtil)} utilization (flag ≥ ${pct(connFlag)}).`,
        `At this utilization, new sessions queue at the pooler or fail to connect — a client-visible symptom (the "DATABASE errors" class on Observability).`,
      ].join("\n"),
      specSlug: slugFor("raise_compute", "instance-connections"),
      specTitle: specTitleFor("connection_saturation", "the instance", `${pct(connUtil)} of max_connections in use`),
    });
  }

  return findings;
}

// ── Request-volume / egress escalation (db-health-request-volume, 2026-07-08) ──

/** One top pg_stat_statements row for the request-volume escalation (by calls or by rows shipped). */
export interface RequestVolumeTopQuery {
  queryid: string;
  query: string;
  calls: number;
  /** Total rows this query returned to clients over the window (pg_stat_statements.rows) — the egress proxy. */
  rows: number;
}

/**
 * Aggregate request-volume signals for the window (from pg_stat_statements + pg_stat_statements_info).
 * Everything is over the SAME window (since the last stats reset).
 */
export interface RequestVolumeInput {
  /** Hours since the stats window reset (pg_stat_statements_info.stats_reset → now). */
  windowHours: number;
  /** sum(calls) over pg_stat_statements — total statements in the window. */
  totalCalls: number;
  /** sum(rows) over pg_stat_statements — total rows shipped to clients (egress proxy). */
  totalRows: number;
  /** Top statements by call count (the request firehose). */
  topByCalls: RequestVolumeTopQuery[];
  /** Top statements by rows returned (the egress firehose). */
  topByRows: RequestVolumeTopQuery[];
}

export interface RequestVolumeThresholds {
  callsPerHrFlag?: number;
  rowsPerHrFlag?: number;
  minWindowHours?: number;
}

/**
 * Flag an aggregate request-VOLUME / egress firehose — the blind spot that let ~78K PostgREST req/hr +
 * ~182K rows/hr (the box worker + dashboards polling; the 8M-call auth preamble is the tell) drive egress
 * with no Devi signal. This is NOT a per-query problem (no single index fixes it) — it's an ESCALATION
 * that names the top internal callers so the owner cuts the volume upstream (cache / batch / widen the
 * poll interval / reuse connections / replace a row-shipping read with an aggregate RPC). Returns null
 * when the window is too short to trust the rate, or the rate is under both flags. Pure + deterministic.
 */
export function analyzeRequestVolume(
  input: RequestVolumeInput,
  thresholds: RequestVolumeThresholds = {},
): DbHealthFinding | null {
  const callsFlag = thresholds.callsPerHrFlag ?? REQUEST_VOLUME_CALLS_PER_HR_FLAG;
  const rowsFlag = thresholds.rowsPerHrFlag ?? REQUEST_VOLUME_ROWS_PER_HR_FLAG;
  const minWindow = thresholds.minWindowHours ?? REQUEST_VOLUME_MIN_WINDOW_HOURS;
  if (!(input.windowHours >= minWindow)) return null; // too-short window ⇒ noisy rate, skip honestly

  const callsPerHr = input.totalCalls / input.windowHours;
  const rowsPerHr = input.totalRows / input.windowHours;
  const callsOver = callsPerHr >= callsFlag;
  const rowsOver = rowsPerHr >= rowsFlag;
  if (!callsOver && !rowsOver) return null;

  const fmtRate = (n: number) => Math.round(n).toLocaleString();
  const share = (n: number, total: number) => (total > 0 ? pct(n / total) : "0%");
  const topCalls = input.topByCalls.slice(0, 8);
  const topRows = input.topByRows.slice(0, 8);
  // An infrastructural caller (the auth preamble) can't be spec-fixed directly, but naming it explains
  // the volume; an app caller in the top list IS the actionable lever.
  const label = (q: RequestVolumeTopQuery) => isInfrastructuralQuery(q.query) ? " [infrastructural]" : "";

  const impact =
    `${fmtRate(callsPerHr)} req/hr` + (callsOver ? ` (≥ ${callsFlag.toLocaleString()} flag)` : "") +
    ` · ${fmtRate(rowsPerHr)} rows/hr shipped` + (rowsOver ? ` (≥ ${rowsFlag.toLocaleString()} flag)` : "") +
    ` over a ${input.windowHours.toFixed(1)}h window`;

  const evidence = [
    `Window: ${input.windowHours.toFixed(1)}h (since the last pg_stat_statements reset).`,
    `Totals: ${input.totalCalls.toLocaleString()} statements (${fmtRate(callsPerHr)}/hr${callsOver ? ` — ≥ ${callsFlag.toLocaleString()}/hr flag` : ""}), ${input.totalRows.toLocaleString()} rows shipped (${fmtRate(rowsPerHr)}/hr${rowsOver ? ` — ≥ ${rowsFlag.toLocaleString()}/hr flag` : ""}).`,
    `Rows shipped to clients is the egress proxy — most PostgREST/Supabase billing is metered on it.`,
    ``,
    `Top callers by request count:`,
    ...topCalls.map((q) => `  - ${q.calls.toLocaleString()} calls (${share(q.calls, input.totalCalls)} of all)${label(q)} — \`${previewQuery(q.query)}\``),
    ``,
    `Top callers by rows shipped (egress):`,
    ...topRows.map((q) => `  - ${q.rows.toLocaleString()} rows (${share(q.rows, input.totalRows)} of all) over ${q.calls.toLocaleString()} calls${label(q)} — \`${previewQuery(q.query)}\``),
    ``,
    `This is an aggregate VOLUME signal, not a per-query cost problem — a single index won't move it. Cut the volume at the source: widen poll intervals on internal loops, cache/batch hot reads, reuse authenticated connections (a burst of distinct auth sessions is the "connections aren't pooled" tell), and replace row-shipping reads with aggregate RPCs.`,
  ].join("\n");

  return {
    signature: `dbhealth:request-volume:instance`,
    category: "slow_query",
    cause: "request_volume_pressure",
    fixKind: "reduce_calls",
    table: "(instance)",
    title: `Request-volume / egress firehose — ${fmtRate(callsPerHr)} req/hr, ${fmtRate(rowsPerHr)} rows/hr`,
    impact,
    // Rank below active incidents (temp/timeout/rollback score in the millions) but above routine
    // slow-query findings — it's a standing cost signal, not a live outage.
    score: Math.max(callsPerHr, rowsPerHr),
    evidence,
    specSlug: slugFor("reduce_calls", "request-volume"),
    specTitle: specTitleFor("request_volume_pressure", "the instance", impact),
  };
}

// ── Phase 2 — trend projection (growth-to-ceiling + autovacuum-lag trend) ─────
//
// The Phase-1 detectors look at the latest reading (analyzeBloat) or a single day-over-day delta
// (analyzeGrowth). Those catch a *spike* but miss a steady climb under the 25%/day spike threshold,
// and they only see bloat once it's already past 20%. Phase 2 uses the whole db_table_size_history
// window: fit a line through the per-table series and project it forward. A growth trend that crosses
// a size ceiling within N days → a retention proposal; a dead-tuple ratio that is RISING across the
// window while autovacuum isn't keeping up → a vacuum proposal. Both reuse the Phase-1 signatures
// (`dbhealth:growth:<table>` / `dbhealth:bloat:<table>`) so dedupeFindings collapses a spike + a trend
// for the same table into ONE proposal (same fix) — never two cards for one table.

const DAY_MS = 24 * 60 * 60 * 1000;

interface TableSeries {
  table: string;
  /** snapshots oldest→newest, with `t` = days since the first snapshot. */
  points: Array<{ t: number; row: TableSizeRow }>;
}

/** Group a flat history window into per-table series (oldest→newest), x = days since the first point. */
function groupSeries(history: TableSizeRow[]): TableSeries[] {
  const byTable = new Map<string, TableSizeRow[]>();
  for (const r of history) {
    if (!r.captured_at) continue;
    const arr = byTable.get(r.table_name);
    if (arr) arr.push(r);
    else byTable.set(r.table_name, [r]);
  }
  const out: TableSeries[] = [];
  for (const [table, rows] of byTable) {
    const sorted = [...rows].sort((a, b) => Date.parse(a.captured_at!) - Date.parse(b.captured_at!));
    const t0 = Date.parse(sorted[0].captured_at!);
    out.push({ table, points: sorted.map((row) => ({ t: (Date.parse(row.captured_at!) - t0) / DAY_MS, row })) });
  }
  return out;
}

/** Ordinary least-squares fit of y over x. Returns slope (per unit x) + intercept; slope 0 if degenerate. */
export function linearFit(points: Array<{ x: number; y: number }>): { slope: number; intercept: number } {
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

function deadRatio(r: TableSizeRow): number {
  const tot = r.n_live_tup + r.n_dead_tup;
  return tot > 0 ? r.n_dead_tup / tot : 0;
}

/** Render a few series points (oldest, middle, newest) for the spec evidence — show the trend, don't assert it. */
function sampleSeriesLines(points: TableSeries["points"], render: (r: TableSizeRow) => string): string[] {
  const idxs = points.length <= 4 ? points.map((_, i) => i) : [0, Math.floor(points.length / 2), points.length - 1];
  const seen = new Set<number>();
  return idxs
    .filter((i) => !seen.has(i) && seen.add(i))
    .map((i) => `  ${points[i].row.captured_at ?? "?"}: ${render(points[i].row)}`);
}

/**
 * GROWTH TREND: fit each big table's size series and flag the ones projected to cross
 * GROWTH_TREND_CEILING_BYTES within GROWTH_TREND_HORIZON_DAYS — a steady climb the day-over-day spike
 * check (analyzeGrowth, +25%/day) misses. Reuses the `dbhealth:growth:<table>` signature so a table
 * that ALSO tripped the spike check dedupes to one retention proposal. Honest: a table without enough
 * snapshots, with a flat/negative slope, or whose projection lands beyond the horizon is not flagged.
 */
export function analyzeGrowthTrend(history: TableSizeRow[], now: number): DbHealthFinding[] {
  void now;
  const out: DbHealthFinding[] = [];
  for (const { table, points } of groupSeries(history)) {
    if (points.length < TREND_MIN_POINTS) continue;
    const span = points[points.length - 1].t - points[0].t;
    if (span < TREND_MIN_SPAN_DAYS) continue;
    if (RETENTION_AWARE_TABLES.includes(table)) continue;
    if (isAllowlisted(table, DB_HEALTH_SUNSET_ALLOWLIST)) continue; // sunset table — don't tune what we're turning off
    const latest = points[points.length - 1].row;
    if (latest.total_bytes < SIZE_MIN_BYTES) continue;
    const fit = linearFit(points.map((p) => ({ x: p.t, y: p.row.total_bytes })));
    if (fit.slope <= 0) continue; // flat or shrinking — no projection to make
    const bytesPerDay = fit.slope;
    const cur = latest.total_bytes;
    const daysToCeiling = cur >= GROWTH_TREND_CEILING_BYTES ? 0 : (GROWTH_TREND_CEILING_BYTES - cur) / bytesPerDay;
    if (daysToCeiling > GROWTH_TREND_HORIZON_DAYS) continue; // not on track to cross the ceiling within the horizon
    const projected = cur + bytesPerDay * GROWTH_TREND_HORIZON_DAYS;
    const reach =
      daysToCeiling <= 0
        ? `already past ${humanBytes(GROWTH_TREND_CEILING_BYTES)} and still climbing`
        : `reaches ${humanBytes(GROWTH_TREND_CEILING_BYTES)} in ~${Math.round(daysToCeiling)}d`;
    const impact = `+${humanBytes(bytesPerDay)}/day trend over ${points.length} snapshots / ${span.toFixed(1)}d → ${reach} (now ${humanBytes(cur)}, ~${humanBytes(projected)} projected in ${GROWTH_TREND_HORIZON_DAYS}d)`;
    out.push({
      signature: `dbhealth:growth:${table}`,
      category: "growth",
      cause: "unbounded_growth",
      fixKind: "retention_cron",
      table,
      title: `${table} on a growth trend — ${reach}`,
      impact,
      score: projected,
      evidence: [
        `Table: ${table}`,
        `Trend: ${humanBytes(bytesPerDay)}/day (least-squares fit over ${points.length} snapshots spanning ${span.toFixed(1)} days).`,
        `Now ${humanBytes(cur)}; projected ~${humanBytes(projected)} in ${GROWTH_TREND_HORIZON_DAYS} days; ${reach} (ceiling ${humanBytes(GROWTH_TREND_CEILING_BYTES)}).`,
        `History (size):`,
        ...sampleSeriesLines(points, (r) => `${humanBytes(r.total_bytes)} (~${r.row_estimate.toLocaleString()} rows)`),
        `A steady climb under the +${pct(GROWTH_FLAG_FRACTION)}/day spike threshold still has no natural ceiling — the loop_heartbeats class, caught from the trend before it's a crisis.`,
      ].join("\n"),
      specSlug: slugFor("retention_cron", table),
      specTitle: `Add a retention cron for ${table} (growth trend → ${humanBytes(GROWTH_TREND_CEILING_BYTES)})`,
    });
  }
  return out;
}

/**
 * BLOAT / AUTOVACUUM-LAG TREND: flag a big table whose dead-tuple ratio is RISING across the window
 * (≥ BLOAT_TREND_RISE) and is now ≥ BLOAT_TREND_MIN_RATIO, while autovacuum isn't keeping up (its
 * last_autovacuum hasn't advanced across the window, or is stale). This catches a slowly-bloating hot
 * table BEFORE it crosses the single-snapshot 20% flag (analyzeBloat). If autovacuum DID fire and
 * isn't stale, a transient ratio rise is churn it's handling — not flagged. Reuses the
 * `dbhealth:bloat:<table>` signature so it dedupes with the single-snapshot bloat finding.
 */
export function analyzeBloatTrend(history: TableSizeRow[], now: number): DbHealthFinding[] {
  const out: DbHealthFinding[] = [];
  for (const { table, points } of groupSeries(history)) {
    if (points.length < TREND_MIN_POINTS) continue;
    if (isAllowlisted(table, DB_HEALTH_SUNSET_ALLOWLIST)) continue; // sunset table — skip
    const latest = points[points.length - 1].row;
    const earliest = points[0].row;
    if (latest.total_bytes < SIZE_MIN_BYTES) continue;
    const latestRatio = deadRatio(latest);
    const earliestRatio = deadRatio(earliest);
    if (latestRatio < BLOAT_TREND_MIN_RATIO) continue; // not yet meaningfully bloated
    if (latestRatio - earliestRatio < BLOAT_TREND_RISE) continue; // not actually worsening
    const latestVac = latest.last_autovacuum ? Date.parse(latest.last_autovacuum) : NaN;
    const earliestVac = earliest.last_autovacuum ? Date.parse(earliest.last_autovacuum) : NaN;
    const vacAdvanced = !Number.isNaN(latestVac) && (Number.isNaN(earliestVac) || latestVac > earliestVac);
    const stale = Number.isNaN(latestVac) || now - latestVac > BLOAT_AUTOVACUUM_STALE_MS;
    if (vacAdvanced && !stale) continue; // autovacuum is keeping up — the rise is churn it's handling
    const span = points[points.length - 1].t - points[0].t;
    out.push({
      signature: `dbhealth:bloat:${table}`,
      category: "bloat",
      cause: "bloat_vacuum_lag",
      fixKind: "vacuum_tuning",
      table,
      title: `${table} — dead tuples climbing ${pct(earliestRatio)} → ${pct(latestRatio)}, autovacuum not keeping up`,
      impact: `dead ratio ${pct(earliestRatio)} → ${pct(latestRatio)} over ${span.toFixed(1)}d, last autovacuum ${latest.last_autovacuum ?? "never"}`,
      score: latest.total_bytes * latestRatio,
      evidence: [
        `Table: ${table} (${humanBytes(latest.total_bytes)})`,
        `Dead-tuple ratio is RISING: ${pct(earliestRatio)} → ${pct(latestRatio)} over ${points.length} snapshots / ${span.toFixed(1)} days.`,
        `Last autovacuum: ${latest.last_autovacuum ?? "never"} — ${vacAdvanced ? "advanced but still stale" : "has not advanced across the window"} (not keeping up with the churn).`,
        `History (dead ratio · last autovacuum):`,
        ...sampleSeriesLines(points, (r) => `${pct(deadRatio(r))} · ${r.last_autovacuum ?? "never"}`),
        `Caught from the trend before the single-snapshot ${pct(BLOAT_DEAD_RATIO_FLAG)} flag — propose a VACUUM (ANALYZE) + a tighter per-table autovacuum_vacuum_scale_factor so it doesn't recur. No data is deleted.`,
      ].join("\n"),
      specSlug: slugFor("vacuum_tuning", table),
      specTitle: `Vacuum / autovacuum-tune ${table} (rising bloat trend)`,
    });
  }
  return out;
}

// ── Ranking + dedup ──────────────────────────────────────────────────────────

/** Rank findings by impact score, descending (the panel + the enqueue order). */
export function rankFindings(findings: DbHealthFinding[]): DbHealthFinding[] {
  return [...findings].sort((a, b) => b.score - a.score);
}

/** Collapse findings that share a signature (keep the highest-scored). */
export function dedupeFindings(findings: DbHealthFinding[]): DbHealthFinding[] {
  const best = new Map<string, DbHealthFinding>();
  for (const f of findings) {
    const cur = best.get(f.signature);
    if (!cur || f.score > cur.score) best.set(f.signature, f);
  }
  return rankFindings([...best.values()]);
}

// ── Spec templating (the proposed fix, EXPLAIN evidence cited) ────────────────

/**
 * The single-phase fix spec the agent proposes (authored to docs/brain/specs on owner Build). The
 * cause-specific fix is spelled out + the EXPLAIN/stat evidence is quoted verbatim, so the owner sees
 * the reasoning — never just "this is slow". The spec is `⏳ planned`, owner platform; the build runs
 * through the normal pipeline once the owner taps Build.
 */
export function buildFixSpecMarkdown(finding: DbHealthFinding): string {
  const fixGuidance: Record<DbHealthFixKind, string> = {
    retention_cron: `Add a daily batched retention prune for \`${finding.table}\` (delete rows older than the agreed window in chunks), registered as its own heartbeating monitored loop so a dead pruner is visible — mirror [[loop-heartbeats-retention]]. Pick the window with the owner; never delete without that decision.`,
    add_index: `Add the index the diagnosed predicate needs with \`CREATE INDEX CONCURRENTLY\` (no write lock), in a migration + apply-script ([[../recipes/write-a-migration-apply-script]]). Confirm the exact column(s) from the EXPLAIN/slow-query evidence below; never add an index that already exists.`,
    drop_index: `Drop the unused index with \`DROP INDEX CONCURRENTLY\` in a migration. First confirm it backs no constraint and serves no rare report — an index drop is irreversible cheaply only in that it can be re-created, but the write-overhead it removes is the win.`,
    query_rewrite: `Rewrite the query to its diagnosed cause: bound the set (drive from a small list / add a LIMIT), add the predicate index, or restructure the aggregate. Land it where the query is issued + cite the before/after plan.`,
    reduce_calls: `This query is fast per call but HAMMERED — the win is fewer/cheaper calls, not a vacuum. Reduce how often it runs at the source (cache the result, batch, or widen the poll interval where the endpoint issues it), and/or add a hot-predicate index so each call is cheaper — a covering or partial index for the exact WHERE, or a **GIN index** if the predicate is an array/JSONB containment (\`@>\`). Cite the call count + mean from the evidence below; do NOT propose a VACUUM (the per-call time is already fine).`,
    vacuum_tuning: `Run a one-off \`VACUUM (ANALYZE)\` and set a tighter per-table \`autovacuum_vacuum_scale_factor\` so the bloat doesn't recur. No data is deleted.`,
    // Escalation-shaped fix kinds (db-health-instance-saturation-detector). These are the FALLBACK
    // — Phase 2 refines them further per-cause below via `instanceGuidanceByCause` so a
    // `cache_pressure` vs `connection_saturation` finding (both map to `raise_compute`) gets its own
    // advisory paragraph. Compute/timeout changes are HIGH-STAKES → owner-approval-only, never
    // auto-appliable (mirrors the DDL/delete stance in [[../operational-rules]] § North star).
    raise_compute: `**Owner-approval-only — instance-saturation signal, no auto-apply.** The evidence below points at compute/memory tier pressure, not a per-query fix. Evaluate raising the compute tier (or shared_buffers) rather than tuning a single query. The agent applies zero infra changes; a resize is an owner decision.`,
    raise_work_mem: `**Owner-approval-only — instance-saturation signal, no auto-apply.** Hash/sort spill to disk implicates \`work_mem\` (a per-connection setting). Do the per-connection math (\`max_connections × work_mem\` must fit in RAM alongside \`shared_buffers\`) BEFORE raising. The agent applies zero DB settings; a \`work_mem\` bump is an owner decision.`,
    investigate_timeouts: `**Owner-approval-only — instance-saturation signal, no auto-apply.** Rollback / timeout pressure means queries are being killed at the \`authenticated\` \`statement_timeout\` ceiling under load. Correlate with the slow-query pass's top offenders (\`DB_HEALTH_SLOWQ_LOOP_ID\` beats) and address the offenders rather than raising the ceiling. The agent applies zero query rewrites; the fix is an owner decision.`,
  };
  // Cause-specific advisory guidance for instance findings (Phase 2). Resolved BEFORE the fixKind
  // fallback so the operator sees language tied to the exact signal (statement_timeout / temp_spill /
  // rollback / cache / connection), not just the coarser fix kind. Every entry MUST include the
  // "owner-approval-only, no auto-apply" language + quote the evidence context verbatim.
  const instanceGuidanceByCause: Partial<Record<DbHealthCause, string>> = {
    statement_timeout_pressure: `**Owner-approval-only — instance-saturation signal, no auto-apply.** Live queries are running past ${pct(INSTANCE_TIMEOUT_HEADROOM_FRACTION)} of the \`authenticated\` \`statement_timeout\` ceiling — they will be KILLED under load, becoming rollbacks. Correlate with the top offenders from the slow-query pass (\`DB_HEALTH_SLOWQ_LOOP_ID\` beats) and fix those queries (index / rewrite / reduce calls) rather than raising the ceiling. Impact quoted verbatim from the evidence: **${finding.impact}**. The agent applies zero changes; the fix is an owner decision.`,
    temp_spill_pressure: `**Owner-approval-only — instance-saturation signal, no auto-apply.** Hash/sort operations are spilling to disk on the instance — every heavy query pays the temp-file cost. The lever is \`work_mem\` (a per-connection setting): raising it eats RAM per open session, so do the math \`max_connections × work_mem ≤ (RAM − shared_buffers − OS cache headroom)\` BEFORE proposing a bump. Confirm the top spillers via the slow-query pass (a Sort/Hash with \`Sort Method: external merge\` or \`Disk: NkB\`) — sometimes an index on the ORDER BY / GROUP BY is the cheaper win. Impact quoted verbatim from the evidence: **${finding.impact}**. The agent applies zero DB settings; the fix is an owner decision.`,
    rollback_error_rate: `**Owner-approval-only — instance-saturation signal, no auto-apply.** A high aggregate rollback ratio is a SYSTEMIC signal, not a per-query one — a single slow query can't move the aggregate. The two leading suspects (in order): (1) the \`authenticated\` \`statement_timeout\` ceiling is catching queries under load → address the top slow-query offenders; (2) the app is fighting itself (deadlocks) → check the \`deadlocks\` counter in the evidence and the concurrent-write hot spot. Do NOT raise the timeout ceiling as the reflex — it hides the real culprit. Impact quoted verbatim from the evidence: **${finding.impact}**. The agent applies zero changes; the fix is an owner decision.`,
    cache_pressure: `**Owner-approval-only — instance-saturation signal, no auto-apply.** The cache-hit ratio fell below the floor — the hot working set no longer fits in \`shared_buffers\`. Every miss is a disk read that competes for the same latency budget the \`statement_timeout\` enforces. The lever is compute tier (more RAM ⇒ larger \`shared_buffers\`), not a per-query fix. Confirm the working set has grown organically (not a runaway one-off scan) via the size sweep before proposing a tier bump. Impact quoted verbatim from the evidence: **${finding.impact}**. The agent applies zero infra changes; the fix is an owner decision.`,
    connection_saturation: `**Owner-approval-only — instance-saturation signal, no auto-apply.** Active + waiting backends are eating a big fraction of \`max_connections\`. At this utilization, new sessions queue at the pooler or fail to connect (the customer-visible "DATABASE errors" class). The lever is compute tier (more max_connections + RAM headroom) OR a pgBouncer-style layer for short-lived sessions. Check whether the culprit is a genuine traffic spike vs a leaked pool before proposing a resize. Impact quoted verbatim from the evidence: **${finding.impact}**. The agent applies zero infra changes; the fix is an owner decision.`,
    request_volume_pressure: `**Escalation — aggregate request-volume / egress, not a per-query fix.** The instance is serving a request/row-shipping firehose (mostly INTERNAL polling: the box worker + dashboards; the auth-preamble call count is the tell). No single index moves an aggregate volume signal. Work the TOP CALLERS named in the evidence, in order: (1) widen poll intervals on internal loops that don't need sub-minute freshness; (2) cache / batch hot reads; (3) reuse authenticated connections (a burst of distinct auth sessions = connections aren't pooled); (4) replace any row-shipping read (fetch-many-then-aggregate-in-JS) with an aggregate RPC that returns scalars. Rows-shipped/hr is the egress meter — attack the top rows-shipped callers first. Impact quoted verbatim from the evidence: **${finding.impact}**. The agent applies zero changes; cutting the volume is an owner decision.`,
  };
  const guidance = instanceGuidanceByCause[finding.cause] ?? fixGuidance[finding.fixKind];
  // dbhealth-spec-evidence-survives-parse: the markdown MUST follow the proven author-spec shape or the
  // parser mangles it — the INTENT paragraph FIRST (it, and only it, becomes `specs.summary`; a meta line
  // placed before it gets swallowed as the summary), then the Owner/Parent + meta lines, then a SINGLE
  // `## Phase 1` whose BODY carries the fix guidance + the EVIDENCE (as a `### Evidence` subsection — a
  // top-level `## Evidence` section survives in NEITHER the summary NOR a phase body, so Bo saw an empty
  // Evidence block and stalled needs_input). `### Verification` under the phase splits into the verification
  // column. Evidence is never blank (a fallback marks it unavailable rather than emitting a hollow section).
  const evidenceBlock = (finding.evidence || "").trim()
    || "(evidence unavailable — the slow-query pass captured no query text / EXPLAIN plan for this signature; confirm the offender from pg_stat_statements before building.)";
  return [
    `# ${finding.specTitle} ⏳`,
    ``,
    // Intent paragraph FIRST → becomes the summary (meta lines below can't be swallowed into it).
    `The DB Health Agent flagged this read-only and proposes the fix below. It applied **zero** DDL/deletes — the owner approves the build. Impact: ${finding.impact}.`,
    ``,
    // no-spec-parent: parent is the platform reliability MANDATE (a DB-health fix targets infra, not a spec).
    `**Owner:** [[../functions/platform]] · **Parent:** [[../functions/platform]] — "Infra & DevOps / reliability" mandate (owner-approval-only; the DB Health Agent surfaces reliability fixes, never auto-applies).`,
    `**DBHealth-signature:** \`${finding.signature}\``,
    `**DBHealth-fix:** \`${finding.fixKind}\``,
    `**Diagnosed cause:** \`${finding.cause}\` (${finding.category} pass) — a fix proposed by the [[../libraries/db-health|DB Health Agent]] ([[db-health-agent]]), surface-don't-apply.`,
    ``,
    `## Phase 1 — ${finding.fixKind.replace(/_/g, " ")} ⏳`,
    guidance,
    `Gate on \`npx tsc --noEmit\`; land the brain page in the same PR.`,
    ``,
    // Evidence lives INSIDE the phase body (a `### Evidence` subsection) so it survives the markdown→DB
    // round-trip — this is exactly what Bo reads to author the CREATE INDEX / query rewrite safely.
    `### Evidence`,
    evidenceBlock,
    ``,
    `### Verification`,
    `- Build + deploy the fix → on the DB Health Agent's next pass, this signature (\`${finding.signature}\`) is **no longer flagged** (the seq-scan share / growth rate / dead-tuple ratio / mean time drops below threshold), and no duplicate proposal is created.`,
    ``,
    `> Proposed by the box DB Health Agent (signature \`${finding.signature}\`, cause \`${finding.cause}\`). Commission the build from the Control Tower DB Health panel.`,
    ``,
  ].join("\n");
}

// ── One-line beat summaries ──────────────────────────────────────────────────

export function summarizeFindings(findings: DbHealthFinding[]): string {
  if (findings.length === 0) return "0 findings";
  const top = rankFindings(findings).slice(0, 3).map((f) => `${f.cause} ${f.table}`);
  return `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${top.join(", ")}${findings.length > 3 ? `, +${findings.length - 3} more` : ""}`;
}

// ── Surface: enqueue a deduped proposal (the box calls this per ranked finding) ──

/** Statuses that mean a db_health proposal for a signature is still "live" (don't re-propose). */
const LIVE_DBHEALTH_STATUSES = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume", "needs_attention"];
/** A built (non-dismissed) proposal within this window means the fix is in-flight/deploying — don't
 *  re-propose the same signature while the condition is resolving. */
export const DB_HEALTH_REPROPOSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function resolveDbHealthWorkspace(admin: Admin): Promise<string | null> {
  const { data: latestJob } = await admin
    .from("agent_jobs")
    .select("workspace_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromJob = (latestJob as { workspace_id?: string } | null)?.workspace_id;
  if (fromJob) return fromJob;
  const { data: ws } = await admin.from("workspaces").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
  return (ws as { id?: string } | null)?.id ?? null;
}

/**
 * Enqueue ONE db_health proposal for a finding, deduped by its signature. The proposal lands directly
 * in `needs_approval` (the diagnosis is deterministic — there's no LLM step to run, unlike repair):
 * it carries the pre-authored fix spec body in `instructions` + a `db_health_build` pending action
 * with the spec slug/title, so the Control Tower DB Health panel renders error→proposed-fix with a
 * Build button. On owner Build the box materializes the spec to main + queues the build (the
 * owner-gate). Best-effort + never throws — it rides the box's periodic pass.
 *
 * Dedup: skip if a live proposal for this signature already exists (the "no duplicate spec" guard),
 * OR a non-dismissed proposal for it was created within DB_HEALTH_REPROPOSE_WINDOW_MS (its fix is
 * in-flight/deploying — don't flap while the condition resolves).
 */
export async function enqueueDbHealthProposal(admin: Admin, finding: DbHealthFinding): Promise<{ enqueued: boolean; reason?: string }> {
  try {
    const { data: recent } = await admin
      .from("agent_jobs")
      .select("id, status, error, created_at")
      .eq("kind", "db_health")
      .eq("spec_slug", finding.signature)
      .order("created_at", { ascending: false })
      .limit(5);
    const rows = (recent ?? []) as Array<{ id: string; status: string; error: string | null; created_at: string }>;
    if (rows.some((r) => LIVE_DBHEALTH_STATUSES.includes(r.status))) {
      return { enqueued: false, reason: "live proposal exists for this signature" };
    }
    const windowStart = Date.now() - DB_HEALTH_REPROPOSE_WINDOW_MS;
    const recentlyBuilt = rows.some(
      (r) => r.status === "completed" && (r.error ?? "") !== "dismissed by owner" && Date.parse(r.created_at) >= windowStart,
    );
    if (recentlyBuilt) return { enqueued: false, reason: "fix recently built for this signature — deploying" };

    const workspaceId = await resolveDbHealthWorkspace(admin);
    if (!workspaceId) return { enqueued: false, reason: "no workspace to attach the proposal to" };

    const actionId = `dbh-${finding.signature.replace(/[^a-z0-9]+/gi, "-")}`.slice(0, 80);
    const specBody = buildFixSpecMarkdown(finding);
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: finding.signature,
      kind: "db_health",
      status: "needs_approval",
      log_tail: `${finding.title} · ${finding.impact}`.slice(-2000),
      // Panel-only metadata (title/impact/cause/…): a manual approval that overwrites this free-text field
      // only degrades the panel, never the build. The BUILD-CRITICAL diagnostic (`spec_body` + structured
      // `finding`) now lives on the un-clobberable `db_health_build` action below (which approve mutates by
      // STATUS only), so the owner-Build resume can always author — or re-render — a non-empty fix spec.
      // db-health-spec-body-robust.
      instructions: JSON.stringify({
        signature: finding.signature,
        category: finding.category,
        cause: finding.cause,
        fix_kind: finding.fixKind,
        table: finding.table,
        title: finding.title,
        impact: finding.impact,
        spec_slug: finding.specSlug,
        spec_title: finding.specTitle,
      }),
      pending_actions: [
        {
          id: actionId,
          type: "db_health_build",
          status: "pending",
          spec_slug: finding.specSlug,
          spec_title: finding.specTitle,
          // Un-clobberable diagnostic: the pre-rendered fix spec + the structured finding it re-renders
          // from if `spec_body` is ever empty. Never author an empty spec (db-health-spec-body-robust).
          spec_body: specBody,
          finding,
        },
      ],
    });
    if (error) return { enqueued: false, reason: error.message };
    return { enqueued: true };
  } catch (err) {
    console.warn("[db-health] enqueueDbHealthProposal threw:", err instanceof Error ? err.message : err);
    return { enqueued: false, reason: "threw" };
  }
}

// ── Surface: the read-only DB Health panel ────────────────────────────────────

export interface DbHealthProposalItem {
  jobId: string;
  signature: string;
  title: string;
  impact: string;
  cause: string;
  category: string;
  specSlug: string | null;
  specTitle: string | null;
  createdAt: string;
}

export interface DbHealthTopTable {
  table: string;
  totalBytes: number;
  rowEstimate: number;
}

export interface DbHealthSlowQuery {
  queryid: string;
  cause: string;
  table: string;
  impact: string;
}

export interface DbHealthPanel {
  /** the most recent size-sweep snapshot, top tables by size. */
  topTables: DbHealthTopTable[];
  /** the slowest queries from the latest slow-query pass beat. */
  slowQueries: DbHealthSlowQuery[];
  /** open proposals awaiting the owner (Build / Dismiss). */
  proposals: DbHealthProposalItem[];
  /** when each pass last ran (from the loop beats) — so a stale panel is honest. */
  lastSizeSweepAt: string | null;
  lastSlowQueryAt: string | null;
}

/**
 * READ-ONLY: the DB Health panel data for the Control Tower. Reads the latest size snapshot (top
 * tables), the latest slow-query pass beat (slowest queries + their diagnosed cause), and the open
 * db_health proposals (needs_approval). Never mutates.
 */
export async function getDbHealthPanel(admin: Admin, workspaceId: string): Promise<DbHealthPanel> {
  const [topTables, slowBeat, sizeBeat, proposals] = await Promise.all([
    fetchTopTables(admin),
    fetchLatestBeat(admin, DB_HEALTH_SLOWQ_LOOP_ID),
    fetchLatestBeat(admin, DB_HEALTH_SIZE_LOOP_ID),
    fetchOpenProposals(admin, workspaceId),
  ]);
  const slowQueries: DbHealthSlowQuery[] = Array.isArray((slowBeat?.produced as { slow_queries?: unknown })?.slow_queries)
    ? ((slowBeat!.produced as { slow_queries: Array<Record<string, unknown>> }).slow_queries).slice(0, 10).map((q) => ({
        queryid: String(q.queryid ?? ""),
        cause: String(q.cause ?? ""),
        table: String(q.table ?? ""),
        impact: String(q.impact ?? ""),
      }))
    : [];
  return {
    topTables,
    slowQueries,
    proposals,
    lastSizeSweepAt: sizeBeat?.ran_at ?? null,
    lastSlowQueryAt: slowBeat?.ran_at ?? null,
  };
}

async function fetchTopTables(admin: Admin): Promise<DbHealthTopTable[]> {
  // The latest sweep shares ~one captured_at; read the most-recent batch and take the top by size.
  const { data: latest } = await admin
    .from("db_table_size_history")
    .select("captured_at")
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const capturedAt = (latest as { captured_at?: string } | null)?.captured_at;
  if (!capturedAt) return [];
  const { data } = await admin
    .from("db_table_size_history")
    .select("table_name, total_bytes, row_estimate")
    .eq("captured_at", capturedAt)
    .order("total_bytes", { ascending: false })
    .limit(15);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    table: String(r.table_name ?? ""),
    totalBytes: Number(r.total_bytes ?? 0),
    rowEstimate: Number(r.row_estimate ?? 0),
  }));
}

async function fetchLatestBeat(admin: Admin, loopId: string): Promise<{ ran_at: string; produced: unknown } | null> {
  const { data } = await admin
    .from("loop_heartbeats")
    .select("ran_at, produced")
    .eq("loop_id", loopId)
    .order("ran_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { ran_at: string; produced: unknown } | null) ?? null;
}

async function fetchOpenProposals(admin: Admin, workspaceId: string): Promise<DbHealthProposalItem[]> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, status, instructions, pending_actions, log_tail, created_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "db_health")
    .in("status", ["needs_approval", "needs_attention"])
    .order("created_at", { ascending: false })
    .limit(50);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    let title = String(row.spec_slug || "");
    let impact = "";
    let cause = "";
    let category = "";
    try {
      const instr = row.instructions ? JSON.parse(String(row.instructions)) : {};
      if (instr.title) title = String(instr.title);
      impact = String(instr.impact ?? "");
      cause = String(instr.cause ?? "");
      category = String(instr.category ?? "");
    } catch {
      /* not JSON — fall back to the slug */
    }
    const actions = Array.isArray(row.pending_actions) ? (row.pending_actions as Array<Record<string, unknown>>) : [];
    const buildAction = actions.find((a) => a.type === "db_health_build" && a.status === "pending");
    return {
      jobId: String(row.id),
      signature: String(row.spec_slug || ""),
      title,
      impact: impact || (typeof row.log_tail === "string" ? row.log_tail : ""),
      cause,
      category,
      specSlug: buildAction ? String(buildAction.spec_slug || "") || null : null,
      specTitle: buildAction ? String(buildAction.spec_title || "") || null : null,
      createdAt: String(row.created_at || ""),
    };
  });
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function slugFor(fixKind: DbHealthFixKind, target: string): string {
  const prefix: Record<DbHealthFixKind, string> = {
    retention_cron: "db-retention",
    add_index: "db-index",
    drop_index: "db-drop-index",
    query_rewrite: "db-rewrite",
    reduce_calls: "db-reduce-calls",
    vacuum_tuning: "db-vacuum",
    raise_compute: "db-raise-compute",
    raise_work_mem: "db-raise-work-mem",
    investigate_timeouts: "db-investigate-timeouts",
  };
  const clean = target.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 40);
  return `${prefix[fixKind]}-${clean}`.slice(0, 60);
}

function specTitleFor(cause: DbHealthCause, target: string, hint: string): string {
  const base: Record<DbHealthCause, string> = {
    seq_scan: `Add an index to ${target} (seq scan)`,
    no_index_match: `Make ${target}'s predicate index-usable`,
    sort_spill: `Fix the disk sort on ${target}`,
    full_aggregate: `Bound the full-table scan on ${target}`,
    missing_limit: `Bound the unbounded query on ${target}`,
    high_call_volume: `Reduce call volume / cache the hot query on ${target}`,
    bloat_stale_stats: `Refresh stats / vacuum ${target}`,
    unbounded_growth: `Add a retention cron for ${target}`,
    missing_index: `Add an index to ${target}`,
    unused_index: `Drop the unused index ${target}`,
    bloat_vacuum_lag: `Vacuum / autovacuum-tune ${target}`,
    statement_timeout_pressure: `Investigate statement_timeout pressure on ${target}`,
    temp_spill_pressure: `Investigate temp-file spill pressure on ${target}`,
    connection_saturation: `Investigate connection saturation on ${target}`,
    cache_pressure: `Investigate cache-hit pressure on ${target}`,
    rollback_error_rate: `Investigate rollback rate on ${target}`,
    request_volume_pressure: `Cut the request-volume / egress firehose on ${target}`,
  };
  return base[cause] || `Fix ${target}: ${hint.slice(0, 40)}`;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function pct(frac: number): string {
  return `${Math.round(frac * 100)}%`;
}

/**
 * Preview a near-timeout offender query in the finding evidence: collapse whitespace + truncate.
 * The full query text is already on `NearTimeoutSample.query`; this only shapes the human-readable
 * evidence line. db-investigate-timeouts-instance.
 */
function previewQuery(q: string): string {
  const compact = q.replace(/\s+/g, " ").trim();
  const MAX = 200;
  return compact.length > MAX ? `${compact.slice(0, MAX - 1)}…` : compact;
}
