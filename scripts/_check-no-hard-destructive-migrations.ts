/**
 * Static-analysis check: no bare hard-destroy statement in a migration.
 *
 * destructive-migration-safety-rails Phase 2. The authoring rail that pairs with
 * the runtime rail (src/lib/migration-safety.ts's `classifyMigrationSql`): the
 * runtime rail binds Ada at approval time, this rail binds the AUTHOR at file
 * write time so a hard-destroy never gets checked in unless it carries a
 * per-statement `-- reversible: <reason>` opt-out.
 *
 * Rule:
 *   Every NEW migration (timestamp ≥ GRANDFATHER_TS) must NOT contain any of:
 *     - `DROP TABLE`
 *     - `DROP COLUMN`
 *     - `TRUNCATE`
 *   unless the statement carries an inline `-- reversible: <reason>` comment on
 *   the SAME line or the immediately preceding non-blank line. The reversible-
 *   by-default path (see docs/brain/operational-rules.md § Reversible-by-default
 *   DB changes) is `ALTER TABLE public.x RENAME TO _deprecated_x_{yyyymmdd}` +
 *   a scheduled follow-up drop; row deletes go through soft-delete/tombstone;
 *   real GDPR/CCPA compliance hard-delete flows through a separate audited
 *   data-subject-deletion tool, never an ad-hoc migration.
 *
 *   Older migrations (timestamp < GRANDFATHER_TS) are exempt — they pre-date
 *   this rail. Same grandfather pattern as `_check-rls-on-new-tables.ts`.
 *
 * Fix for a violation:
 *   Rewrite the DROP as a rename-and-expire:
 *     alter table public.x rename to _deprecated_x_20260703;
 *   OR add the annotation naming why the hard-destroy is safe:
 *     drop table public._deprecated_x_20260601;   -- reversible: 30d deprecation window elapsed
 *
 * Wired into `npm run check:no-hard-destructive-migrations` + chained into `predeploy`.
 * Read-only; never mutates state.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

// Migrations authored on/after this timestamp must comply. Everything before is
// grandfathered — the rail can't rewrite already-applied history, and Phase 1's
// runtime classifier catches the same shape at approval time regardless.
const GRANDFATHER_TS = "20260703000000";

const DESTRUCTIVE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "DROP TABLE",  re: /\bdrop\s+table\b/i },
  { name: "DROP COLUMN", re: /\bdrop\s+column\b/i },
  { name: "TRUNCATE",    re: /\btruncate\b/i },
];

const ANNOTATION_RE = /--\s*reversible\s*:/i;

interface Violation { file: string; line: number; text: string; pattern: string }

/** Strip block comments `/* … *​/` (single-level is enough for our detection). Line
 * comments are left in place because we still want to see the `-- reversible: …`
 * annotation as text — line-by-line matching handles those below. */
function stripBlockComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** True iff `line` OR the immediately preceding non-blank line carries the annotation. */
function hasAnnotation(lines: string[], i: number): boolean {
  if (ANNOTATION_RE.test(lines[i])) return true;
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (t.length === 0) continue;
    return ANNOTATION_RE.test(lines[j]);
  }
  return false;
}

export function scanMigrationsDir(dir: string): Violation[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const violations: Violation[] = [];
  for (const file of files) {
    const ts = file.slice(0, 14);
    if (ts < GRANDFATHER_TS) continue;
    const sql = stripBlockComments(readFileSync(join(dir, file), "utf8"));
    const lines = sql.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      // Skip pure line comments — they're prose, not statements.
      if (/^\s*--/.test(raw)) continue;
      for (const p of DESTRUCTIVE_PATTERNS) {
        if (p.re.test(raw)) {
          if (hasAnnotation(lines, i)) continue;
          violations.push({ file, line: i + 1, text: raw.trim(), pattern: p.name });
        }
      }
    }
  }
  return violations;
}

function main(): void {
  const violations = scanMigrationsDir(MIGRATIONS_DIR);
  if (violations.length) {
    console.error(`\n❌ check-no-hard-destructive-migrations — ${violations.length} bare destructive statement(s):`);
    for (const v of violations) {
      console.error(`  • ${v.file}:${v.line}  [${v.pattern}]  ${v.text}`);
    }
    console.error(
      `\nHard-destroy statements (DROP TABLE / DROP COLUMN / TRUNCATE) must not land in a\n` +
      `migration without an explicit -- reversible: <reason> opt-out.\n\n` +
      `Reversible replacements (see docs/brain/operational-rules.md § Reversible-by-default DB changes):\n` +
      `  • Table drop  → alter table public.x rename to _deprecated_x_YYYYMMDD;\n` +
      `  • Column drop → alter table public.x rename column y to _deprecated_y_YYYYMMDD;\n` +
      `  • Row delete  → soft-delete flag (deleted_at / status), not TRUNCATE.\n\n` +
      `If a hard-destroy is genuinely correct (e.g. the scheduled follow-up after a deprecation\n` +
      `window), annotate the statement:\n` +
      `  drop table public._deprecated_x_20260601;   -- reversible: 30d deprecation window elapsed\n`,
    );
    process.exit(1);
  }
  console.log(`✓ check-no-hard-destructive-migrations — no bare destructive statements in migrations ≥ ${GRANDFATHER_TS}.`);
}

if (require.main === module) main();
