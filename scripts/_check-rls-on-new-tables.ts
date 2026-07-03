/**
 * Static-analysis check: every NEW public table has Row-Level Security enabled.
 *
 * Supabase's Security Advisor flags any `public.*` table without RLS as CRITICAL
 * ("RLS Disabled in Public"). We keep hitting it because new tables ship without
 * an `enable row level security` statement. This guard makes that a red CI failure
 * at authoring time instead of a dashboard surprise weeks later.
 *
 * Rule:
 *   Every table created in a migration whose timestamp is AFTER the last
 *   pg_tables RLS SWEEP (the catch-all 20260512000000_enable_rls_on_all_public_
 *   tables.sql and any later one — each enabled RLS on every table that existed
 *   at that moment) MUST have RLS enabled in some migration.
 *
 *   "RLS enabled" is recognized in the two house patterns:
 *     (a) a literal `alter table public.<t> enable row level security`, and
 *     (b) a dynamic loop — `FOREACH t IN ARRAY ARRAY['a','b',…]` + a
 *         `format(… ENABLE ROW LEVEL SECURITY …, t)` (e.g. the ad-tool migration).
 *         Every quoted name in that array counts as enabled.
 *
 *   Tables created on/before the latest sweep are grandfathered — the sweep's
 *   DO-block enabled them dynamically over pg_tables (no literal name to match).
 *
 * Fix for a violation: in the same migration that creates the table, add
 *   alter table public.<t> enable row level security;
 *   create policy <t>_service_role on public.<t>
 *     for all to service_role using (true) with check (true);
 * (plus a `for select to authenticated` policy only if the anon/auth client reads
 * it directly — most tables are service-role-only). See the backstop migration and
 * docs/brain/operational-rules.md § RLS on every new table.
 *
 * Wired into `npm run check:rls-on-new-tables` + chained into `predeploy`.
 * Read-only; never mutates state. Mirrors the `_check-no-md-spec-commits.ts` shape.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

// Fallback grandfather boundary: the first catch-all backstop. Superseded by any
// later pg_tables sweep detected below (SWEEP_RE). Tables created at/before the
// latest sweep are covered by it.
const CATCHALL_TS = "20260512000000";

interface CreatedTable { table: string; file: string; ts: string }

/** Strip full-line SQL comments so header prose doesn't produce false matches. */
function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((l) => (/^\s*--/.test(l) ? "" : l))
    .join("\n");
}

const CREATE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi;
// (a) literal enable: `alter table [only] public.<t> enable row level security`.
const ENABLE_RE = /alter\s+table\s+(?:only\s+)?public\.(\w+)\s+enable\s+row\s+level\s+security/gi;
// (b) dynamic loop enable: a `format(… ENABLE ROW LEVEL SECURITY …)` — when present,
// every table name listed in an `ARRAY[ '…', '…' ]` in the same file counts as enabled.
const DYNAMIC_ENABLE_RE = /format\s*\([^)]*enable\s+row\s+level\s+security/i;
const ARRAY_RE = /array\s*\[([^\]]*)\]/gi;
const ARRAY_ITEM_RE = /'([a-z_][a-z0-9_]*)'/gi;
// A pg_tables RLS sweep (the catch-all shape): enables RLS on all existing tables.
const SWEEP_RE = /pg_tables[\s\S]*rowsecurity[\s\S]*enable\s+row\s+level\s+security/i;

function main(): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  // earliest create-migration timestamp per table
  const created = new Map<string, CreatedTable>();
  // every table that gets RLS enabled anywhere (literal or dynamic-loop)
  const rlsEnabled = new Set<string>();
  // latest pg_tables sweep timestamp — tables created at/before it are grandfathered
  let sweepBoundaryTs = CATCHALL_TS;

  for (const file of files) {
    const ts = file.slice(0, 14);
    const sql = stripLineComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

    for (const m of sql.matchAll(CREATE_RE)) {
      const table = m[1];
      const prev = created.get(table);
      if (!prev || ts < prev.ts) created.set(table, { table, file, ts });
    }
    for (const m of sql.matchAll(ENABLE_RE)) rlsEnabled.add(m[1]);

    // Dynamic-loop enable: harvest ARRAY['a','b',…] table names when the file
    // does a format(...ENABLE ROW LEVEL SECURITY...).
    if (DYNAMIC_ENABLE_RE.test(sql)) {
      for (const arr of sql.matchAll(ARRAY_RE)) {
        for (const item of arr[1].matchAll(ARRAY_ITEM_RE)) rlsEnabled.add(item[1]);
      }
    }

    // A pg_tables sweep grandfathers everything created up to its timestamp.
    if (SWEEP_RE.test(sql) && ts > sweepBoundaryTs) sweepBoundaryTs = ts;
  }

  const violations = [...created.values()]
    .filter((c) => c.ts > sweepBoundaryTs && !rlsEnabled.has(c.table))
    .sort((a, b) => a.ts.localeCompare(b.ts));

  if (violations.length) {
    console.error(`\n❌ check-rls-on-new-tables — ${violations.length} public table(s) created without RLS:`);
    for (const v of violations) console.error(`  • public.${v.table}  (${v.file})`);
    console.error(
      `\nEvery new public.* table must enable Row-Level Security, or Supabase's Security Advisor\n` +
      `flags it CRITICAL. In the migration that creates the table, add:\n\n` +
      `  alter table public.<t> enable row level security;\n` +
      `  create policy <t>_service_role on public.<t>\n` +
      `    for all to service_role using (true) with check (true);\n\n` +
      `(add a \`for select to authenticated\` policy only if the anon/auth client reads it directly —\n` +
      `most tables are service-role-only). See docs/brain/operational-rules.md § RLS on every new table.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-rls-on-new-tables — ${created.size} public table(s) tracked; ` +
    `all created after the latest RLS sweep (${sweepBoundaryTs}) enable RLS.`,
  );
}

main();
