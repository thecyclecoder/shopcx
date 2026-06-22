/**
 * Control Tower — migration-drift check (control-tower-migration-drift-check spec, Phase 1).
 *
 * A migration that doesn't apply is INVISIBLE: the code references a table, the table isn't there,
 * and unless something fails loud (it usually doesn't) it degrades silently — exactly what happened
 * with 20260618140000_meta_performance_tables.sql, silently skipped in the apply pipeline, so every
 * meta_* upsert hit PGRST205 and the iteration engine ran on empty ROAS data for weeks.
 *
 * The check: parse every supabase/migrations/*.sql for the tables they CREATE (net of any later
 * DROP), then diff against the LIVE public schema. Any expected-but-absent table = a silently
 * unapplied migration → surface it.
 *
 * WHERE IT RUNS: the deployed Next runtime can't read the .sql files (not bundled), so this runs on
 * the BOX (scripts/builder-worker.ts) — it has the migration files in the working tree and an admin
 * DB connection. The box writes the result into a loop_heartbeats beat (loop_id =
 * MIGRATION_DRIFT_LOOP_ID, kind 'cron'); the Control Tower monitor's `migration-drift` output
 * assertion reads the beat's `produced.missing` and flips the tile red (opening a de-duped alert +
 * paging) — the standard surfacing path, so a DEAD check is itself visible (cron freshness) too.
 *
 * This file is PURE parse + diff (no fs/pg/network at module load): the caller supplies the
 * migrations dir to read and a `fetchLiveTables` callback. That keeps the drift LOGIC testable and
 * lets the box own the raw-SQL schema read. See docs/brain/libraries/control-tower.md.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { MIGRATION_DRIFT_LOOP_ID } from "@/lib/control-tower/registry";

export { MIGRATION_DRIFT_LOOP_ID };

/** A migration-created table that's absent from the live schema (+ the migration that creates it). */
export interface MissingTable {
  table: string;
  /** the filename of the FIRST migration that creates it. */
  migration: string;
}

export interface DriftResult {
  /** 'ok' = no drift · 'drift' = ≥1 expected table missing · 'skipped' = couldn't read the live schema. */
  status: "ok" | "drift" | "skipped";
  /** absent expected tables that ALERT (excludes allowlisted/sunset ones). */
  missing: MissingTable[];
  /** absent expected tables that are ALLOWLISTED (sunset systems) — surfaced for visibility, never alerted. */
  allowlistedMissing: MissingTable[];
  /** count of distinct migration-created tables (net of drops). */
  expectedCount: number;
  /** count of live public tables read (0 when skipped). */
  liveCount: number;
  /** number of .sql files parsed. */
  parsedFiles: number;
  /** populated only when status === 'skipped'. */
  reason?: string;
}

/**
 * Known-sunset table allowlist (control-tower-migration-drift-check spec — "scope the noise"). A
 * migration-created table that's intentionally being retired (Klaviyo is being sunset alongside the
 * rest of the legacy stack) must NOT alert when it disappears from the live schema. Entries match a
 * table name exactly, or as a `prefix*` wildcard (trailing `*` only). Keep this SHORT — the right
 * answer for a real missing table is to re-apply its migration, not to allowlist it.
 */
export const MIGRATION_DRIFT_ALLOWLIST: string[] = [
  // Klaviyo — replaced by the in-house messaging/marketing stack; tables retired as the sync winds down.
  "klaviyo_*",
];

/** Does `table` match an allowlist entry (exact, or a `prefix*` wildcard)? */
export function isAllowlisted(table: string, allowlist: string[] = MIGRATION_DRIFT_ALLOWLIST): boolean {
  return allowlist.some((entry) => {
    if (entry.endsWith("*")) return table.startsWith(entry.slice(0, -1));
    return table === entry;
  });
}

// `create table [if not exists] [public.]["]name["]` — case-insensitive, optional schema-qualifier
// + optional double-quotes. Skips temp/unlogged tables (those aren't part of the persistent schema).
const CREATE_TABLE_RE =
  /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const DROP_TABLE_RE =
  /\bdrop\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const TEMP_CREATE_RE = /\bcreate\s+(?:temp(?:orary)?|unlogged)\s+table\b/i;

/** Strip `--` line comments and `/* *​/` block comments so a commented-out DDL line never counts. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Table names this SQL CREATEs (excludes temp/unlogged). */
export function extractCreatedTables(sql: string): string[] {
  const clean = stripSqlComments(sql);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  CREATE_TABLE_RE.lastIndex = 0;
  while ((m = CREATE_TABLE_RE.exec(clean))) {
    // Re-check the matched statement isn't a temp/unlogged create (the main RE doesn't capture those
    // keywords; a `create temp table` would otherwise slip through as a normal create).
    const stmtStart = clean.lastIndexOf("create", m.index + 6);
    const around = clean.slice(Math.max(0, stmtStart - 2), m.index + m[0].length);
    if (TEMP_CREATE_RE.test(around)) continue;
    out.push(m[1]);
  }
  return out;
}

/** Table names this SQL DROPs. */
export function extractDroppedTables(sql: string): string[] {
  const clean = stripSqlComments(sql);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  DROP_TABLE_RE.lastIndex = 0;
  while ((m = DROP_TABLE_RE.exec(clean))) out.push(m[1]);
  return out;
}

/**
 * Parse every `*.sql` under `migrationsDir` (ascending filename = apply order) into the set of
 * tables the migrations should have created, NET of any later DROP. Returns each table mapped to the
 * FIRST migration that creates it (the one to re-apply on drift). Drop-aware: a table created then
 * dropped by a LATER migration is correctly net-absent (not expected → never flagged).
 */
export function parseExpectedTables(migrationsDir: string): {
  expected: Map<string, string>;
  dropped: Set<string>;
  parsedFiles: number;
} {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexical sort = chronological (YYYYMMDDNNNNNN_… naming) = apply order.
  const expected = new Map<string, string>();
  const dropped = new Set<string>();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const t of extractCreatedTables(sql)) {
      if (!expected.has(t)) expected.set(t, file);
      // A re-create after a drop revives it: clear the drop so it's expected again.
      dropped.delete(t);
    }
    for (const t of extractDroppedTables(sql)) dropped.add(t);
  }
  for (const t of dropped) expected.delete(t);
  return { expected, dropped, parsedFiles: files.length };
}

/** Diff the expected (migration-created) tables against the live set → the missing ones, split by allowlist. */
export function computeDrift(
  expected: Map<string, string>,
  liveTables: Iterable<string>,
  allowlist: string[] = MIGRATION_DRIFT_ALLOWLIST,
): { missing: MissingTable[]; allowlistedMissing: MissingTable[] } {
  const live = new Set(liveTables);
  const missing: MissingTable[] = [];
  const allowlistedMissing: MissingTable[] = [];
  for (const [table, migration] of expected) {
    if (live.has(table)) continue;
    const row = { table, migration };
    if (isAllowlisted(table, allowlist)) allowlistedMissing.push(row);
    else missing.push(row);
  }
  const byTable = (a: MissingTable, b: MissingTable) => a.table.localeCompare(b.table);
  return { missing: missing.sort(byTable), allowlistedMissing: allowlistedMissing.sort(byTable) };
}

export interface RunDriftOpts {
  /** absolute path to supabase/migrations. */
  migrationsDir: string;
  /**
   * Reads the live `public` table names. Returns null when the schema can't be read (e.g. no DB
   * password on this host) → status 'skipped' (NEVER a false "no drift"; the missing read is honest).
   */
  fetchLiveTables: () => Promise<string[] | null>;
  allowlist?: string[];
}

/**
 * Run the full parse → diff. Used by the box's periodic migration-drift job. PURE except for the
 * caller-supplied fs dir (read) + fetchLiveTables (DB read); performs NO writes. The box wraps the
 * returned DriftResult into a loop_heartbeats beat.
 */
export async function runMigrationDriftCheck(opts: RunDriftOpts): Promise<DriftResult> {
  const allowlist = opts.allowlist ?? MIGRATION_DRIFT_ALLOWLIST;
  const { expected, parsedFiles } = parseExpectedTables(opts.migrationsDir);

  let live: string[] | null;
  try {
    live = await opts.fetchLiveTables();
  } catch (e) {
    live = null;
    return {
      status: "skipped",
      missing: [],
      allowlistedMissing: [],
      expectedCount: expected.size,
      liveCount: 0,
      parsedFiles,
      reason: `live schema read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (live == null) {
    return {
      status: "skipped",
      missing: [],
      allowlistedMissing: [],
      expectedCount: expected.size,
      liveCount: 0,
      parsedFiles,
      reason: "live schema unavailable (no DB connection on this host)",
    };
  }

  const { missing, allowlistedMissing } = computeDrift(expected, live, allowlist);
  return {
    status: missing.length > 0 ? "drift" : "ok",
    missing,
    allowlistedMissing,
    expectedCount: expected.size,
    liveCount: live.length,
    parsedFiles,
  };
}

/** A one-line human summary for the heartbeat detail / logs. */
export function driftSummary(r: DriftResult): string {
  if (r.status === "skipped") return `migration-drift skipped — ${r.reason ?? "unknown"}`;
  if (r.status === "ok") {
    const al = r.allowlistedMissing.length ? `, ${r.allowlistedMissing.length} allowlisted-absent` : "";
    return `migration-drift ok — ${r.expectedCount} expected, ${r.liveCount} live, 0 missing${al}`;
  }
  const list = r.missing.slice(0, 5).map((m) => `${m.table} (${m.migration})`).join(", ");
  return `migration drift — ${r.missing.length} missing: ${list}${r.missing.length > 5 ? `, +${r.missing.length - 5} more` : ""}`;
}
