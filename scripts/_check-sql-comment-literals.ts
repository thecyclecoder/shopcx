/**
 * Static-analysis check: every `COMMENT ON ... IS` payload under supabase/migrations/*.sql must be
 * a single string literal (or NULL) — never a concatenated expression.
 *
 * Postgres' `COMMENT ON ... IS` grammar takes a string LITERAL, not an expression. A `||`
 * concatenation there is a PARSE error (SQLSTATE 42601), and a parse error is unrecoverable in a
 * way an execution error is not: it kills the statement before anything runs, no matter how many
 * times it is retried.
 *
 * Why that matters more than a cosmetic comment: `applyMergedMigrations` in
 * [[../src/lib/control-tower/migration-drift.ts]] splits a migration into statements, runs each in
 * its own savepoint, and — by design — records NOTHING when a statement fails for a reason other
 * than duplicate-object ("the file is broken; leave the version unrecorded for human review").
 * So one `||` in a trailing comment leaves the whole migration version permanently unrecorded:
 * every Control Tower tick re-reads the file, re-runs the idempotent DDL as a no-op, re-throws
 * 42601 on the comment, and never advances. The migration sits in the merged-but-unapplied set
 * forever, the drift tile can never go green, a GENUINELY unapplied migration hides in the same
 * list, and Postgres logs an error on every tick.
 *
 * That is exactly what `20261119120000_creative_skeletons_do_not_use.sql` did: its columns and
 * index landed on the first tick, its two comments never did, and it re-fired 42601 every 30
 * minutes (~48/day) until the file itself was fixed — manual application could not clear it,
 * because the failure is at parse time.
 *
 * Rule (verified empirically against Postgres — see the test file):
 *   For every `comment on ... is <payload>;` statement, `<payload>` must be the keyword NULL, one
 *   single-quoted literal, or several literals separated by whitespace CONTAINING A NEWLINE — the
 *   SQL-standard implicit continuation, which is the house style across ~37 migrations and stays
 *   legal. Same-line adjacency (`'a ' 'b'`) and `||` concatenation are both 42601.
 *
 * Fix for a violation:
 *   Drop the `||` and let the newline do the concatenation — `''` escapes stay doubled:
 *     -  comment on column t.c is 'first half ' ||
 *     -    'second half';
 *     +  comment on column t.c is 'first half '
 *     +    'second half';
 *
 * Wired into `npm run check:sql-comment-literals` + chained into `predeploy` alongside the sibling
 * `_check-duplicate-migration-versions.ts` / `_check-no-hard-destructive-migrations.ts`.
 *
 * Read-only; never mutates state.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

/** One offending `COMMENT ON` statement. */
export interface Violation {
  file: string;
  /** 1-indexed line where the statement starts. */
  line: number;
  /** The offending statement, collapsed to one line for the error report. */
  statement: string;
}

/** A `COMMENT ON` statement found in a script, with its source offset. */
interface CommentStatement {
  text: string;
  offset: number;
}

/**
 * Scan `sql` and return every top-level `COMMENT ON ... ;` statement. Quote-aware: `;` inside a
 * single-quoted literal (including `''` escapes), a dollar-quoted body, a `--` line comment, or a
 * block comment never terminates a statement.
 */
function findCommentStatements(sql: string): CommentStatement[] {
  const out: CommentStatement[] = [];
  let start = 0;
  let i = 0;
  const pushIfComment = (end: number) => {
    const text = sql.slice(start, end);
    if (/^\s*comment\s+on\b/i.test(text)) {
      out.push({ text: text.trim(), offset: start + (text.length - text.trimStart().length) });
    }
  };
  while (i < sql.length) {
    const ch = sql[i];
    // Line comment.
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    // Block comment (Postgres nests them).
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }
    // Single-quoted literal — `''` is an escaped quote, not a terminator.
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Double-quoted identifier.
    if (ch === '"') {
      i++;
      while (i < sql.length && sql[i] !== '"') i++;
      i++;
      continue;
    }
    // Dollar-quoted body ($$ ... $$ / $tag$ ... $tag$).
    if (ch === "$") {
      const m = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? sql.length : close + tag.length;
        continue;
      }
    }
    if (ch === ";") {
      pushIfComment(i);
      i++;
      start = i;
      continue;
    }
    i++;
  }
  pushIfComment(sql.length);
  return out;
}

/** One single-quoted literal, `''` escapes and embedded newlines allowed. */
const ONE_LITERAL = /^'(?:[^']|'')*'/;

/**
 * True iff `payload` is a legal `COMMENT ON ... IS` argument. Verified empirically against
 * Postgres — only three forms exist, and two of them are parse errors:
 *
 *   'a '\n'b'   → OK. SQL-standard implicit continuation: "two string constants separated only
 *                 by whitespace WITH AT LEAST ONE NEWLINE are concatenated." This is the house
 *                 style across ~37 migrations and is deliberately preserved.
 *   'a ' 'b'    → 42601. Same-line adjacency is NOT continuation.
 *   'a ' || 'b' → 42601. COMMENT takes a literal, not an expression.
 */
function isLegalPayload(payload: string): boolean {
  const s = payload.trim();
  if (/^null$/i.test(s)) return true;
  let rest = s;
  let first = true;
  while (rest.length) {
    const m = ONE_LITERAL.exec(rest);
    if (!m) return false;
    first = false;
    rest = rest.slice(m[0].length);
    if (!rest.length) break;
    // A following literal is only a continuation when the gap contains a newline.
    const gap = /^\s*/.exec(rest)![0];
    if (!gap.includes("\n")) return false;
    rest = rest.slice(gap.length);
  }
  return !first;
}

/**
 * True iff `statement`'s `IS` payload is a legal literal (or NULL). The payload is everything
 * after the first top-level `IS` keyword — quote-aware so an `is` inside a quoted identifier or
 * literal is never matched.
 */
export function hasLiteralPayload(statement: string): boolean {
  const m = /\bis\b/i.exec(stripQuoted(statement));
  if (!m) return false;
  return isLegalPayload(statement.slice(m.index + m[0].length));
}

/**
 * Blank out quoted spans (preserving offsets) so a keyword scan can't match inside a literal or a
 * quoted identifier — e.g. `comment on column t."is" is 'x'` must find the SECOND `is`.
 */
function stripQuoted(s: string): string {
  const chars = s.split("");
  let i = 0;
  while (i < chars.length) {
    const q = chars[i];
    if (q !== "'" && q !== '"') { i++; continue; }
    const open = i;
    i++;
    while (i < chars.length) {
      if (chars[i] === q) {
        if (q === "'" && chars[i + 1] === "'") { i += 2; continue; }
        break;
      }
      i++;
    }
    for (let k = open; k <= Math.min(i, chars.length - 1); k++) chars[k] = " ";
    i++;
  }
  return chars.join("");
}

/** Every `COMMENT ON` statement in `sql` whose payload is not a bare literal. */
export function findExpressionComments(sql: string, file: string): Violation[] {
  return findCommentStatements(sql)
    .filter((s) => !hasLiteralPayload(s.text))
    .map((s) => ({
      file,
      line: sql.slice(0, s.offset).split("\n").length,
      statement: s.text.replace(/\s+/g, " ").slice(0, 160),
    }));
}

/** Scan every *.sql under `migrationsDir`. */
export function scanMigrations(migrationsDir: string): Violation[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => findExpressionComments(readFileSync(join(migrationsDir, f), "utf8"), f));
}

function main(): void {
  const violations = scanMigrations(MIGRATIONS_DIR);
  if (violations.length) {
    console.error(
      `\n❌ check-sql-comment-literals — ${violations.length} COMMENT ON statement${violations.length === 1 ? "" : "s"} with a non-literal payload:`,
    );
    for (const v of violations) console.error(`  • ${v.file}:${v.line}  ${v.statement}`);
    console.error(
      `\nPostgres' COMMENT ON ... IS grammar takes a string LITERAL, not an expression — a ||\n` +
        `concatenation there is a PARSE error (42601). applyMergedMigrations records NOTHING for a\n` +
        `file with a failing statement, so the migration version stays unrecorded and the Control\n` +
        `Tower re-runs it — and re-logs the error — on every tick, forever.\n\n` +
        `Fix: collapse the concatenation into one literal (keep '' escapes doubled):\n` +
        `  -  comment on column t.c is 'first half ' || 'second half';\n` +
        `  +  comment on column t.c is 'first half second half';\n`,
    );
    process.exit(1);
  }
  console.log(`✓ check-sql-comment-literals — every COMMENT ON payload is a bare string literal.`);
}

if (require.main === module) main();
