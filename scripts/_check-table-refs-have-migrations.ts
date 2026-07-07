/**
 * Static-analysis check: every `.from("<table>")` literal in src/ must reference a
 * table SOME migration in supabase/migrations creates.
 *
 * ci-guard-table-refs-have-migrations Phase 1. Grounded in the 2026-07-07
 * order_refunds incident (PR #1265 merged .from('order_refunds') reads/writes in
 * src/lib/refund.ts + action-executor + returns with no supabase/migrations file
 * creating the table; the spec-test mocked the admin client so the missing table
 * passed). This rail catches that shape at authoring time — a build that queries
 * a table no migration creates fails red, never merges green and ships inert.
 *
 * Rule:
 *   Every literal `.from("<name>")` / `.from('<name>')` in src/**\/*.{ts,tsx,js,mjs}
 *   must reference a name in {created ∪ renamed-to ∪ allowlist}. Dynamic
 *   `.from(variable)` refs are ignored — we can't statically resolve the target.
 *
 *   The created-set is built by parsing supabase/migrations/*.sql for
 *     create table [if not exists] [public.]<name>
 *   and applying `alter table [if exists] [public.]<old> rename to <new>` so a
 *   renamed table's NEW name is what's in the set (see the 20260518180000_rename
 *   _klaviyo_profile_events.sql profile_events case and the 20260705150000_worker
 *   _to_agent_rename.sql agent_* case). Same migrations-dir parser shape as
 *   scripts/_check-rls-on-new-tables.ts.
 *
 *   `.storage.from("<bucket>")` is explicitly skipped — Supabase Storage buckets
 *   are not tables.
 *
 * Fix for a violation:
 *   Either author the missing migration (supabase/migrations/YYYYMMDDNNNNNN_
 *   <name>.sql) that creates the table, or — if the ref is legitimately backed
 *   by a view / RPC / external system — add the name to
 *   scripts/_check-table-refs-have-migrations.allowlist.txt with a one-line
 *   reason.
 *
 * Wired into `npm run check:table-refs-have-migrations` + chained into `predeploy`
 * (Phase 2 — alongside check:rls-on-new-tables + check:no-hard-destructive-migrations)
 * + invoked in the box's build lane right after `tsc --noEmit` succeeds
 * (scripts/builder-worker.ts's completed-path gate) so a build that introduces
 * a `.from('newtable')` with no creating migration is marked FAILED by the box —
 * closing the "spec-test mocks the DB so a missing table passes" hole named in
 * the incident.
 *
 * Read-only; never mutates state.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

const REPO_ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
const SRC_DIR = join(REPO_ROOT, "src");
const ALLOWLIST_PATH = join(__dirname, "_check-table-refs-have-migrations.allowlist.txt");

const SRC_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

// --- SQL parsing ---------------------------------------------------------

// `create table [if not exists] [public.]<name>` — captures <name>.
const CREATE_TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
// `alter table [if exists] [public.]<old> rename to <new>` — captures <old> + <new>.
const RENAME_TABLE_RE = /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+rename\s+to\s+([a-z_][a-z0-9_]*)/gi;

/** Strip full-line SQL comments so header prose doesn't produce false matches. */
function stripSqlLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((l) => (/^\s*--/.test(l) ? "" : l))
    .join("\n");
}

/**
 * Walk supabase/migrations chronologically, apply create + rename statements, and
 * return the set of table names that would exist after every migration ran.
 */
export function buildCreatedTableSet(migrationsDir: string): Set<string> {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const created = new Set<string>();
  for (const file of files) {
    const sql = stripSqlLineComments(readFileSync(join(migrationsDir, file), "utf8"));
    for (const m of sql.matchAll(CREATE_TABLE_RE)) created.add(m[1].toLowerCase());
    for (const m of sql.matchAll(RENAME_TABLE_RE)) {
      const from = m[1].toLowerCase();
      const to = m[2].toLowerCase();
      // Only apply the rename if the origin was previously created — a rename of
      // a table we've never seen is either a no-op (`if exists`) or a rename of
      // a table created outside migrations (which we can't reason about either
      // way). Adding the new name here would give the check a free pass on a
      // create-less ref.
      if (created.has(from)) {
        created.delete(from);
        created.add(to);
      }
    }
  }
  return created;
}

// --- TS/JS scanning ------------------------------------------------------

// `.from("<name>")` or `.from('<name>')` — captures <name>. We deliberately only
// match single-quote or double-quote LITERAL string args; backtick-quoted, dynamic
// (`.from(variable)`), and dynamic-template (`.from(\`${…}\`)`) refs are ignored —
// their target can't be resolved statically.
const FROM_LITERAL_RE = /\.from\(\s*(['"])([a-z_][a-z0-9_]*)\1/gi;

/**
 * Strip TypeScript/JavaScript block + line comments so `.from("x")` in a doc
 * comment (see src/lib/control-tower/error-feed.ts) doesn't false-positive. This
 * is intentionally naive — a `//` or `/*` inside a string literal would be over-
 * stripped, but our downstream regex only looks for `.from(...)` matches, so an
 * accidental strip can only cause an UNDER-detection (a real ref hidden inside
 * a bizarre string), never a fake ref that wasn't in the source. Same trade the
 * SQL parser makes.
 */
function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, "");
}

export interface FromRef {
  table: string;
  file: string;
  line: number;
}

/**
 * Walk `srcDir` (recursively) and return every `.from("<name>")` literal ref,
 * skipping refs preceded by `.storage` (Supabase Storage buckets aren't tables).
 */
export function scanFromRefs(srcDir: string): FromRef[] {
  const refs: FromRef[] = [];
  const stack: string[] = [srcDir];
  while (stack.length) {
    const cur = stack.pop() as string;
    const s = statSync(cur);
    if (s.isDirectory()) {
      for (const entry of readdirSync(cur)) stack.push(join(cur, entry));
      continue;
    }
    if (!s.isFile()) continue;
    if (!SRC_EXTS.has(extname(cur))) continue;
    const raw = readFileSync(cur, "utf8");
    const stripped = stripTsComments(raw);
    for (const m of stripped.matchAll(FROM_LITERAL_RE)) {
      // Skip storage buckets (`.storage.from("bucket")`) — the ".from(" match
      // has index m.index; look 8 chars back for ".storage".
      const before = stripped.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0);
      if (/\.storage$/.test(before)) continue;
      const table = m[2].toLowerCase();
      // 1-based line number based on the stripped text (stable enough for the
      // error message pointer — an author can always grep the name).
      const line = stripped.slice(0, m.index ?? 0).split("\n").length;
      refs.push({ table, file: cur, line });
    }
  }
  return refs;
}

// --- Allowlist -----------------------------------------------------------

export function loadAllowlist(path: string): Set<string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Allow "<name>  # reason" or bare "<name>".
    const name = line.split(/\s+/, 1)[0].toLowerCase();
    if (/^[a-z_][a-z0-9_]*$/.test(name)) out.add(name);
  }
  return out;
}

// --- Composition ---------------------------------------------------------

export interface Violation {
  table: string;
  hits: FromRef[];
}

export function findViolations(opts: {
  srcDir: string;
  migrationsDir: string;
  allowlist: Set<string>;
}): Violation[] {
  const created = buildCreatedTableSet(opts.migrationsDir);
  const refs = scanFromRefs(opts.srcDir);
  const missing = new Map<string, FromRef[]>();
  for (const ref of refs) {
    if (created.has(ref.table) || opts.allowlist.has(ref.table)) continue;
    const list = missing.get(ref.table) ?? [];
    list.push(ref);
    missing.set(ref.table, list);
  }
  return [...missing.entries()]
    .map(([table, hits]) => ({ table, hits }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

function main(): void {
  const violations = findViolations({
    srcDir: SRC_DIR,
    migrationsDir: MIGRATIONS_DIR,
    allowlist: loadAllowlist(ALLOWLIST_PATH),
  });

  if (violations.length) {
    const totalHits = violations.reduce((n, v) => n + v.hits.length, 0);
    console.error(
      `\n❌ check-table-refs-have-migrations — ${violations.length} table(s) referenced in ` +
      `src/ but NOT created by any supabase/migrations file (${totalHits} ref site(s)):`,
    );
    for (const v of violations) {
      console.error(`  • ${v.table}`);
      for (const h of v.hits.slice(0, 5)) {
        console.error(`      ${h.file.replace(REPO_ROOT + "/", "")}:${h.line}`);
      }
      if (v.hits.length > 5) console.error(`      … +${v.hits.length - 5} more ref site(s)`);
    }
    console.error(
      `\nEvery table src/ queries via .from("<name>") must have a creating migration.\n` +
      `Fix (in the same PR that reaches the table):\n` +
      `  • Author supabase/migrations/YYYYMMDDNNNNNN_<name>.sql that creates it\n` +
      `    (see docs/brain/recipes/write-a-migration-apply-script.md), OR\n` +
      `  • If the ref is a view / RPC / external / renamed-outside-migration table,\n` +
      `    add the name to scripts/_check-table-refs-have-migrations.allowlist.txt\n` +
      `    with a one-line reason.\n\n` +
      `See docs/brain/operational-rules.md § Database is the spec.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-table-refs-have-migrations — every literal .from("<name>") in src/ has a creating migration.`,
  );
}

if (require.main === module) main();
