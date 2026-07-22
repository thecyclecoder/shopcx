/**
 * scripts/_audit-collision-clusters.ts — Phase 1 of
 * [[../../docs/brain/specs/unique-migration-version-guard-and-collision-audit]].
 *
 * Two files that share a 14-digit YYYYMMDDNNNNNN version prefix under supabase/migrations
 * (a "collision cluster") both try to land under the SAME supabase_migrations.schema_migrations
 * `version` key at apply time. Only one can be recorded — the other is silently skipped and its
 * DDL is invisibly missing from prod (the exact class that caused
 * 20261026120000_media_buyer_cohort_excluded_all_customers_audience.sql to sit unlanded until
 * bianca's weekly cron repeated the `vercel:03e0d0666e56968c` signature).
 *
 * This script, for every collision cluster:
 *   1. Enumerates the files sharing the version.
 *   2. Parses each file for the objects it CREATE/ADDs (tables, columns, indexes, policies,
 *      functions, types, triggers) — the migration convention is `IF NOT EXISTS` idempotent DDL,
 *      so the regex extractors below are reliable in practice.
 *   3. Probes the live schema (information_schema / pg_class / pg_policies / pg_proc / pg_type /
 *      pg_trigger) to determine per file whether every one of its parsed objects is present.
 *   4. Records the audit result as ONE row per cluster in public.data_op_runs (idempotent via
 *      the unique key (workspace_id, spec_slug, script_path)):
 *        - status='ran'    if every file's DDL is live (cluster is fine — one lost its
 *                          schema_migrations row but its DDL executed some other way).
 *        - status='failed' with error naming the un-live files if any file has missing objects
 *          (a follow-up idempotent apply script, same shape as
 *          scripts/apply-media-buyer-cohort-excluded-all-customers-audience-migration.ts, needs
 *          to be authored + applied on the pooler).
 *
 * Ledger convention: workspace_id=null, spec_slug='unique-migration-version-guard-and-collision-
 * audit', script_path='scripts/_audit-collision-clusters.ts#<version>'.
 *
 * Read-only against the schema — this script NEVER runs the collision files' DDL. Fixing a
 * missing file requires a separate apply script (per the spec) so the human/Ada approval gate
 * governs any real apply.
 *
 *   Dry-run:  npx tsx scripts/_audit-collision-clusters.ts            # print cluster report, no DB writes
 *   Apply:    npx tsx scripts/_audit-collision-clusters.ts --apply    # write ledger rows
 *
 * See docs/brain/tables/data_op_runs.md for the ledger shape.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createAdminClient, pgClient } from "./_bootstrap";

const SPEC_SLUG = "unique-migration-version-guard-and-collision-audit";
const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

/** Version → filenames sharing that 14-digit prefix. Reads directly from disk. */
export function groupByVersion(dir: string): Map<string, string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const g = new Map<string, string[]>();
  for (const f of files) {
    const m = f.match(/^(\d{14})_/);
    if (!m) continue;
    const list = g.get(m[1]) ?? [];
    list.push(f);
    g.set(m[1], list);
  }
  return g;
}

/** Every collision cluster (size ≥ 2), sorted by version. */
export function collisions(dir: string): Array<{ version: string; files: string[] }> {
  const out: Array<{ version: string; files: string[] }> = [];
  for (const [version, files] of groupByVersion(dir)) {
    if (files.length > 1) out.push({ version, files });
  }
  return out.sort((a, b) => a.version.localeCompare(b.version));
}

/** Strip SQL comments so DDL parsing isn't fooled by prose in `--` or `/* *​/` blocks. */
function strip(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * A parsed DDL object a file creates/alters. The audit checks each against the live catalog to
 * decide whether the file's DDL is present.
 *
 *   table    → pg_class + pg_namespace where relkind='r' and nspname='public'
 *   column   → information_schema.columns where table_schema='public'
 *   index    → pg_class where relkind='i' and relnamespace = 'public'::regnamespace
 *   policy   → pg_policies where schemaname='public'
 *   function → pg_proc + pg_namespace where nspname='public' (name match; overload-agnostic)
 *   type     → pg_type + pg_namespace where nspname='public'
 *   trigger  → pg_trigger where NOT tgisinternal (name match)
 */
export interface ParsedObject {
  kind: "table" | "column" | "index" | "policy" | "function" | "type" | "trigger";
  table?: string;
  name: string;
}

const RE_CREATE_TABLE =
  /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const RE_ADD_COLUMN =
  /\balter\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
const RE_CREATE_INDEX =
  /\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\s+on\b/gi;
const RE_CREATE_POLICY =
  /\bcreate\s+policy\s+"?([a-z_][a-z0-9_]*)"?\s+on\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const RE_CREATE_FUNCTION =
  /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
const RE_CREATE_TYPE =
  /\bcreate\s+type\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const RE_CREATE_TRIGGER =
  /\bcreate\s+(?:or\s+replace\s+)?trigger\s+"?([a-z_][a-z0-9_]*)"?/gi;

export function extractObjects(sql: string): ParsedObject[] {
  const s = strip(sql);
  const out: ParsedObject[] = [];
  let m: RegExpExecArray | null;
  RE_CREATE_TABLE.lastIndex = 0;
  while ((m = RE_CREATE_TABLE.exec(s))) out.push({ kind: "table", name: m[1] });
  RE_ADD_COLUMN.lastIndex = 0;
  while ((m = RE_ADD_COLUMN.exec(s))) out.push({ kind: "column", table: m[1], name: m[2] });
  RE_CREATE_INDEX.lastIndex = 0;
  while ((m = RE_CREATE_INDEX.exec(s))) out.push({ kind: "index", name: m[1] });
  RE_CREATE_POLICY.lastIndex = 0;
  while ((m = RE_CREATE_POLICY.exec(s))) out.push({ kind: "policy", table: m[2], name: m[1] });
  RE_CREATE_FUNCTION.lastIndex = 0;
  while ((m = RE_CREATE_FUNCTION.exec(s))) out.push({ kind: "function", name: m[1] });
  RE_CREATE_TYPE.lastIndex = 0;
  while ((m = RE_CREATE_TYPE.exec(s))) out.push({ kind: "type", name: m[1] });
  RE_CREATE_TRIGGER.lastIndex = 0;
  while ((m = RE_CREATE_TRIGGER.exec(s))) out.push({ kind: "trigger", name: m[1] });
  return out;
}

/** Deduped snapshot of live objects (public schema) — one round-trip per catalog. */
interface LiveSchema {
  tables: Set<string>;
  columns: Set<string>; // "<table>.<column>"
  indexes: Set<string>;
  policies: Set<string>; // "<table>.<policy>"
  functions: Set<string>;
  types: Set<string>;
  triggers: Set<string>;
}

async function readLiveSchema(): Promise<LiveSchema> {
  const c = pgClient();
  await c.connect();
  try {
    const { rows: tables } = await c.query(
      `select c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    const { rows: cols } = await c.query(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'`,
    );
    const { rows: indexes } = await c.query(
      `select c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'i'`,
    );
    const { rows: policies } = await c.query(
      `select tablename, policyname
         from pg_policies
        where schemaname = 'public'`,
    );
    const { rows: functions } = await c.query(
      `select p.proname as name
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`,
    );
    const { rows: types } = await c.query(
      `select t.typname as name
         from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public'`,
    );
    const { rows: triggers } = await c.query(
      `select tgname as name
         from pg_trigger
        where not tgisinternal`,
    );
    return {
      tables: new Set(tables.map((r) => r.name as string)),
      columns: new Set(cols.map((r) => `${r.table_name}.${r.column_name}`)),
      indexes: new Set(indexes.map((r) => r.name as string)),
      policies: new Set(policies.map((r) => `${r.tablename}.${r.policyname}`)),
      functions: new Set(functions.map((r) => r.name as string)),
      types: new Set(types.map((r) => r.name as string)),
      triggers: new Set(triggers.map((r) => r.name as string)),
    };
  } finally {
    await c.end();
  }
}

/** True iff every parsed object appears in the live catalog snapshot. Empty objects → true (nothing to check). */
export function isFileLive(objs: ParsedObject[], live: LiveSchema): { live: boolean; missing: ParsedObject[] } {
  const missing: ParsedObject[] = [];
  for (const o of objs) {
    switch (o.kind) {
      case "table":    if (!live.tables.has(o.name))                       missing.push(o); break;
      case "column":   if (!live.columns.has(`${o.table}.${o.name}`))      missing.push(o); break;
      case "index":    if (!live.indexes.has(o.name))                      missing.push(o); break;
      case "policy":   if (!live.policies.has(`${o.table}.${o.name}`))     missing.push(o); break;
      case "function": if (!live.functions.has(o.name))                    missing.push(o); break;
      case "type":     if (!live.types.has(o.name))                        missing.push(o); break;
      case "trigger":  if (!live.triggers.has(o.name))                     missing.push(o); break;
    }
  }
  return { live: missing.length === 0, missing };
}

interface FileVerdict {
  file: string;
  objects: ParsedObject[];
  liveObjects: boolean;
  missing: ParsedObject[];
}

interface ClusterVerdict {
  version: string;
  files: FileVerdict[];
  /** True iff EVERY file in the cluster is fully live. */
  clusterLive: boolean;
}

function formatObj(o: ParsedObject): string {
  if (o.kind === "column" || o.kind === "policy") return `${o.kind}:${o.table}.${o.name}`;
  return `${o.kind}:${o.name}`;
}

function summarizeCluster(c: ClusterVerdict): string {
  const lines = [`== ${c.version} (${c.files.length} files) ${c.clusterLive ? "LIVE" : "PARTIAL"}`];
  for (const f of c.files) {
    const status = f.liveObjects ? "LIVE" : `MISSING(${f.missing.length})`;
    const objs = f.objects.length ? f.objects.map(formatObj).join(", ") : "no-parseable-objects";
    lines.push(`  - ${f.file}  ${status}`);
    lines.push(`      objects: ${objs}`);
    if (!f.liveObjects) {
      lines.push(`      missing: ${f.missing.map(formatObj).join(", ")}`);
    }
  }
  return lines.join("\n");
}

async function upsertLedger(
  admin: ReturnType<typeof createAdminClient>,
  cluster: ClusterVerdict,
): Promise<void> {
  const scriptPath = `scripts/_audit-collision-clusters.ts#${cluster.version}`;
  const unLive = cluster.files.filter((f) => !f.liveObjects);
  const nowIso = new Date().toISOString();
  const status = cluster.clusterLive ? "ran" : "failed";
  const error = cluster.clusterLive
    ? null
    : `un-live files in collision cluster ${cluster.version}: ${unLive
        .map((f) => `${f.file} [${f.missing.map(formatObj).join(", ") || "no-parseable-objects"}]`)
        .join("; ")}`;

  const { error: upsertErr } = await admin
    .from("data_op_runs")
    .upsert(
      {
        workspace_id: null,
        spec_slug: SPEC_SLUG,
        script_path: scriptPath,
        status,
        ran_at: cluster.clusterLive ? nowIso : null,
        error,
        updated_at: nowIso,
      },
      { onConflict: "workspace_id,spec_slug,script_path" },
    );
  if (upsertErr) throw new Error(`data_op_runs upsert failed for ${cluster.version}: ${upsertErr.message}`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const clusters = collisions(MIGRATIONS_DIR);

  console.log(`# collision-clusters audit — ${clusters.length} clusters`);
  if (clusters.length === 0) {
    console.log("no colliding version prefixes — nothing to audit.");
    return;
  }

  if (!apply) {
    console.log(`(dry-run — no DB reads, no ledger writes. Add --apply to probe schema + write data_op_runs rows.)`);
    for (const c of clusters) {
      const files: FileVerdict[] = c.files.map((f) => {
        const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        const objects = extractObjects(sql);
        return { file: f, objects, liveObjects: false, missing: [] };
      });
      console.log(
        `== ${c.version} (${c.files.length} files)\n` +
          files.map((f) => `  - ${f.file}\n      objects: ${f.objects.map(formatObj).join(", ") || "no-parseable-objects"}`).join("\n"),
      );
    }
    return;
  }

  const live = await readLiveSchema();
  console.log(
    `live schema: ${live.tables.size} tables, ${live.columns.size} columns, ${live.indexes.size} indexes, ${live.policies.size} policies, ${live.functions.size} functions, ${live.types.size} types, ${live.triggers.size} triggers`,
  );

  const admin = createAdminClient();
  const verdicts: ClusterVerdict[] = [];
  for (const c of clusters) {
    const files: FileVerdict[] = c.files.map((f) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      const objects = extractObjects(sql);
      const { live: fileLive, missing } = isFileLive(objects, live);
      return { file: f, objects, liveObjects: fileLive, missing };
    });
    const clusterLive = files.every((f) => f.liveObjects);
    const verdict: ClusterVerdict = { version: c.version, files, clusterLive };
    verdicts.push(verdict);
    console.log(summarizeCluster(verdict));
    await upsertLedger(admin, verdict);
  }

  const partial = verdicts.filter((v) => !v.clusterLive);
  console.log(
    `\n# summary: ${verdicts.length} clusters audited, ${verdicts.length - partial.length} fully live, ${partial.length} with un-live files.`,
  );
  if (partial.length) {
    console.log(`# clusters needing a follow-up idempotent apply script:`);
    for (const v of partial) {
      for (const f of v.files.filter((f) => !f.liveObjects)) {
        console.log(`  - ${f.file}  missing: ${f.missing.map(formatObj).join(", ") || "no-parseable-objects (needs manual review)"}`);
      }
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
