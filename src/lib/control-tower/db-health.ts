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
} from "@/lib/control-tower/registry";
import { isAllowlisted } from "@/lib/control-tower/migration-drift";

export { DB_HEALTH_SLOWQ_LOOP_ID, DB_HEALTH_SIZE_LOOP_ID };

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
  | "bloat_vacuum_lag"; // a hot table with a high dead-tuple ratio + stale autovacuum.

/** What the proposed fix spec asks the owner to build. The agent never runs these — it proposes. */
export type DbHealthFixKind =
  | "retention_cron"
  | "add_index"
  | "drop_index"
  | "query_rewrite"
  | "reduce_calls" // a hot, fast-per-call query → cut the call frequency / cache / add a hot-predicate (GIN for an array `@>`) index. NOT a vacuum.
  | "vacuum_tuning";

/** Which pass produced the finding (drives the loop_id + panel grouping). */
export type DbHealthCategory = "slow_query" | "growth" | "index" | "bloat";

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
  /\bpg_catalog\b/i, // Postgres system catalog
  /\binformation_schema\b/i, // SQL-standard catalog views
  /\b_?realtime\s*\./i, // realtime / _realtime schema-qualified objects (subscriptions, etc.)
  /\bsupabase_admin\b/i, // supabase_admin-role maintenance/replication queries
];

export function isForeignQuery(query: string): boolean {
  const q = query || "";
  return FOREIGN_QUERY_RES.some((re) => re.test(q));
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

/**
 * Classify an EXPLAIN (text) plan into a root cause. Pure string analysis over the plan text — the
 * box passes whatever EXPLAIN produced (plain, or EXPLAIN (ANALYZE, BUFFERS) for a confirmed-safe
 * SELECT). Order matters: a disk sort/spill and a full aggregate are more specific than a bare seq
 * scan, so they win when both appear.
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
  // Stale-stats / bad-row-estimate plan (a wildly-off estimate, no scan target identified).
  return { cause: "bloat_stale_stats", seqScanTables, hint: "the plan looks off but no Seq Scan was isolated — likely stale stats; run ANALYZE and re-check before adding an index" };
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
  if (highCallVolume) {
    cause = "high_call_volume";
    const arrayPredicate = /@>|<@/.test(row.query); // array/JSONB containment (e.g. `tags @> …`) → GIN
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
  } else {
    // No plan (couldn't EXPLAIN). Conservative classification from the text: an aggregate/DISTINCT
    // with no LIMIT → full_aggregate; otherwise a generic rewrite-review.
    const q = row.query.toLowerCase();
    if (/\b(count|sum|avg|min|max|group by|distinct)\b/.test(q) && !/\blimit\b/.test(q)) {
      cause = "full_aggregate";
      hint = "a full-table aggregate/DISTINCT with no LIMIT (no plan available — EXPLAIN was blocked) — review whether it can be bounded or index-driven";
    } else if (!/\blimit\b/.test(q) && /\bselect\b/.test(q)) {
      cause = "missing_limit";
      hint = "an unbounded SELECT (no plan available) — review whether a LIMIT or a tighter predicate applies";
    } else {
      cause = "seq_scan";
      hint = "slow query (no EXPLAIN plan available — parameterized statement) — review the predicate for an index";
    }
    planBlock = "(EXPLAIN unavailable — pg_stat_statements normalized text could not be planned)";
  }

  const fixKind = cause === "seq_scan" || cause === "sort_spill" ? "add_index" : FIX_KIND_BY_CAUSE[cause];
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
  };
  return [
    `# ${finding.specTitle} ⏳`,
    ``,
    `**Owner:** [[../functions/platform]] · **Parent:** a fix proposed by the [[../libraries/db-health|DB Health Agent]] ([[db-health-agent]]) — surface-don't-apply. · **Diagnosed cause:** \`${finding.cause}\` (${finding.category} pass).`,
    `**DBHealth-signature:** \`${finding.signature}\``,
    `**DBHealth-fix:** \`${finding.fixKind}\``,
    ``,
    `The DB Health Agent flagged this read-only and proposes the fix below. It applied **zero** DDL/deletes — the owner approves the build. Impact: ${finding.impact}.`,
    ``,
    `## Evidence`,
    finding.evidence,
    ``,
    `## Phase 1 — ${finding.fixKind.replace(/_/g, " ")} ⏳`,
    fixGuidance[finding.fixKind],
    `Gate on \`npx tsc --noEmit\`; land the brain page in the same PR.`,
    ``,
    `## Verification`,
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
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: finding.signature,
      kind: "db_health",
      status: "needs_approval",
      log_tail: `${finding.title} · ${finding.impact}`.slice(-2000),
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
        spec_body: buildFixSpecMarkdown(finding),
      }),
      pending_actions: [
        { id: actionId, type: "db_health_build", status: "pending", spec_slug: finding.specSlug, spec_title: finding.specTitle },
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
