/**
 * Static-analysis check: NO `.like(` / `.ilike(` whose first argument is a UUID column.
 *
 * SPEC: no-sql-pattern-match-on-a-uuid-column Phase 1.
 *
 * Postgres has NO pattern-match operator for `uuid`. A `.like("id", "abc%")` on a uuid column
 * throws `operator does not exist: uuid ~~ unknown` at runtime; a `.ilike("id", …)` is worse — it
 * returns ZERO ROWS with no error at all, which reads exactly like "nothing matched". Both shapes
 * survived review, merged, and hit prod (Brittany's loyalty backfill sat unrun for two days
 * because every one of its three lookups threw; the authoring-lane probe read a real parked build
 * as "gone" via the silent variant). tsc cannot see this — the column type is not in the
 * TypeScript types — so a static guard is the only place a repeat can be stopped.
 *
 * WHAT WE FLAG:
 *   a `.like(` or `.ilike(` whose FIRST STRING argument names a UUID column in this schema.
 *   Resolved from a maintained UUID_COLUMNS list — NOT a blanket `_id` heuristic, because several
 *   `*_id` columns here are deliberately TEXT and must keep working (`shopify_contract_id`,
 *   `shopify_order_id`, `shopify_customer_id`, `shopify_return_gid`, `meta_ad_id`, `ticket_id`
 *   where it stores an external ref, `spec_slug`, etc.). A false NEGATIVE is acceptable; a false
 *   POSITIVE that blocks a legitimate text match is NOT.
 *
 * DO NOT FLAG:
 *   a pattern match on a genuine text column (`description`, `body`, `purpose`, `actor`,
 *   `event_type`, `outcome`, `instructions`, `error`, `slot`, `action_kind`, `owner`, `title`,
 *   `code`, `discount_code`, `email`, `last_name`, `phone`, `spec_slug`, `order_number`, …).
 *
 * ESCAPE HATCH: `// uuid-like-ok: <reason>` on the SAME line or the LINE ABOVE the match.
 *   The rare site where the column IS actually a text column that shares a name in the list
 *   (a nested object key, a joined-table column that happens to be text, etc.). Satisfiable
 *   without weakening the guard.
 *
 * SCAN SCOPE: every `.ts`/`.tsx` under `src/` and `scripts/`, EXCEPT:
 *   - the guard's own file (this one), which names the pattern in its docstring.
 *   - the guard's own test file — the fixture strings would flag themselves.
 *   - `*.test.ts` / `*.spec.ts` — a test may reason about the anti-pattern shape in comments.
 *
 * Read-only; never mutates state. Wired into `npm run check:no-uuid-like` + chained into
 * `predeploy:static`. Mirrors `_check-no-lossy-error-stringify.ts`.
 *
 * Run:  npx tsx scripts/_check-no-uuid-like.ts             # exits 1 on any violation
 *       npx tsx scripts/_check-no-uuid-like.ts --summary   # one-line-per-finding view
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_check-no-uuid-like.ts. */
const REPO_ROOT = join(__dirname, "..");

/** Files skipped even though they match the scan scope. */
const SKIP_FILES = new Set<string>([
  "scripts/_check-no-uuid-like.ts", // this file
  "scripts/_check-no-uuid-like.test.ts", // its own test — the fixture strings would flag
]);

/**
 * Maintained UUID-column list. Seeded with the columns proven `uuid` by the two incidents this
 * guard closes: bare `id` (every `public.*` primary key in this schema), and the well-known FKs
 * that appear across many tables — `member_id`, `customer_id`, `workspace_id`, `spec_id`,
 * `phase_id`, `subscription_id`, `job_id`. Extend when a new provably-uuid column becomes an
 * incident — a wrong ADD is only a false positive, satisfiable with an `// uuid-like-ok:` hatch.
 */
const UUID_COLUMNS = new Set<string>([
  "id",
  "member_id",
  "customer_id",
  "workspace_id",
  "spec_id",
  "phase_id",
  "subscription_id",
  "job_id",
]);

/**
 * `.like(` or `.ilike(` followed by a string-literal first argument. Captures:
 *   1 — the method name (`like` or `ilike`), so the failure message is precise.
 *   2 — the quote character (', ", or `), matched later to the same closing.
 *   3 — the column-name literal itself (the argument that we compare to UUID_COLUMNS).
 * A trailing `,` or `)` is required so a call like `.like("id",` matches but a substring
 * `.likelihood("id"` does not. Non-global — used repeatedly with lastIndex.
 */
const LIKE_CALL = /\.(i?like)\s*\(\s*(['"`])([^'"`]+)\2\s*[,)]/g;

/** Same-line-or-line-above escape hatch. */
const ESCAPE = /\/\/\s*uuid-like-ok\b/;

/* ------------------------------------------------------------------------------------------------
 * Scope resolution — mirrors _check-no-lossy-error-stringify.
 * --------------------------------------------------------------------------------------------- */

function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function scanFiles(): string[] {
  const files = new Set<string>();
  for (const root of ["src", "scripts"]) {
    for (const abs of walkTs(join(REPO_ROOT, root))) {
      if (/\.(test|spec)\.tsx?$/.test(abs)) continue;
      files.add(abs);
    }
  }
  return [...files].sort();
}

/* ------------------------------------------------------------------------------------------------
 * Findings.
 * --------------------------------------------------------------------------------------------- */

interface Finding {
  file: string;
  line: number;
  method: "like" | "ilike";
  column: string;
  snippet: string;
}

/** Compute 1-based line number for a char index in `text`. Cheap linear scan — files are small. */
function lineOf(text: string, idx: number): number {
  let line = 1;
  const cap = Math.min(idx, text.length);
  for (let i = 0; i < cap; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** True if the match is inside a line comment (`//`) or a JSDoc continuation line (`* …`). */
function inCommentContext(lineText: string, colIdx: number): boolean {
  if (/^\s*\*(?:\s|$)/.test(lineText)) return true; // JSDoc continuation
  const commentStart = lineText.indexOf("//");
  if (commentStart !== -1 && commentStart < colIdx) return true;
  return false;
}

/** True if `line` (1-based) has the escape hatch on same/previous line. */
function hasEscape(lines: string[], line: number): boolean {
  const cur = lines[line - 1] ?? "";
  const prev = lines[line - 2] ?? "";
  return ESCAPE.test(cur) || ESCAPE.test(prev);
}

/** Scan one file's text for `.like`/`.ilike` calls whose first arg is a UUID column. */
export function findUuidLikeCalls(rel: string, text: string): Finding[] {
  const lines = text.split("\n");
  const out: Finding[] = [];
  LIKE_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIKE_CALL.exec(text))) {
    const method = m[1] as "like" | "ilike";
    const column = m[3];
    if (!UUID_COLUMNS.has(column)) continue;
    const line = lineOf(text, m.index);
    const cur = lines[line - 1] ?? "";
    const colIdx = cur.indexOf(m[0]);
    if (inCommentContext(cur, colIdx === -1 ? 0 : colIdx)) continue;
    if (hasEscape(lines, line)) continue;
    out.push({ file: rel, line, method, column, snippet: cur.trim().slice(0, 160) });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * --------------------------------------------------------------------------------------------- */

function main() {
  const summary = process.argv.includes("--summary");
  const files = scanFiles();
  const findings: Finding[] = [];
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (SKIP_FILES.has(rel)) continue;
    const text = readFileSync(abs, "utf8");
    if (!text.includes(".like(") && !text.includes(".ilike(")) continue; // quick reject
    findings.push(...findUuidLikeCalls(rel, text));
  }

  if (summary) {
    console.log(
      `no-uuid-like — ${files.length} file(s) scanned, ${findings.length} uuid-like site(s) found`,
    );
    for (const f of findings) {
      console.log(`  [${f.method}] ${f.file}:${f.line}  column="${f.column}"  ${f.snippet}`);
    }
  }

  if (findings.length > 0) {
    console.error(
      `\n❌ check-no-uuid-like — ${findings.length} pattern match on a uuid column found:\n`,
    );
    for (const f of findings) {
      console.error(`  • ${f.file}:${f.line}  →  ${f.snippet}`);
      console.error(`      .${f.method}("${f.column}", …)  —  column "${f.column}" is uuid`);
    }
    console.error(
      `\nno-sql-pattern-match-on-a-uuid-column — Postgres has NO pattern-match operator for uuid.\n` +
      `\`.like("id", "abc%")\` throws \`operator does not exist: uuid ~~ unknown\` at runtime;\n` +
      `\`.ilike("id", "abc%")\` is worse — it returns ZERO ROWS with no error at all, which reads\n` +
      `exactly like "nothing matched". Fix by RESOLVING THE FULL UUID and using \`.eq()\`:\n` +
      `\n` +
      `  // instead of  .like("id", \`\${PREFIX}%\`)                       (throws)\n` +
      `  // or          .ilike("id", \`\${PREFIX}%\`)                      (silently returns nothing)\n` +
      `  const { data } = await admin.from("<t>").select("id").eq("id", FULL_UUID);\n` +
      `\n` +
      `If a genuine prefix match is unavoidable, cast to text in SQL:\n` +
      `\n` +
      `  where id::text like $1\n` +
      `\n` +
      `If the column IS actually text in this file (a joined-table column, a nested key that\n` +
      `shares a name in the UUID_COLUMNS list), add a same-line or line-above line-comment escape:\n` +
      `\n` +
      `  // uuid-like-ok: joined view column is text\n` +
      `  .like("id", "foo%")\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-no-uuid-like — ${files.length} file(s) scanned; 0 uuid-column pattern match(es).`,
  );
}

if (require.main === module) main();
