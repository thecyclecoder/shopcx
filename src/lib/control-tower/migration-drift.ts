/**
 * Control Tower — migration-drift check (control-tower-migration-drift-check spec, Phase 1;
 * ci-guard-migrations-applied-not-just-merged spec Phase 1 extends it with a second axis).
 *
 * A migration that doesn't apply is INVISIBLE: the code references a table, the table isn't there,
 * and unless something fails loud (it usually doesn't) it degrades silently — exactly what happened
 * with 20260618140000_meta_performance_tables.sql, silently skipped in the apply pipeline, so every
 * meta_* upsert hit PGRST205 and the iteration engine ran on empty ROAS data for weeks, and again
 * with 20260918120000_order_refunds_mirror.sql — merged 2026-07-06 but never applied, so
 * order_refunds did not exist in prod until a manual apply.
 *
 * The check has TWO axes, both surfaced on the same `migration-drift-check` tile:
 *   1. **table-presence (original)**: parse every supabase/migrations/*.sql for the tables they
 *      CREATE (net of any later DROP or RENAME), then diff against the LIVE public schema. Any
 *      expected-but-absent table = a silently unapplied migration → surface it.
 *   2. **applied-set reconcile** (ci-guard-migrations-applied-not-just-merged P1): compare the SET of
 *      migration VERSIONS present on main (the 14-digit YYYYMMDDNNNNNN prefix of every
 *      supabase/migrations/*.sql filename) against the SET the DB records as applied
 *      (supabase_migrations.schema_migrations.version). Files on main whose version is not in the
 *      applied set = merged-but-unapplied — the exact silent-inert case (a merged migration whose
 *      dependent code silently no-ops because the DDL never ran). The reverse (applied version with
 *      no local file) is BENIGN — an old apply that pre-dates a file rename/delete — recorded as an
 *      informational note, never a red alarm.
 *
 * WHERE IT RUNS: the deployed Next runtime can't read the .sql files (not bundled), so this runs on
 * the BOX (scripts/builder-worker.ts) — it has the migration files in the working tree and an admin
 * DB connection. The box writes the result into a loop_heartbeats beat (loop_id =
 * MIGRATION_DRIFT_LOOP_ID, kind 'cron'); the Control Tower monitor's `migration-drift` output
 * assertion reads the beat's `produced.missing` + `produced.mergedButUnapplied` and flips the tile
 * red (opening a de-duped alert + paging) — the standard surfacing path, so a DEAD check is itself
 * visible (cron freshness) too.
 *
 * This file is PURE parse + diff (no fs/pg/network at module load): the caller supplies the
 * migrations dir to read and a `fetchLiveTables` callback (and an optional `fetchAppliedVersions`
 * callback for the applied-set reconcile). That keeps the drift LOGIC testable and lets the box own
 * the raw-SQL schema read. See docs/brain/libraries/control-tower.md.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { MIGRATION_DRIFT_LOOP_ID } from "@/lib/control-tower/registry";
import { classifyMigrationSql, type MigrationSeverity } from "@/lib/migration-safety";

export { MIGRATION_DRIFT_LOOP_ID };

/** A migration-created table that's absent from the live schema (+ the migration that creates it). */
export interface MissingTable {
  table: string;
  /** the filename of the FIRST migration that creates it. */
  migration: string;
}

/**
 * A migration file present on main whose 14-digit version is not in the DB's applied set
 * (supabase_migrations.schema_migrations) — the merged-but-unapplied case that leaves dependent code
 * silently inert (regression pin for 20260918120000_order_refunds_mirror).
 * ci-guard-migrations-applied-not-just-merged spec Phase 1.
 *
 * Fields populated by Phase 2's applyMergedMigrations() control loop:
 *  - severity/matches: what classifyMigrationSql returned for this file.
 *  - outcome: the auto-apply / approval-gate decision.
 *  - error: populated only when outcome='apply-failed'.
 */
export interface MergedUnappliedMigration {
  /** The 14-digit YYYYMMDDNNNNNN prefix — matches supabase_migrations.schema_migrations.version. */
  version: string;
  /** The .sql filename on main. */
  file: string;
  /** Destructive classifier severity, set by applyMergedMigrations (Phase 2). */
  severity?: MigrationSeverity;
  /** classifyMigrationSql matches (empty for additive), set by applyMergedMigrations (Phase 2). */
  matches?: string[];
  /**
   * Apply outcome (Phase 2):
   *  - 'applied':          additive/idempotent DDL, auto-applied on the pooler, schema_migrations row inserted.
   *  - 'already-applied':  the DDL threw a duplicate-object-class SQLSTATE (the object already exists in the
   *                        live schema — the earlier apply was never recorded in schema_migrations, so the
   *                        reconciler surfaced it as merged-but-unapplied). Version is inserted, tile clears.
   *                        migration-drift-reconciler-idempotent-on-already-applied-objects spec Phase 1.
   *  - 'approval-needed':  classifier flagged destructive — NOT auto-applied; the tile alert names the version.
   *  - 'apply-failed':     additive but the pooler apply threw a GENUINE error (syntax / undefined_table /
   *                        undefined_column) — NOT a duplicate-object class. The tile stays red until a human
   *                        looks. isDuplicateObjectError below classifies which is which.
   */
  outcome?: "applied" | "already-applied" | "approval-needed" | "apply-failed";
  /** Populated only when outcome === 'apply-failed'. */
  error?: string;
}

export interface DriftResult {
  /** 'ok' = no drift · 'drift' = ≥1 expected table missing OR ≥1 merged-but-unapplied migration · 'skipped' = couldn't read the live schema. */
  status: "ok" | "drift" | "skipped";
  /** absent expected tables that ALERT (excludes allowlisted/sunset ones). */
  missing: MissingTable[];
  /** absent expected tables that are ALLOWLISTED (sunset systems) — surfaced for visibility, never alerted. */
  allowlistedMissing: MissingTable[];
  /**
   * Migration files on main whose version isn't in the DB's applied set — the merged-but-unapplied
   * case (ci-guard-migrations-applied-not-just-merged P1). ALERTABLE.
   */
  mergedButUnapplied: MergedUnappliedMigration[];
  /**
   * Applied migration versions the DB records with no matching file on main — the benign reverse
   * case (an old apply that pre-dates a file rename/delete). INFORMATIONAL, never a red alarm.
   */
  appliedNotOnMain: string[];
  /** count of distinct migration-created tables (net of drops). */
  expectedCount: number;
  /** count of live public tables read (0 when skipped). */
  liveCount: number;
  /** number of .sql files parsed. */
  parsedFiles: number;
  /** count of applied versions read from supabase_migrations.schema_migrations (0 when unavailable). */
  appliedCount: number;
  /** populated only when status === 'skipped', or when the applied-set slice couldn't run. */
  reason?: string;
  /** true when fetchAppliedVersions was absent/null/threw — the merged-but-unapplied slice is skipped. */
  appliedCheckSkipped: boolean;
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
// `alter table [if exists] [public.]["]old["] rename to [public.]["]new["]` — a TABLE rename.
// The `rename to` keyword is what distinguishes it from a `rename column … to …` (whose `rename`
// is followed by `column`, not `to`), so a column rename never matches.
const RENAME_TABLE_RE =
  /\balter\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s+rename\s+to\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
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

/** `ALTER TABLE … RENAME TO …` table renames this SQL performs, in source order (`from` → `to`). */
export function extractRenamedTables(sql: string): Array<{ from: string; to: string }> {
  const clean = stripSqlComments(sql);
  const out: Array<{ from: string; to: string }> = [];
  let m: RegExpExecArray | null;
  RENAME_TABLE_RE.lastIndex = 0;
  while ((m = RENAME_TABLE_RE.exec(clean))) out.push({ from: m[1], to: m[2] });
  return out;
}

/**
 * Pure core of {@link parseExpectedTables}: fold an ordered list of `{ file, sql }` migrations (apply
 * order) into the net expected-table set. Exported so the parse logic is unit-testable without fs.
 *
 * Per file, in source order of categories: CREATE (record first-creating migration, revive from a
 * prior drop) → RENAME (`old → new`: drop `old` from the expected set, carry `new` forward mapped to
 * the migration that first created the *original* — fallback: the rename migration — and clear any
 * stale dropped-set membership) → DROP (mark net-absent). RENAME-awareness is what keeps a table
 * renamed by a later migration from lingering in the expected set as a bogus "silently-skipped
 * CREATE" once the live schema only has the new name.
 */
export function foldMigrations(files: Array<{ file: string; sql: string }>): {
  expected: Map<string, string>;
  dropped: Set<string>;
} {
  const expected = new Map<string, string>();
  const dropped = new Set<string>();
  for (const { file, sql } of files) {
    for (const t of extractCreatedTables(sql)) {
      if (!expected.has(t)) expected.set(t, file);
      // A re-create after a drop revives it: clear the drop so it's expected again.
      dropped.delete(t);
    }
    for (const { from, to } of extractRenamedTables(sql)) {
      // The new name inherits the original's first-creating migration (fallback: this rename file).
      const origin = expected.get(from) ?? file;
      expected.delete(from);
      if (!expected.has(to)) expected.set(to, origin);
      // The rename retires the old name and revives the new: neither should linger as "dropped".
      dropped.delete(from);
      dropped.delete(to);
    }
    for (const t of extractDroppedTables(sql)) dropped.add(t);
  }
  for (const t of dropped) expected.delete(t);
  return { expected, dropped };
}

/**
 * Enumerate `*.sql` filenames under `migrationsDir` in chronological apply order (lexical sort of
 * the YYYYMMDDNNNNNN_ prefix convention). Both drift axes walk the same file list.
 */
export function listMigrationFilenames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Parse every `*.sql` under `migrationsDir` (ascending filename = apply order) into the set of
 * tables the migrations should have created, NET of any later DROP or RENAME. Returns each table
 * mapped to the FIRST migration that creates it (the one to re-apply on drift). Drop-aware (a table
 * created then dropped by a LATER migration is net-absent) and rename-aware (a table renamed by a
 * later migration is tracked under its new name, never falsely expected under the old).
 */
export function parseExpectedTables(migrationsDir: string): {
  expected: Map<string, string>;
  dropped: Set<string>;
  parsedFiles: number;
  files: string[];
} {
  const files = listMigrationFilenames(migrationsDir);
  const { expected, dropped } = foldMigrations(
    files.map((file) => ({ file, sql: readFileSync(join(migrationsDir, file), "utf8") })),
  );
  return { expected, dropped, parsedFiles: files.length, files };
}

/**
 * The 14-digit YYYYMMDDNNNNNN version prefix of a migration filename (matches
 * supabase_migrations.schema_migrations.version). Returns null for files that don't follow the
 * timestamped convention — none should exist in normal operation, and off-format files are simply
 * skipped by the applied-set reconcile (they can't be reliably matched against the applied set).
 * ci-guard-migrations-applied-not-just-merged spec Phase 1.
 */
export function extractMigrationVersion(filename: string): string | null {
  const m = filename.match(/^(\d{14})/);
  return m ? m[1] : null;
}

/**
 * Diff the local file set against the applied version set → merged-but-unapplied + informational
 * appliedNotOnMain. PURE: exported so the reconcile logic is unit-testable without fs/pg.
 *
 * A file whose filename lacks the 14-digit prefix is EXCLUDED from the diff (no reliable
 * version-to-applied match) rather than falsely flagged — off-format files (e.g. the
 * `_PENDING_*.sql` scratch pattern the write-migration recipe uses) don't count against either set.
 * ci-guard-migrations-applied-not-just-merged spec Phase 1.
 */
export function computeMergedButUnapplied(
  files: string[],
  appliedVersions: Iterable<string>,
): { mergedButUnapplied: MergedUnappliedMigration[]; appliedNotOnMain: string[] } {
  const applied = new Set(appliedVersions);
  const localVersions = new Set<string>();
  const mergedButUnapplied: MergedUnappliedMigration[] = [];
  for (const file of files) {
    const version = extractMigrationVersion(file);
    if (version == null) continue; // off-format file (e.g. _PENDING_*.sql) — skip.
    localVersions.add(version);
    if (!applied.has(version)) mergedButUnapplied.push({ version, file });
  }
  const appliedNotOnMain = [...applied].filter((v) => !localVersions.has(v));
  const byVersion = (a: MergedUnappliedMigration, b: MergedUnappliedMigration) =>
    a.version.localeCompare(b.version) || a.file.localeCompare(b.file);
  return {
    mergedButUnapplied: mergedButUnapplied.sort(byVersion),
    appliedNotOnMain: appliedNotOnMain.sort(),
  };
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
  /**
   * Reads the applied migration versions from supabase_migrations.schema_migrations.version — the
   * source of truth for what the DB records as applied. Returns null when the host has no DB access
   * → the applied-set reconcile is skipped honestly (mergedButUnapplied stays []; the tile's
   * table-presence axis still runs). Optional so callers with no DB access still get the
   * rename-tracking drift check. ci-guard-migrations-applied-not-just-merged spec Phase 1.
   */
  fetchAppliedVersions?: () => Promise<string[] | null>;
  allowlist?: string[];
}

/**
 * Run the full parse → diff on both axes (table-presence + applied-set reconcile). Used by the
 * box's periodic migration-drift job. PURE except for the caller-supplied fs dir (read) +
 * fetchLiveTables + fetchAppliedVersions (DB reads); performs NO writes. The box wraps the returned
 * DriftResult into a loop_heartbeats beat.
 *
 * Skip semantics: the table-presence axis DECIDES status/skipped (existing contract — a missing
 * live-schema read is never a false clean). The applied-set axis is an independent addition — if
 * fetchAppliedVersions is absent/null/throws, mergedButUnapplied stays [] and appliedCheckSkipped=true
 * (a honest skip on that axis; the tile's table-presence axis is unaffected).
 */
export async function runMigrationDriftCheck(opts: RunDriftOpts): Promise<DriftResult> {
  const allowlist = opts.allowlist ?? MIGRATION_DRIFT_ALLOWLIST;
  const { expected, parsedFiles, files } = parseExpectedTables(opts.migrationsDir);

  let applied: string[] | null = null;
  let appliedReason: string | undefined;
  if (opts.fetchAppliedVersions) {
    try {
      applied = await opts.fetchAppliedVersions();
    } catch (e) {
      appliedReason = `applied-versions read failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (applied == null && !appliedReason) {
      appliedReason = "applied versions unavailable (no DB connection on this host)";
    }
  } else {
    appliedReason = "no fetchAppliedVersions callback supplied";
  }
  const { mergedButUnapplied, appliedNotOnMain } = applied
    ? computeMergedButUnapplied(files, applied)
    : { mergedButUnapplied: [] as MergedUnappliedMigration[], appliedNotOnMain: [] as string[] };
  const appliedCount = applied?.length ?? 0;
  const appliedCheckSkipped = applied == null;

  let live: string[] | null;
  try {
    live = await opts.fetchLiveTables();
  } catch (e) {
    live = null;
    return {
      status: "skipped",
      missing: [],
      allowlistedMissing: [],
      mergedButUnapplied,
      appliedNotOnMain,
      expectedCount: expected.size,
      liveCount: 0,
      parsedFiles,
      appliedCount,
      reason: `live schema read failed: ${e instanceof Error ? e.message : String(e)}`,
      appliedCheckSkipped,
    };
  }
  if (live == null) {
    return {
      status: "skipped",
      missing: [],
      allowlistedMissing: [],
      mergedButUnapplied,
      appliedNotOnMain,
      expectedCount: expected.size,
      liveCount: 0,
      parsedFiles,
      appliedCount,
      reason: "live schema unavailable (no DB connection on this host)",
      appliedCheckSkipped,
    };
  }

  const { missing, allowlistedMissing } = computeDrift(expected, live, allowlist);
  const hasDrift = missing.length > 0 || mergedButUnapplied.length > 0;
  return {
    status: hasDrift ? "drift" : "ok",
    missing,
    allowlistedMissing,
    mergedButUnapplied,
    appliedNotOnMain,
    expectedCount: expected.size,
    liveCount: live.length,
    parsedFiles,
    appliedCount,
    reason: appliedReason,
    appliedCheckSkipped,
  };
}

/** A one-line human summary for the heartbeat detail / logs. */
export function driftSummary(r: DriftResult): string {
  if (r.status === "skipped") return `migration-drift skipped — ${r.reason ?? "unknown"}`;
  const appliedNote = r.appliedCheckSkipped
    ? " (applied-set check skipped)"
    : `, ${r.appliedCount} applied, ${r.mergedButUnapplied.length} merged-but-unapplied`;
  if (r.status === "ok") {
    const al = r.allowlistedMissing.length ? `, ${r.allowlistedMissing.length} allowlisted-absent` : "";
    return `migration-drift ok — ${r.expectedCount} expected, ${r.liveCount} live, 0 missing${al}${appliedNote}`;
  }
  const parts: string[] = [];
  if (r.missing.length > 0) {
    const list = r.missing.slice(0, 5).map((m) => `${m.table} (${m.migration})`).join(", ");
    parts.push(`${r.missing.length} table${r.missing.length === 1 ? "" : "s"} missing: ${list}${r.missing.length > 5 ? `, +${r.missing.length - 5} more` : ""}`);
  }
  if (r.mergedButUnapplied.length > 0) {
    const outcomes = summarizeOutcomes(r.mergedButUnapplied);
    const list = r.mergedButUnapplied.slice(0, 5).map((m) => `${m.version} (${m.file})`).join(", ");
    const tail = outcomes ? ` [${outcomes}]` : "";
    parts.push(`${r.mergedButUnapplied.length} merged-but-unapplied: ${list}${r.mergedButUnapplied.length > 5 ? `, +${r.mergedButUnapplied.length - 5} more` : ""}${tail}`);
  }
  return `migration drift — ${parts.join("; ")}`;
}

/** Compact "K applied · K already-applied · K approval-needed · K apply-failed" outcome tail, or "" when nothing tagged. */
function summarizeOutcomes(items: MergedUnappliedMigration[]): string {
  let applied = 0;
  let alreadyApplied = 0;
  let approvalNeeded = 0;
  let applyFailed = 0;
  for (const m of items) {
    if (m.outcome === "applied") applied++;
    else if (m.outcome === "already-applied") alreadyApplied++;
    else if (m.outcome === "approval-needed") approvalNeeded++;
    else if (m.outcome === "apply-failed") applyFailed++;
  }
  const bits: string[] = [];
  if (applied) bits.push(`${applied} applied`);
  if (alreadyApplied) bits.push(`${alreadyApplied} already-applied`);
  if (approvalNeeded) bits.push(`${approvalNeeded} approval-needed`);
  if (applyFailed) bits.push(`${applyFailed} apply-failed`);
  return bits.join(" · ");
}

// ─────────────────────────────────────────────────────────────────────────────
// migration-drift-reconciler-idempotent-on-already-applied-objects spec Phase 1 —
// A duplicate-object error during additive auto-apply means already-applied, not apply-failed.
//
// The 2026-07 incident: the ledger was 103 versions behind — 103 merged migrations whose DDL had
// already been applied to the database (the objects existed) but whose versions were never recorded
// in supabase_migrations.schema_migrations. The reconciler classified each as merged-but-unapplied
// and re-ran the additive DDL, which threw a duplicate-object SQLSTATE (`relation already exists`,
// `cannot change return type of existing function`) — recorded as apply-failed, retried on the next
// poll, and produced a steady stream of Postgres errors. The applyMigrationAndRecord fix corrected
// the apply METHOD but never taught the reconciler that a duplicate-object error means the object
// is already there — reconcile the ledger, don't red the tile.
//
// The classifier below is the ONE place that reads err.code so the additive-apply path AND the
// one-time reconcile script (Phase 2) share the exact same duplicate-object definition. A genuine
// error (syntax, undefined_table, undefined_column, or anything outside this set) stays apply-failed
// and stays red — this must NEVER silently record a broken migration.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Postgres SQLSTATE codes that indicate the DDL failed BECAUSE the object it tried to create is
 * already there — a strong signal the migration was applied earlier but never recorded in
 * supabase_migrations.schema_migrations. Kept as a readonly Set so the classification is data,
 * not code.
 *   42P07  duplicate_table              `relation "x" already exists`
 *   42710  duplicate_object             `constraint / policy / trigger / index "x" already exists`
 *   42723  duplicate_function           `function "x(...)" already exists with same argument types`
 *   42P06  duplicate_schema             `schema "x" already exists`
 *   42701  duplicate_column             `column "x" of relation "y" already exists`
 *   42P13  invalid_function_definition  `cannot change return type of existing function` — the
 *                                       CREATE OR REPLACE case where the signature already matches
 *                                       but the return type differs; Postgres treats it as a
 *                                       duplicate for our purposes (the function is already there).
 * Genuine failures (`42601` syntax_error, `42P01` undefined_table, `42703` undefined_column, any
 * class outside this set) are DELIBERATELY excluded — they must stay apply-failed.
 */
export const DUPLICATE_OBJECT_SQLSTATES: ReadonlySet<string> = new Set([
  "42P07",
  "42710",
  "42723",
  "42P06",
  "42701",
  "42P13",
]);

/**
 * True iff `err` looks like a Postgres error whose SQLSTATE is a duplicate-object class (see
 * DUPLICATE_OBJECT_SQLSTATES). Reads only `err.code` — the standard `pg` package's DatabaseError
 * shape. Tolerant of non-Error / undefined / plain-object shapes: any input without a string `code`
 * on the duplicate-object list returns false. Pure, exported so both the additive auto-apply path
 * and the one-time reconcile script (Phase 2) share the same classifier + it's unit-testable.
 */
export function isDuplicateObjectError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && DUPLICATE_OBJECT_SQLSTATES.has(code);
}

// ─────────────────────────────────────────────────────────────────────────────
// migration-drift-reconciler-idempotent-on-already-applied-objects spec Phase 3 —
// Statement-level duplicate-object reconciliation.
//
// The Phase 2 reconcile script (and, symmetrically, the Phase 1 live auto-apply path) ran the
// whole migration file as ONE `c.query(sql)` inside a single savepoint and treated a
// duplicate-object throw as "already applied → record the version." That's unsafe for a
// MULTI-statement migration: Postgres aborts the batch on the first failing statement, so a
// duplicate_table on statement #1 leaves statements #2..N NEVER EXECUTED — and yet we'd stamp the
// version as applied and never notice the unapplied tail (the security review's finding on the
// Phase 2 reconcile).
//
// The fix: split the file at top-level statement boundaries and classify each statement in its
// own savepoint. A statement succeeds → applied-fresh. A statement throws a duplicate-object
// SQLSTATE → verified-already-present (safe to skip; that specific object is in the live schema).
// A statement throws anything else → the file is broken; record NOTHING and leave the version
// unrecorded for human review. Only when EVERY statement in the file is accounted for (applied or
// verified) does the version get recorded — matching the security review's demand: "only record a
// version after every statement either ran successfully or was independently proven already
// present; otherwise leave it apply-failed/unrecorded."
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a Postgres SQL script into top-level statements at unquoted `;` boundaries. Preserves the
 * original statement text (whitespace/comments trimmed) — the caller re-executes each string.
 *
 * Handles:
 *  - `--` line comments (skipped through the following newline)
 *  - `/* *​/` block comments (nested per Postgres semantics — `/* /* *​/ *​/` is one comment)
 *  - `'...'` single-quoted string literals with the SQL doubled-quote escape (`''` stays inside)
 *  - `"..."` double-quoted identifiers
 *  - `$$...$$` and `$tag$...$tag$` dollar-quoted string bodies — the CRITICAL case for
 *    `CREATE FUNCTION ... AS $$ BEGIN ... END; $$` where a naive splitter would break at the
 *    function-body `;` and hand Postgres two half-statements
 *
 * The output is the list of non-empty statements in source order. Consecutive terminator-only
 * fragments produce no output. Off-format inputs (unterminated string / comment / dollar-quote)
 * still return something — the malformed tail is emitted as a single trailing statement so the
 * caller can attempt it and let Postgres surface the real syntax error.
 *
 * migration-drift-reconciler-idempotent-on-already-applied-objects spec Phase 3.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  const N = sql.length;
  let i = 0;
  let start = 0;
  while (i < N) {
    const ch = sql[i];
    const next = sql[i + 1];
    // -- line comment
    if (ch === "-" && next === "-") {
      while (i < N && sql[i] !== "\n") i++;
      continue;
    }
    // /* block comment */ (nested)
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < N && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    // '...' single-quoted string
    if (ch === "'") {
      i++;
      while (i < N) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // "..." double-quoted identifier
    if (ch === '"') {
      i++;
      while (i < N) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // $tag$ dollar-quoted string (tag may be empty → $$...$$)
    if (ch === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end < 0) {
          // Unterminated dollar-quote — bail (the malformed tail becomes the final statement).
          i = N;
          continue;
        }
        i = end + tag.length;
        continue;
      }
      // Bare `$` (unusual outside a dollar-quote intro) — advance one char.
      i++;
      continue;
    }
    // Top-level statement terminator.
    if (ch === ";") {
      const stmt = sql.slice(start, i).trim();
      if (stmt.length > 0) out.push(stmt);
      i++;
      start = i;
      continue;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — close the loop: alert + apply, never leave it inert
// (ci-guard-migrations-applied-not-just-merged spec Phase 2).
//
// The Phase-1 reconciler surfaces every merged-but-unapplied version on the tile detail (the alert
// names the version). Phase 2 closes the loop: classify each unapplied file's SQL via the sanctioned
// destructive-migration classifier (classifyMigrationSql from [[../libraries/migration-safety]]);
// additive/idempotent DDL is auto-applied via the write-a-migration-apply-script sanctioned pattern
// (pg Client on the pooler + insert into supabase_migrations.schema_migrations), destructive DDL is
// gated for approval (NOT auto-applied — the tile alert stays until a human runs the sanctioned
// script). The box re-runs the reconciler after any auto-apply so a resolved drift clears the tile.
// ─────────────────────────────────────────────────────────────────────────────

export interface ApplyMergedOpts {
  /** Reads a migration file's SQL body. Injected so the pure loop is fs-free + testable. */
  readSql: (file: string) => Promise<string> | string;
  /**
   * Applies an additive migration on the pooler AND records the version in
   * supabase_migrations.schema_migrations. Called ONLY when classifyMigrationSql returns 'additive'
   * (destructive migrations never reach this — they take the approval-needed branch). Best-effort:
   * a throw is captured as outcome='apply-failed' with the error message; the loop continues so a
   * bad migration in the middle of the batch never blocks the ones after it.
   *
   * Return `{ alreadyApplied: true }` when the DDL threw a duplicate-object-class SQLSTATE (the
   * object already exists in the live schema — an earlier apply the ledger never recorded) and
   * the version was recorded anyway (a `ON CONFLICT DO NOTHING` insert into schema_migrations).
   * applyMergedMigrations tags outcome='already-applied' in that case — the tile clears without
   * red-flagging the reconcile.
   * migration-drift-reconciler-idempotent-on-already-applied-objects spec Phase 1. As a safety net,
   * applyMergedMigrations ALSO catches a thrown duplicate-object error via isDuplicateObjectError
   * and tags it 'already-applied' — but that path leaves the version UNRECORDED, so the caller is
   * expected to catch + record itself and use the return signal (see scripts/builder-worker.ts
   * applyMigrationAndRecord).
   */
  applyMigration: (
    input: { version: string; file: string; sql: string },
  ) => Promise<void | { alreadyApplied?: boolean }>;
  /**
   * Called for each destructive migration BEFORE marking it approval-needed. The tile alert already
   * names the version (Phase 1); this hook lets the caller add an extra surfacing (dashboard notice,
   * log line, PagerDuty). Best-effort: a throw is swallowed with a console.error — the routing
   * decision (do NOT auto-apply) is independent of the hook's success.
   */
  onApprovalNeeded?: (input: {
    version: string;
    file: string;
    severity: MigrationSeverity;
    matches: string[];
  }) => Promise<void> | void;
}

/**
 * Route each merged-but-unapplied migration through the classifyMigrationSql gate:
 *  - 'additive'                → applyMigration() → outcome 'applied' OR 'already-applied'
 *                                (or 'apply-failed' on a NON-duplicate-object throw)
 *  - 'reversible_destructive' /
 *    'irreversible_destructive' → onApprovalNeeded() → outcome 'approval-needed' (NEVER auto-apply)
 *
 * A duplicate-object-class SQLSTATE (isDuplicateObjectError) is the "already-applied" signal — the
 * object exists in the live schema because an earlier apply was never recorded in the ledger; the
 * reconciler surfaced it as merged-but-unapplied, and re-running the DDL would loop forever if we
 * treated the duplicate error as a genuine failure. The callback is expected to catch it, record
 * the version conflict-safely (`ON CONFLICT DO NOTHING`), and return `{ alreadyApplied: true }`
 * so this loop tags outcome='already-applied' AND the ledger is fixed. If the callback forgets to
 * catch, this loop's fallback ALSO classifies the throw — but that fallback path leaves the
 * version unrecorded (the next tick will re-try, still safely). migration-drift-reconciler-
 * idempotent-on-already-applied-objects spec Phase 1.
 *
 * PURE apart from the injected callbacks — readable/testable without fs/pg. Preserves input order.
 * Returns a NEW array (never mutates input) with severity/matches/outcome/error populated.
 * ci-guard-migrations-applied-not-just-merged spec Phase 2.
 */
export async function applyMergedMigrations(
  migrations: MergedUnappliedMigration[],
  opts: ApplyMergedOpts,
): Promise<MergedUnappliedMigration[]> {
  const out: MergedUnappliedMigration[] = [];
  for (const m of migrations) {
    let sql: string;
    try {
      sql = await opts.readSql(m.file);
    } catch (e) {
      out.push({
        ...m,
        outcome: "apply-failed",
        error: `read failed: ${(e as Error)?.message ?? String(e)}`,
      });
      continue;
    }
    const cls = classifyMigrationSql(sql);
    if (cls.severity === "additive") {
      try {
        const applyResult = await opts.applyMigration({ version: m.version, file: m.file, sql });
        const outcome = applyResult && applyResult.alreadyApplied ? "already-applied" : "applied";
        out.push({ ...m, severity: cls.severity, matches: cls.matches, outcome });
      } catch (e) {
        // Safety net: an uncaught duplicate-object throw is still classified as already-applied so
        // the reconciler doesn't loop forever on a ledger-only gap. The version stays UNRECORDED on
        // this path (the caller-side try/catch + record is the durable fix in applyMigrationAndRecord).
        if (isDuplicateObjectError(e)) {
          out.push({
            ...m,
            severity: cls.severity,
            matches: cls.matches,
            outcome: "already-applied",
          });
        } else {
          out.push({
            ...m,
            severity: cls.severity,
            matches: cls.matches,
            outcome: "apply-failed",
            error: (e as Error)?.message ?? String(e),
          });
        }
      }
      continue;
    }
    // Destructive branch — gate for approval; NEVER auto-apply.
    if (opts.onApprovalNeeded) {
      try {
        await opts.onApprovalNeeded({
          version: m.version,
          file: m.file,
          severity: cls.severity,
          matches: cls.matches,
        });
      } catch (e) {
        console.error(
          `[migration-drift] onApprovalNeeded hook threw for ${m.file}:`,
          (e as Error)?.message ?? String(e),
        );
      }
    }
    out.push({
      ...m,
      severity: cls.severity,
      matches: cls.matches,
      outcome: "approval-needed",
    });
  }
  return out;
}

/**
 * True iff any item in the batch cleared the merged-but-unapplied condition — either freshly applied
 * ('applied') OR reconciled as already-applied ('already-applied', the ledger got the missing row).
 * Signals the caller should re-run the reconciler so the tile clears on the same tick's heartbeat.
 */
export function anyApplied(items: MergedUnappliedMigration[]): boolean {
  return items.some((m) => m.outcome === "applied" || m.outcome === "already-applied");
}
