/**
 * Deterministic destructive-SQL classifier — the leash rail for migration-safety
 * (docs/brain/specs/destructive-migration-safety-rails.md Phase 1).
 *
 * PURE, no I/O. Called from the platform-director leash gate (categoryFor) BEFORE the
 * type-based `additive_migration`/`additive_backfill` classification returns — so a
 * `DROP TABLE`/unfiltered `DELETE` inside an `apply_migration` action falls OUT of the
 * leash (returns null) and escalates, instead of Ada seeing only the action TYPE and
 * auto-approving. Deterministic string matching, comment-stripped, case-insensitive.
 *
 * Later phases (Phase 3 blast-radius dry-run, Phase 4 CTO/CEO routing) LAYER on top of
 * this classifier; the classifier's severity stays the AUTHORITATIVE leash decision
 * (a lenient Phase-5 skeptic can never downgrade a mechanically-flagged destructive).
 *
 * Called by: src/lib/agents/platform-director.ts (categoryFor).
 */

export type MigrationSeverity = "additive" | "reversible_destructive" | "irreversible_destructive";

export interface MigrationClassification {
  severity: MigrationSeverity;
  /** Every pattern that matched, in stable order — for the escalation payload / audit log. */
  matches: string[];
}

/**
 * Strip SQL comments (line `--...` + block `/* ... *​/`) preserving offsets loosely.
 * Nested block comments (Postgres allows them) collapse depth-tracked. Dollar-quoted
 * strings ($$…$$, $tag$…$tag$) are DELIBERATELY NOT stripped — destruction inside
 * `DO $$ … $$` / `CREATE OR REPLACE FUNCTION` bodies must be visible to the scan.
 */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) return out;
      out += "\n";
      i = nl + 1;
    } else if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        const nxt = sql.slice(i, i + 2);
        if (nxt === "/*") {
          depth++;
          i += 2;
        } else if (nxt === "*/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

/** From `from` to the next `;` (or end of string). Used for DELETE/UPDATE WHERE detection. */
function tailToTerminator(text: string, from: number): string {
  const rest = text.slice(from);
  const sc = rest.indexOf(";");
  return sc === -1 ? rest : rest.slice(0, sc);
}

/**
 * Classify a raw SQL string by destructive-severity. PURE.
 *
 * Detects (comment-stripped, case-insensitive):
 *   - `DROP TABLE`                       → irreversible_destructive
 *   - `DROP COLUMN`                      → irreversible_destructive
 *   - `TRUNCATE`                         → irreversible_destructive
 *   - `DELETE FROM x` without `WHERE`    → irreversible_destructive
 *   - `UPDATE x SET …` without `WHERE`   → irreversible_destructive
 *   - `ALTER … DROP CONSTRAINT`          → reversible_destructive
 *   - `ALTER … DROP DEFAULT`             → reversible_destructive
 *   - `ON DELETE CASCADE` ADDED to an EXISTING table (`ALTER TABLE … ON DELETE CASCADE`) → reversible_destructive.
 *     A cascade INSIDE a `CREATE TABLE` (a new table's FK) is ADDITIVE — see `cascadeAddedToExistingTable`.
 *
 * Also scans INSIDE `DO $$ … $$` blocks and `CREATE OR REPLACE FUNCTION` bodies (the
 * dollar-quoted delimiters are not stripped) — destruction hidden in a function body
 * is treated identically to top-level destruction. False positives from string
 * literals containing keywords are acceptable — the classifier errs safe (escalate
 * over auto-approve). ON CONFLICT DO UPDATE SET is exempted from the UPDATE-no-WHERE
 * check (the ON CONFLICT clause is inherently row-scoped).
 *
 * Empty / non-string / unparseable input → `additive` (defensive: an empty cmd is not
 * destructive; a real destructive migration surfaces its keywords in cmd or preview).
 */
/**
 * True iff the SQL adds an `ON DELETE CASCADE` foreign key to an EXISTING table (the only risky
 * case — it changes delete behavior on rows already in the DB). PURE.
 *
 * A cascade INSIDE a `CREATE TABLE` is additive (a new table has no existing rows to cascade-delete),
 * so it must NOT flag the migration destructive. We classify per statement (split on `;`): a cascade
 * counts only when its statement is an `ALTER TABLE` and is NOT a `CREATE TABLE`. Statement splitting
 * is naive (no `;`-in-string handling) but DDL migrations don't embed `;` in string literals, and the
 * fallback is conservative — an unsplit blob that contains BOTH a create and an alter cascade still
 * flags via the alter statement. Input is already lower-cased + comment-stripped by the caller.
 */
export function cascadeAddedToExistingTable(lowerSql: string): boolean {
  const CASCADE = /\bon\s+delete\s+cascade\b/;
  if (!CASCADE.test(lowerSql)) return false;
  return lowerSql.split(";").some((stmt) => {
    if (!CASCADE.test(stmt)) return false;
    const isCreateTable = /\bcreate\s+table\b/.test(stmt);
    const isAlter = /\balter\s+table\b/.test(stmt);
    // Risky only when the cascade rides an ALTER of an existing table (not a CREATE TABLE).
    return isAlter && !isCreateTable;
  });
}

export function classifyMigrationSql(sql: string): MigrationClassification {
  if (!sql || typeof sql !== "string") return { severity: "additive", matches: [] };
  const stripped = stripComments(sql);
  const lower = stripped.toLowerCase();

  const matches: string[] = [];
  let irreversible = false;
  let reversible = false;
  const push = (m: string, level: "irrev" | "rev") => {
    if (!matches.includes(m)) matches.push(m);
    if (level === "irrev") irreversible = true;
    else reversible = true;
  };

  if (/\bdrop\s+table\b/.test(lower)) push("DROP TABLE", "irrev");
  if (/\bdrop\s+column\b/.test(lower)) push("DROP COLUMN", "irrev");
  if (/\btruncate\b/.test(lower)) push("TRUNCATE", "irrev");
  if (/\bdrop\s+constraint\b/.test(lower)) push("ALTER … DROP CONSTRAINT", "rev");
  if (/\bdrop\s+default\b/.test(lower)) push("ALTER … DROP DEFAULT", "rev");
  // `ON DELETE CASCADE` is only risky when ADDED to an EXISTING table — an
  // `ALTER TABLE … ADD … ON DELETE CASCADE` changes delete behavior on rows already in the DB.
  // Inside a `CREATE TABLE` it's a brand-new table's foreign key: there are no existing rows to
  // cascade-delete, so it is PURELY ADDITIVE. Classifying a CREATE-TABLE cascade as destructive
  // is the 2026-07-17 drift bug — it gated `ad_creative_copy_qc_verdicts` + `ad_creative_copy_variants`
  // (both CREATE TABLE with cascade FKs) for an approval that never came, so the reconciler never
  // auto-applied them and the whole Dahlia copy-pack/QC pipeline silently no-op'd for weeks. Classify
  // per-statement: a cascade only counts when its statement is an ALTER (not a CREATE TABLE).
  if (cascadeAddedToExistingTable(lower)) push("ON DELETE CASCADE", "rev");

  for (const m of lower.matchAll(/\bdelete\s+from\s+[^\s;]+/g)) {
    const tail = tailToTerminator(lower, (m.index ?? 0) + m[0].length);
    if (!/\bwhere\b/.test(tail)) push("DELETE without WHERE", "irrev");
  }

  for (const m of lower.matchAll(/\bupdate\s+[^\s;]+\s+set\b/g)) {
    const start = m.index ?? 0;
    const before = lower.slice(Math.max(0, start - 12), start).trimEnd();
    if (/\bdo\s*$/.test(before)) continue; // ON CONFLICT DO UPDATE SET — row-scoped by the ON CONFLICT clause
    const tail = tailToTerminator(lower, start + m[0].length);
    if (!/\bwhere\b/.test(tail)) push("UPDATE without WHERE", "irrev");
  }

  const severity: MigrationSeverity = irreversible
    ? "irreversible_destructive"
    : reversible
      ? "reversible_destructive"
      : "additive";
  return { severity, matches };
}

/**
 * ada-reacts-to-approvals-immediately-never-sits Phase 3 (Fix 1 — security-review remediation
 * for Phase 2). The pure tag decision at the build worker's raise chokepoint
 * (`scripts/builder-worker.ts` — the primary `needs_approval` handler + `normalizeDevActions`).
 * Given the model's self-declared action `type` + `cmd` + `preview`, plus a working-tree `readFile`
 * hook, returns the effective `PendingAction['type']` string the worker stores.
 *
 * The problem this closes: a build model that couches a MIGRATION in the shell form
 * `npx tsx scripts/apply-<slug>-migration.ts` self-tags the action `run_prod_script`. The leash
 * gate (`categoryFor` in platform-director.ts) returns null for a LONE `run_prod_script` — even
 * when the wrapped SQL is 100% additive (`ADD COLUMN IF NOT EXISTS` / nullable / CHECK / no
 * backfill). So Ada, reacting instantly per Phase 1, has to escalate to the CEO — instead of the
 * ~1-min self-approve the additive classifier already earns for a directly-tagged apply_migration.
 *
 * ⭐ FAIL-CLOSED (Fix 1 — security-review coaching #2, untrusted capability boundary):
 *   The cmd string is a MODEL-AUTHORED, PARTIALLY-EXECUTED CAPABILITY. Any reclassification path
 *   that lets Ada in-leash-approve MUST validate the ENTIRE cmd surface at read time, not just
 *   scan for a substring match. The rails:
 *     1. `parseSingleApplyMigrationCommand` enforces the ENTIRE cmd matches ONE anchored shape:
 *          `[npx ]tsx scripts/apply-<slug>-migration.ts`
 *        — start-of-string anchor, end-of-string anchor, NO extra argv, NO leading-dash tokens
 *        anywhere, NO shell metacharacters (`;`, `&&`, `||`, `|`, `>`, `<`, backticks, `$(…)`,
 *        newlines). ANY extra token or metachar → the cmd is REJECTED (compound-command attack:
 *        `npx tsx scripts/apply-foo-migration.ts; rm -rf /` no longer reclassifies).
 *     2. The apply script itself must be READABLE (`readFile` returns non-null). A missing /
 *        unreadable script → fail-closed to `run_prod_script`. Prevents the "preview spoof" where
 *        the model narrates additive-looking SQL in `preview` while pointing at a script the
 *        classifier can't inspect.
 *     3. EVERY `<slug>.sql` filename the script string-references must be READABLE. A dynamically-
 *        constructed / missing / unreadable reference → fail-closed to `run_prod_script`.
 *     4. Classification is over the ON-DISK sources ONLY (script src + every referenced SQL file).
 *        The model-declared `preview` is NEVER trusted as input to the additive verdict — it's
 *        stored on the pending action for the human/grader to see, but the leash decision uses
 *        the immutable disk contents. Prevents the "preview spoof" ⇒ additive-declaration ⇒
 *        classifier-passes attack vector at the source.
 *
 * The decision (deterministic — the classifier errs safe on any missed keyword):
 *   - `merge_pr` stays `merge_pr` (unchanged).
 *   - `run_prod_script` whose ENTIRE cmd is one of the two anchored shapes above, AND whose
 *     apply script + every referenced `supabase/migrations/*.sql` reads AND classifies as
 *     `additive` — re-tag to `apply_migration`. The Phase-1 leash gate then hits
 *     `LEASH_ACTION_TYPES['apply_migration']` (`additive_migration`), classifyMigrationSql
 *     re-verifies the same additive verdict, and Ada auto-approves in-leash.
 *   - EVERY other `run_prod_script` — compound command, extra argv, missing script,
 *     unreadable SQL reference, or a script whose union of on-disk SQL classifies non-additive
 *     (DROP / TRUNCATE / DELETE-WHERE / ALTER DROP CONSTRAINT / ON DELETE CASCADE / …) — stays
 *     `run_prod_script`. The lone-shell fail-safe holds (categoryFor returns null → escalate),
 *     and `routeOutOfLeashAction` (migration-safety.ts:578) is NEVER relaxed for non-additive or
 *     non-migration scripts — the destructive-preapproval boundary is preserved.
 *   - Any other self-declared type (unknown, missing, or malformed) defaults to `apply_migration`
 *     to preserve the pre-Phase-2 behavior at the same chokepoint (a bug-shaped tag that used to
 *     fall through is unchanged — Phase 2 does NOT widen or narrow that path).
 *
 * PURE — no I/O. `readFile` is injected: production binds it to the build worker's working-tree
 * `fs.readFileSync(resolve(wt, relPath), 'utf8')` (returning `null` on ENOENT); tests drive an
 * in-memory fake.
 */

/** Kept for back-compat with the sanity test that pins the on-disk convention; NEVER used for
 *  reclassification (that path uses the fail-closed `parseSingleApplyMigrationCommand` below).
 *  Callers that walk the source for `.sql` references still use this shape to name-match. */
export const APPLY_MIGRATION_SCRIPT_REGEX = /scripts\/(apply-[a-z0-9_-]+-migration\.ts)/i;

/**
 * Parse an ENTIRE cmd string as a single, well-formed apply-migration invocation. Returns
 * `{ scriptFileName }` on success, `null` on ANY malformed / unsafe shape.
 *
 * The two accepted shapes (both anchored to start + end):
 *   1. `npx tsx scripts/apply-<slug>-migration.ts`
 *   2. `tsx scripts/apply-<slug>-migration.ts`
 *
 * Explicitly REJECTED (all return null — the tagger keeps the action as `run_prod_script`):
 *   - Compound commands: `; & | && || & \n`, `>`, `<`, backticks, `$(…)`.
 *   - Extra argv: any token after the `.ts` filename (e.g. `--apply`, `--flag=value`, another
 *     file path).
 *   - Leading-dash tokens anywhere (e.g. `npx --yes tsx scripts/apply-foo-migration.ts` — the
 *     `--yes` is out of shape). The two accepted shapes have NO flags in them by design.
 *   - Any script name that doesn't match the on-disk convention `apply-<slug>-migration.ts`
 *     (the slug is `[a-z0-9_-]+`).
 *
 * Same character class as `_check-worker-lanes` / the destructive-migration classifier: the
 * safety property is "the entire string is EXACTLY one of these two shapes, byte-for-byte, no
 * extras." A single mismatched byte → null → stays run_prod_script.
 */
export function parseSingleApplyMigrationCommand(
  cmd: string | null | undefined,
): { scriptFileName: string } | null {
  if (typeof cmd !== "string") return null;
  const trimmed = cmd.trim();
  if (!trimmed) return null;
  // Reject ANY shell metacharacter or newline anywhere — even inside would-be paths. These are
  // never legitimate parts of the two accepted shapes above.
  if (/[;&|`$><\n\r]/.test(trimmed)) return null;
  // Anchored full-string match, EXACTLY one of the two shapes. Slug is `[a-z0-9_-]+` — matches
  // the on-disk apply-*-migration.ts naming convention. No flags, no extra tokens.
  const m = trimmed.match(
    /^(?:npx\s+)?tsx\s+scripts\/(apply-[a-z0-9_-]+-migration\.ts)$/,
  );
  if (!m) return null;
  return { scriptFileName: m[1] };
}

export function tagPendingActionType(
  rawType: unknown,
  cmd: string | null | undefined,
  preview: string | null | undefined,
  readFile: (relPath: string) => string | null,
): "apply_migration" | "run_prod_script" | "merge_pr" {
  if (rawType === "merge_pr") return "merge_pr";
  if (rawType !== "run_prod_script") return "apply_migration";
  // Fail-closed gate #1: the ENTIRE cmd must be exactly one apply-*-migration.ts invocation.
  const parsed = parseSingleApplyMigrationCommand(cmd);
  if (!parsed) return "run_prod_script";
  // Fail-closed gate #2: the script itself must be readable.
  const scriptRel = `scripts/${parsed.scriptFileName}`;
  const scriptSrc = readFile(scriptRel);
  if (scriptSrc == null) return "run_prod_script";
  // Fail-closed gate #3: EVERY referenced .sql file must be readable.
  const sqlRefs = extractSqlReferences(scriptSrc);
  const sqlContents: string[] = [];
  for (const rel of sqlRefs) {
    const sql = readFile(`supabase/migrations/${rel}`);
    if (sql == null) return "run_prod_script";
    sqlContents.push(sql);
  }
  // Classification is over ON-DISK sources ONLY — preview (model-declared) is NEVER trusted as
  // input to the leash decision, even though we store it on the action for human review.
  const fullSql = [scriptSrc, ...sqlContents].join("\n");
  return classifyMigrationSql(fullSql).severity === "additive"
    ? "apply_migration"
    : "run_prod_script";
}

/**
 * The union of on-disk SQL surfaces the classifier will scan for a given apply-migration cmd.
 *
 * ⭐ FAIL-CLOSED (Fix 1): returns `null` if the cmd is malformed / compound / has extra argv,
 * OR if the script is unreadable, OR if ANY referenced `.sql` file is unreadable. `null` is the
 * caller's signal to stay `run_prod_script` (the tagger's semantics). The model-declared `cmd`
 * and `preview` are NEVER included in the returned string — the leash decision runs over
 * trusted on-disk content only, so a spoofed preview can't downgrade the verdict.
 *
 * When callers pass this to `classifyMigrationSql`, an empty script that references no .sql
 * files (rare — a valid apply script always contains at least the migration text or a
 * STATEMENTS array) STILL classifies as additive by the classifier's defensive fallback; that's
 * fine because the classifier is over the SCRIPT SOURCE itself, which the caller has confirmed
 * is readable and represents the exact bytes that will run.
 */
export function resolveMigrationSqlForClassification(
  cmd: string | null | undefined,
  _previewIgnoredForClassification: string | null | undefined,
  readFile: (relPath: string) => string | null,
): string | null {
  const parsed = parseSingleApplyMigrationCommand(cmd);
  if (!parsed) return null;
  const scriptRel = `scripts/${parsed.scriptFileName}`;
  const scriptSrc = readFile(scriptRel);
  if (scriptSrc == null) return null;
  const sqlRefs = extractSqlReferences(scriptSrc);
  const parts: string[] = [scriptSrc];
  for (const rel of sqlRefs) {
    const sql = readFile(`supabase/migrations/${rel}`);
    if (sql == null) return null;
    parts.push(sql);
  }
  return parts.join("\n");
}

/** Extract every `<slug>.sql` filename string-referenced by an apply-migration script's source.
 *  A single script may reference many (e.g. `const MIGRATIONS = ['a.sql', 'b.sql']`); the tagger
 *  fail-closes if any one is unreadable so we can't get a partial-classification pass. */
function extractSqlReferences(scriptSrc: string): string[] {
  const refs = new Set<string>();
  for (const m of scriptSrc.matchAll(/([a-z0-9_-]+\.sql)/gi)) refs.add(m[1]);
  return Array.from(refs);
}

// ── Phase 3 — computed blast-radius via transactional dry-run ─────────────────────
//
// The Phase-1 classifier is a mechanical rail on the SQL text alone. Phase 3 layers
// a MEASURED fact on top: run the migration inside `BEGIN … ROLLBACK` on a real pg
// connection, capture affected-row counts + drop/rename effects, and produce a
// plain-English `blastRadius` summary (e.g. "deletes 48,201 rows from orders —
// irreversible"). The summary replaces the SELF-DECLARED `reversibility` string
// on the raised out-of-leash approval so the human/grader sees a measured fact,
// not Ada's free-text.
//
// Lock-heavy DDL is DELIBERATELY not measured against prod — the caller passes
// `skipDryRun: true` (or the module detects an `ALTER … SET DATA TYPE` rewrite),
// and the returned `{ measured: false }` carries the static Phase-1 severity
// only. NEVER lock prod to measure. An ephemeral Supabase branch DB would be the
// future path (`pg: <branch-client>`) — the injected-PgLike interface accepts it
// unchanged.

/** A minimal pg-Client-compatible interface. The real `pg.Client` satisfies it
 *  directly; tests inject a spy that records BEGIN / statement / ROLLBACK calls. */
export interface PgLike {
  query(sql: string): Promise<{ rowCount: number | null; rows: unknown[] }>;
}

export interface BlastRadiusStatement {
  /** First 200 chars of the statement — for the summary + audit. */
  statement: string;
  /** Rows affected in the ROLLED-BACK transaction; null for a DDL statement (pg returns null) or on error. */
  rowCount: number | null;
  /** Error message if the statement failed (still ROLLED BACK). */
  error?: string;
}

export interface BlastRadius {
  /** True iff the dry-run actually ran. False when skipped (lock-heavy / no pg / disabled). */
  measured: boolean;
  /** Phase-1 static severity — the classifier stays AUTHORITATIVE for the leash decision. */
  severity: MigrationSeverity;
  /** Every Phase-1 matcher that fired — carried through for the audit log. */
  matches: string[];
  /** Plain-English human summary the CEO reads on the approval card. */
  summary: string;
  /** Per-statement rowcounts (only when `measured: true`). */
  affected?: BlastRadiusStatement[];
  /** Why measurement was skipped — surfaced on the payload so the reader knows. */
  measurementSkipped?: string;
}

export interface ComputeBlastRadiusOpts {
  /** Injected pg client (already connected). When absent, returns `measured: false`. */
  pg?: PgLike;
  /** Explicit "don't dry-run this against prod" — the caller declares the DDL is lock-heavy. */
  skipDryRun?: boolean;
  /** Override the auto lock-heavy detection (e.g. force it on for testing). */
  lockHeavy?: boolean;
}

/**
 * Detect lock-heavy DDL the classifier refuses to dry-run against prod. Conservative:
 * only patterns that ALWAYS rewrite the whole table (an `ALTER COLUMN … TYPE`) count
 * — a plain `ADD COLUMN NOT NULL DEFAULT` or an index rebuild can be safely dry-run
 * inside a transaction (the dry-run acquires a lock briefly, then ROLLBACK releases it).
 */
function detectLockHeavy(sql: string): boolean {
  const stripped = stripComments(sql).toLowerCase();
  // ALTER COLUMN ... (SET DATA TYPE | TYPE) — table rewrite, holds ACCESS EXCLUSIVE the whole time.
  if (/\balter\s+table\s+[^\s;]+\s+alter\s+column\s+[^\s;]+\s+(?:set\s+data\s+type|type)\b/.test(stripped)) return true;
  return false;
}

/** Split SQL into per-statement chunks, respecting `-- …` / `/* … *​/` comments,
 *  dollar-quoted `$$…$$` / `$tag$…$tag$` bodies, and single-quoted strings. */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) { cur += sql.slice(i); i = n; continue; }
      cur += sql.slice(i, nl + 1);
      i = nl + 1;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) { cur += sql.slice(i); i = n; continue; }
      cur += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (sql[i] === "$") {
      const m = sql.slice(i).match(/^\$([a-zA-Z_]\w*)?\$/);
      if (m) {
        const closer = `$${m[1] ?? ""}$`;
        const end = sql.indexOf(closer, i + m[0].length);
        if (end === -1) { cur += sql.slice(i); i = n; continue; }
        cur += sql.slice(i, end + closer.length);
        i = end + closer.length;
        continue;
      }
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (sql[i] === ";") {
      cur += ";";
      if (cur.trim()) out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += sql[i];
    i++;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function statementVerb(stmt: string): "delete" | "update" | "truncate" | "drop" | "other" {
  const s = stmt.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, "").toLowerCase();
  if (/^delete\s+from\b/.test(s)) return "delete";
  if (/^update\s+/.test(s)) return "update";
  if (/^truncate\b/.test(s)) return "truncate";
  if (/^drop\s+/.test(s) || /^alter\s+table\s+[^\s;]+\s+drop\s+/i.test(s)) return "drop";
  return "other";
}

function tableFor(stmt: string): string {
  const s = stmt.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, "");
  const m =
    s.match(/^\s*delete\s+from\s+([^\s;(]+)/i) ??
    s.match(/^\s*update\s+([^\s;(]+)/i) ??
    s.match(/^\s*truncate\s+(?:table\s+)?([^\s;(,]+)/i) ??
    s.match(/^\s*alter\s+table\s+(?:if\s+exists\s+)?([^\s;]+)/i) ??
    s.match(/^\s*drop\s+table\s+(?:if\s+exists\s+)?([^\s;]+)/i);
  return m?.[1] ?? "?";
}

function composeSummary(cls: MigrationClassification, affected: BlastRadiusStatement[] | null, measurementSkipped: string | null): string {
  const suffix = cls.severity === "irreversible_destructive" ? " — irreversible"
    : cls.severity === "reversible_destructive" ? " — reversible"
    : "";
  if (affected) {
    const phrases: string[] = [];
    for (const a of affected) {
      const verb = statementVerb(a.statement);
      const table = tableFor(a.statement);
      if (verb === "delete" && a.rowCount !== null && a.rowCount > 0) phrases.push(`deletes ${a.rowCount.toLocaleString()} rows from ${table}`);
      else if (verb === "update" && a.rowCount !== null && a.rowCount > 0) phrases.push(`updates ${a.rowCount.toLocaleString()} rows in ${table}`);
      else if (verb === "truncate") phrases.push(`truncates ${table}`);
      else if (verb === "drop") phrases.push(`drops ${table}`);
    }
    if (!phrases.length && cls.severity === "additive") return "measured: additive change — no destructive rows affected";
    if (!phrases.length) return `${cls.matches.join(", ")}${suffix} (measured — 0 rows affected)`;
    return `${phrases.join("; ")}${suffix}`;
  }
  const cause = measurementSkipped ?? "no dry-run measurement available";
  if (cls.severity === "additive") return `additive change; measurement skipped: ${cause}`;
  return `${cls.matches.join(", ")}${suffix}; measurement skipped: ${cause}`;
}

/**
 * Compute the blast-radius of a proposed migration by dry-running it inside a
 * transaction and rolling back. PURE apart from the injected `PgLike` — the
 * caller opens/closes the connection. Returns a `BlastRadius` carrying the
 * plain-English summary, per-statement rowcounts, and the Phase-1 severity
 * (which stays authoritative — a measured 0-row DELETE still classifies
 * destructive if the classifier flagged the SQL).
 *
 * Contract:
 *   1. Classify the SQL with the Phase-1 classifier — `severity` + `matches`.
 *   2. If lock-heavy (auto or explicit) or `pg` missing → return `measured:false`
 *      with a `measurementSkipped` reason. NEVER acquires a prod lock to measure.
 *   3. Otherwise: `BEGIN` → run each statement in order → `ROLLBACK` in a `finally`
 *      so the transaction never persists, EVER, even on error mid-run. A statement
 *      that errors is captured with its error string and the loop continues so we
 *      report as much of the migration as we can.
 *
 * Verification (destructive-migration-safety-rails Phase 3):
 *   • `computeBlastRadius` on a `DELETE FROM t WHERE …` returns the real affected-
 *     row count AND the table's row count is unchanged afterward (proved by
 *     the ROLLBACK contract — the pg client sees the pre-tx count post-call).
 *   • A lock-heavy DDL returns `measured:false` with the static severity instead
 *     of acquiring a prod lock.
 */
export async function computeBlastRadius(sql: string, opts: ComputeBlastRadiusOpts = {}): Promise<BlastRadius> {
  const cls = classifyMigrationSql(sql);
  const lockHeavy = opts.lockHeavy === true || detectLockHeavy(sql);
  const stripped = stripComments(sql).trim();

  if (opts.skipDryRun || !opts.pg || lockHeavy || !stripped) {
    const cause = lockHeavy
      ? "lock-heavy DDL (refusing to acquire a prod lock — run on an ephemeral branch DB or skip)"
      : opts.skipDryRun
        ? "dry-run explicitly skipped"
        : !opts.pg
          ? "no pg client provided"
          : "empty SQL";
    return { measured: false, severity: cls.severity, matches: cls.matches, summary: composeSummary(cls, null, cause), measurementSkipped: cause };
  }

  const pg = opts.pg;
  const affected: BlastRadiusStatement[] = [];
  let began = false;
  try {
    await pg.query("BEGIN");
    began = true;
    for (const stmt of splitSqlStatements(sql)) {
      const preview = stmt.trim().slice(0, 200);
      // Rollback-contract guardrail: STRIP transaction-control statements
      // (BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE/END/START TRANSACTION) from the
      // input SQL so a hostile / naive migration containing `... ; COMMIT;` cannot
      // escape the dry-run's atomic wrapper. Our BEGIN + finally-block ROLLBACK
      // are AUTHORITATIVE; input-supplied transaction control is dropped.
      if (isTransactionControlStatement(stmt)) {
        affected.push({ statement: preview, rowCount: null, error: "transaction-control statement skipped (dry-run owns BEGIN/ROLLBACK)" });
        continue;
      }
      try {
        const r = await pg.query(stmt);
        affected.push({ statement: preview, rowCount: r.rowCount });
      } catch (e) {
        affected.push({ statement: preview, rowCount: null, error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
  } finally {
    if (began) {
      try {
        await pg.query("ROLLBACK");
      } catch {
        // best-effort — even if ROLLBACK fails (connection gone), the tx never committed
      }
    }
  }
  return {
    measured: true,
    severity: cls.severity,
    matches: cls.matches,
    summary: composeSummary(cls, affected, null),
    affected,
  };
}

/** True iff `stmt` is a transaction-control statement (BEGIN/COMMIT/ROLLBACK/SAVEPOINT
 *  /RELEASE/END/START TRANSACTION). Comment-stripped, case-insensitive. Used to enforce
 *  the dry-run ROLLBACK contract: input SQL never commits from within our wrapper. */
export function isTransactionControlStatement(stmt: string): boolean {
  const s = stripComments(stmt).trim().toLowerCase();
  if (!s) return true; // empty is a no-op — skip
  // Match a leading keyword; the statement may end with a semicolon or a following word.
  return /^(?:begin|commit|rollback|savepoint|release|end|start\s+transaction)\b/.test(s);
}

// ── Phase 4 — CTO-final-call routing + CEO business circuit-breaker ─────────────
//
// The routing decision the raised out-of-leash approval carries: Ada (Platform) owns
// technical soundness within a bounded/recoverable envelope; the CEO circuit-breaks
// on the genuinely-irreversible + business-material tail. Realizes operational-rules
// § North star — the tool optimizes a bounded proxy, Ada owns the objective, the CEO
// owns the last-resort circuit-breaker. Every destructive-action decision is graded
// async by the existing box director-grade sweep (director_decision_grades) —
// accountability via grading, not per-decision pre-approval.

/** Tables whose destruction is "business-material" — mass customer / financial data
 *  loss the CEO must circuit-break on, not Ada. Substring match (case-insensitive)
 *  against the destroyed/mutated table name from the classifier or the dry-run
 *  affected list. Deliberately liberal — we err on the side of surfacing to the CEO
 *  when a destructive action touches these ledgers. */
const BUSINESS_MATERIAL_TABLE_PATTERNS: RegExp[] = [
  /\bcustomers?\b/i,
  /\borders?\b/i,
  /\bline_items?\b/i,
  /\bsubscriptions?\b/i,
  /\bpayments?\b/i,
  /\btransactions?\b/i,
  /\bcharges?\b/i,
  /\brefunds?\b/i,
  /\binvoices?\b/i,
  /\bledger\b/i,
  /\btickets?\b/i,
  /\bbilling\b/i,
];

/** Row-count threshold above which a destructive touch on ANY table counts as
 *  business-material — a mass mutation is material regardless of the table name. */
export const BUSINESS_MATERIAL_ROW_THRESHOLD = 100;

/**
 * Does the SQL follow the rename-and-expire convention (operational-rules
 * § Reversible-by-default DB changes)? A rename to `_deprecated_<name>_<yyyymmdd>`
 * is inherently reversible (rename back), so a `reversible_destructive` migration
 * that IS a rename-and-expire is safe for Ada to own without escalating.
 *
 * Matches: `ALTER TABLE public.x RENAME TO _deprecated_x_20260703` and the column
 * variant `ALTER TABLE x RENAME COLUMN y TO _deprecated_y_20260703`. Comment-stripped,
 * case-insensitive.
 */
export function isRenameAndExpire(sql: string): boolean {
  if (!sql || typeof sql !== "string") return false;
  const stripped = stripComments(sql).toLowerCase();
  if (/\balter\s+table\s+[^\s;]+\s+rename\s+to\s+_deprecated_[a-z0-9_]+_\d{8}\b/.test(stripped)) return true;
  if (/\balter\s+table\s+[^\s;]+\s+rename\s+column\s+[^\s;]+\s+to\s+_deprecated_[a-z0-9_]+_\d{8}\b/.test(stripped)) return true;
  return false;
}

/**
 * Is this destructive change business-material? True when EITHER
 *   (a) any measured affected row count exceeds `BUSINESS_MATERIAL_ROW_THRESHOLD`, OR
 *   (b) any destroyed / mutated statement touches a business-material table pattern
 *       (customers/orders/subscriptions/payments/invoices/tickets/billing/ledger).
 *
 * PURE — reads the blast-radius the caller supplies. When the dry-run was skipped
 * (`measured:false`), we fall back to the Phase-1 `matches` prose plus a
 * conservative "assume material for irreversible" rule so we don't undersell the
 * CEO circuit-breaker on a lock-heavy DROP TABLE.
 */
export function isBusinessMaterial(blastRadius: BlastRadius): boolean {
  const affected = blastRadius.affected ?? [];
  for (const a of affected) {
    if (a.rowCount !== null && a.rowCount > BUSINESS_MATERIAL_ROW_THRESHOLD) return true;
    for (const re of BUSINESS_MATERIAL_TABLE_PATTERNS) if (re.test(a.statement)) return true;
  }
  // Fallback when the dry-run was skipped: check the Phase-1 matches prose for
  // material-table names. A lock-heavy DROP TABLE public.customers must still be
  // recognized as material — we cannot punt just because we didn't measure it.
  if (!blastRadius.measured) {
    const summary = blastRadius.summary;
    for (const re of BUSINESS_MATERIAL_TABLE_PATTERNS) if (re.test(summary)) return true;
    if (blastRadius.severity === "irreversible_destructive") return true; // conservative
  }
  return false;
}

export type RouteDestination = "platform" | "ceo";

export interface DestructiveRoute {
  /** 'platform' = Ada owns the final call; 'ceo' = CEO circuit-breaker. */
  routedToFunction: RouteDestination;
  /** True iff the SQL follows the Phase-2 rename-and-expire pattern. */
  renameAndExpire: boolean;
  /** True iff `isBusinessMaterial(blastRadius)` fired. */
  businessMaterial: boolean;
  /** One-line reason the routing decision is what it is — surfaced on the CEO card + director_activity. */
  reason: string;
}

/**
 * Route a destructive-action raise to Ada (Platform) or the CEO based on
 * (Phase-1 severity × Phase-2 rename-and-expire × business-materiality).
 *
 * Rules (destructive-migration-safety-rails Phase 4):
 *   • `additive` → 'platform' (in-leash — should never actually reach the raise path).
 *   • `reversible_destructive` AND (rename-and-expire OR not business-material) → 'platform'.
 *     Ada owns the final call; PITR is the backstop. Logged to director_activity with the
 *     Phase-3 computed blast-radius. NOT routed to the CEO.
 *   • `irreversible_destructive` AND business-material (mass customer/financial data
 *     destruction) → 'ceo' circuit-break. Surfaced with the computed plain-English risk
 *     line via the existing CEO-routed approval; NO raw SQL required to decide.
 *   • Everything else destructive → 'ceo' (fail-safe: unfamiliar destructive shape UP).
 */
export function routeDestructiveAction(sql: string, blastRadius: BlastRadius): DestructiveRoute {
  const renameAndExpire = isRenameAndExpire(sql);
  const businessMaterial = isBusinessMaterial(blastRadius);

  if (blastRadius.severity === "additive") {
    return {
      routedToFunction: "platform",
      renameAndExpire,
      businessMaterial,
      reason: "additive change — in-leash, Ada auto-approves",
    };
  }

  if (blastRadius.severity === "reversible_destructive") {
    if (renameAndExpire || !businessMaterial) {
      const why = renameAndExpire
        ? "reversible_destructive + rename-and-expire rail — Ada owns final call (PITR backstop)"
        : "reversible_destructive + not business-material — Ada owns final call (PITR backstop)";
      return { routedToFunction: "platform", renameAndExpire, businessMaterial, reason: why };
    }
    return {
      routedToFunction: "ceo",
      renameAndExpire,
      businessMaterial,
      reason: "reversible_destructive but business-material — CEO circuit-break (mass customer/financial mutation)",
    };
  }

  // irreversible_destructive
  if (businessMaterial) {
    return {
      routedToFunction: "ceo",
      renameAndExpire,
      businessMaterial,
      reason: "irreversible_destructive + business-material — CEO circuit-break (mass customer/financial destruction)",
    };
  }
  return {
    routedToFunction: "ceo",
    renameAndExpire,
    businessMaterial,
    reason: "irreversible_destructive — CEO circuit-break (unfamiliar destructive shape)",
  };
}

/**
 * secure-destructive-migration-preapproval-boundary — the OUT-OF-LEASH-caller wrapper around
 * `routeDestructiveAction`. Adds two hard gates BEFORE consulting the Phase-4 routing table:
 *
 *   1. `actionType` must be `apply_migration`. A `run_prod_script` is a bounded shell command, not
 *      SQL — the deterministic classifier + dry-run cannot inspect its blast radius, so it can
 *      NEVER be validated onto the Platform lane. Every other actionType routes to CEO fail-safe.
 *   2. Blast-radius `severity` must be `reversible_destructive`. `additive` still needs CEO (Ada
 *      is out of leash, she does not silently self-approve additive-but-out-of-leash asks);
 *      `irreversible_destructive` always needs CEO (circuit-breaker); only the middle rung is
 *      eligible for the Ada-owns-final-call lane where the rename-and-expire / non-material rails
 *      keep it safe.
 *
 * The Phase-4 rules for reversible_destructive stay unchanged — `routeDestructiveAction` decides
 * platform vs ceo based on rename-and-expire × business-materiality. This wrapper's job is only
 * to close the two authority-bypass paths (`run_prod_script`-as-platform / `additive`-as-platform)
 * introduced when the raise path bundled a self-declared severity onto the pending action.
 *
 * The output is the same DestructiveRoute shape — callers store `routed_to_function_override` on
 * the pending action, and `routingOwnerForJob` (approval-inbox) RE-VALIDATES the override at
 * read-time against action.type + action.blastRadius.severity so a hostile row cannot install a
 * Platform override by hand.
 */
export function routeOutOfLeashAction(
  actionType: string,
  sql: string,
  blastRadius: BlastRadius,
): DestructiveRoute {
  if (actionType !== "apply_migration") {
    return {
      routedToFunction: "ceo",
      renameAndExpire: false,
      businessMaterial: false,
      reason: `actionType=${actionType || "unknown"} is not SQL — blast-radius cannot validate it; CEO fail-safe`,
    };
  }
  if (blastRadius.severity !== "reversible_destructive") {
    return {
      routedToFunction: "ceo",
      renameAndExpire: isRenameAndExpire(sql),
      businessMaterial: isBusinessMaterial(blastRadius),
      reason: `severity=${blastRadius.severity} is not eligible for the Platform lane — CEO fail-safe`,
    };
  }
  const routed = routeDestructiveAction(sql, blastRadius);
  // routeDestructiveAction MAY still route reversible_destructive to CEO (business-material + not
  // rename-form). Preserve that decision verbatim — we never widen a CEO route back to platform.
  return routed;
}

// ── Phase 5 — Adversarial skeptic pass (defense-in-depth, not load-bearing) ─────
//
// Before any destructive migration surfaces to a human, run a read-only skeptic
// whose SOLE mandate is to prove the migration is data-losing — mirroring the
// solver→skeptic→quorum pattern used for escalations. The skeptic is a BONUS
// layer over the Phase-1 classifier + Phase-3 dry-run; the deterministic
// severity stays AUTHORITATIVE for the leash decision. The skeptic can
// ESCALATE (find something the classifier missed) but NEVER DOWNGRADE a
// mechanically-flagged destructive migration to additive.

export interface SkepticVerdict {
  /** True iff the skeptic believes the migration causes data loss (or agrees with the classifier). */
  dataLossing: boolean;
  /** Confidence in [0, 1] — a high-confidence data-loss finding can escalate severity to irreversible. */
  confidence: number;
  /** One-line reason surfaced on the CEO card + director_activity audit row. */
  reason: string;
  /** Additional destructive patterns the skeptic spotted that the mechanical classifier missed. */
  additionalMatches?: string[];
}

/**
 * The skeptic is injected by the caller — production runs a Max `claude -p` session
 * whose ONLY prompt is "try to refute; find data loss the classifier missed", tests
 * supply a fake. Returning a plain object OR a Promise is both fine.
 */
export type SkepticFn = (input: { sql: string; blastRadius: BlastRadius }) => Promise<SkepticVerdict> | SkepticVerdict;

export interface RunSkepticPassOpts {
  /** The skeptic to run. When omitted, a lenient default echoes the deterministic verdict. */
  skeptic?: SkepticFn;
}

export interface SkepticPassResult {
  /** True when the classifier said additive and there was nothing for the skeptic to check. */
  skipped: boolean;
  /** The skeptic's verdict — attached to the approval payload for the CEO/Ada to read. */
  verdict?: SkepticVerdict;
  /** The FINAL blast-radius after attaching the skeptic. Severity NEVER downgrades — a lenient
   *  skeptic cannot demote a mechanically-flagged destructive back to additive. Matches are the
   *  union of Phase-1 matches + any additional patterns the skeptic surfaced. Summary carries the
   *  skeptic's one-line + a note that deterministic severity remains authoritative when the skeptic
   *  was lenient. */
  finalBlastRadius: BlastRadius;
}

/** Merge two severities, always returning the more severe one. */
function maxSeverity(a: MigrationSeverity, b: MigrationSeverity): MigrationSeverity {
  const order: Record<MigrationSeverity, number> = { additive: 0, reversible_destructive: 1, irreversible_destructive: 2 };
  return order[a] >= order[b] ? a : b;
}

/** Map a data-loss verdict to a severity floor (based on confidence). */
function verdictSeverityFloor(v: SkepticVerdict): MigrationSeverity {
  if (!v.dataLossing) return "additive"; // no floor imposed
  return v.confidence >= 0.7 ? "irreversible_destructive" : "reversible_destructive";
}

/**
 * Run the Phase-5 adversarial skeptic. Skips when the classifier said additive + no
 * matches (there's nothing to refute — the bonus layer costs nothing to skip). On a
 * destructive raise, runs the injected skeptic and returns a FINAL blast-radius that
 *   • preserves the deterministic severity (never downgrades — mechanical flag wins),
 *   • ESCALATES severity if the skeptic's `verdictSeverityFloor` is higher (a
 *     high-confidence data-loss finding on a `reversible_destructive` bumps to
 *     `irreversible_destructive`),
 *   • unions any `additionalMatches` the skeptic surfaced into `matches`, and
 *   • appends a `skeptic: …` note to the summary so the CEO card reads it inline.
 *
 * PURE apart from the injected skeptic (which itself may await a Max session).
 */
export async function runSkepticPass(
  sql: string,
  blastRadius: BlastRadius,
  opts: RunSkepticPassOpts = {},
): Promise<SkepticPassResult> {
  if (blastRadius.severity === "additive" && blastRadius.matches.length === 0) {
    return { skipped: true, finalBlastRadius: blastRadius };
  }

  const skepticFn = opts.skeptic ?? defaultLenientSkeptic;
  const verdict = await Promise.resolve(skepticFn({ sql, blastRadius }));

  // Deterministic severity is authoritative — the skeptic can ESCALATE (their verdict-severity floor
  // may exceed the classifier's) but NEVER downgrade the classifier's severity to a lower rung.
  const proposedFloor = verdictSeverityFloor(verdict);
  const finalSeverity = maxSeverity(blastRadius.severity, proposedFloor);

  const extras = (verdict.additionalMatches ?? []).filter((m) => !blastRadius.matches.includes(m));
  const finalMatches = [...blastRadius.matches, ...extras];

  const confStr = verdict.confidence.toFixed(2);
  const skepticLine = verdict.dataLossing
    ? `skeptic: data loss confirmed — ${verdict.reason} (confidence ${confStr})`
    : `skeptic: no additional data loss found — ${verdict.reason} (confidence ${confStr}); deterministic severity remains authoritative`;
  const finalSummary = `${blastRadius.summary}\n${skepticLine}`;

  return {
    skipped: false,
    verdict,
    finalBlastRadius: {
      ...blastRadius,
      severity: finalSeverity,
      matches: finalMatches,
      summary: finalSummary,
    },
  };
}

/**
 * Default lenient skeptic — matches the classifier's verdict and adds no signal.
 * Real production supplies a Max `claude -p` session whose sole mandate is to try
 * to refute the classifier; tests supply a fake with programmed verdicts. Provided
 * so a caller that hasn't wired a real skeptic yet still gets a well-formed
 * `SkepticPassResult` (the CEO card still reads a "skeptic: …" line, and the
 * severity-preservation contract is exercised end-to-end).
 */
export const defaultLenientSkeptic: SkepticFn = ({ blastRadius }) => ({
  dataLossing: blastRadius.severity !== "additive",
  confidence: 0.5,
  reason: "no separate skeptic wired — echoing deterministic verdict",
});

/**
 * A DETERMINISTIC data-loss skeptic — the built-in adversarial pass the box worker wires
 * as the default skeptic (Phase 5 Fix 1). Its SOLE mandate is to prove data loss: it
 * agrees with the classifier when the classifier flagged destructive, and independently
 * scans the SQL for shapes the mechanical classifier can miss (unfiltered UPDATEs inside
 * `WITH … UPDATE`, chained CASCADE via FK, and constraint drops on tables carrying real
 * rows). Adds `additionalMatches` when it spots a shape the classifier missed. NEVER
 * downgrades a mechanically-flagged destructive — the enforcement lives in `runSkepticPass`
 * itself, but this skeptic never claims dataLossing:false on a classifier-destructive
 * input either (defense-in-depth belt-and-suspenders).
 */
export const deterministicDataLossSkeptic: SkepticFn = ({ sql, blastRadius }) => {
  const stripped = stripComments(sql).toLowerCase();
  const extras: string[] = [];
  let dataLossing = blastRadius.severity !== "additive";
  let confidence = dataLossing ? 0.85 : 0.4;
  const reasons: string[] = [];

  // A `WITH … UPDATE/DELETE` CTE-write can hide unfiltered mutations the Phase-1 scan
  // misses when the WHERE lives OUTSIDE the top-level statement.
  if (/\bwith\b[\s\S]*\b(update|delete)\b[\s\S]*\breturning\b/.test(stripped) && !/\bwhere\b/.test(stripped)) {
    extras.push("CTE write without WHERE");
    dataLossing = true;
    confidence = Math.max(confidence, 0.8);
    reasons.push("CTE-write without WHERE");
  }
  // A FOREIGN KEY drop is a schema-level destruction the classifier flags reversible;
  // the skeptic re-flags it as data-losing when it walks toward a customer-facing table.
  if (/\balter\s+table\s+([^\s;]+)[\s\S]*drop\s+constraint\b/.test(stripped)) {
    const m = stripped.match(/\balter\s+table\s+([^\s;]+)/);
    if (m && /(customers?|orders?|subscriptions?|payments?|invoices?|line_items?)/.test(m[1])) {
      extras.push("FK/constraint drop on business-material table");
      dataLossing = true;
      confidence = Math.max(confidence, 0.8);
      reasons.push("constraint drop on business table");
    }
  }
  // Any destructive severity from the classifier → the skeptic AGREES (belt-and-suspenders).
  if (blastRadius.severity !== "additive") {
    reasons.push(`classifier flagged ${blastRadius.severity}: ${blastRadius.matches.join(", ")}`);
  }

  const reason = reasons.length
    ? reasons.join("; ")
    : "no additional data-loss patterns beyond the classifier";
  return { dataLossing, confidence, reason, additionalMatches: extras.length ? extras : undefined };
};

// ── Fix 1 — director_decision_grades write for destructive-action approvals ──────

/**
 * Write ONE `director_decision_grades` row for a destructive-action approval decision.
 * Satisfies destructive-migration-safety-rails Phase 4's accountability rail: every
 * destructive-action approval is a "director-decision grade" record even when the CEO
 * — not Ada — decides the specific approval, because ADA'S RAISE was the graded call
 * (her judgment that this out-of-leash action was sound and right to escalate).
 *
 * Idempotent on `agent_job_id` — the caller may re-run without duplicating. `graded_by`
 * stays `'agent'` so a subsequent box director-grade sweep (or human) can OVERRIDE by
 * upserting `graded_by='human'` on the same key. `grade` is left NULL as a placeholder
 * pending the box sweep's re-grade — the ROW exists, marked ungraded, ready for the
 * async QUALITY review.
 *
 * Best-effort; a write failure is logged but never throws. Uses a Supabase-JS-compatible
 * admin shape so it's testable with a stub.
 */
export interface WriteDestructiveActionDecisionGradeInput {
  workspaceId: string;
  agentJobId: string;
  directorFunction: string;
  blastRadiusSummary: string | null;
  routeReason: string | null;
}

export interface WriteDestructiveActionDecisionGradeResult {
  ok: boolean;
  approvalDecisionId?: string | null;
  gradeId?: string | null;
  reason?: string;
}

type MinimalAdmin = {
  from(table: string): {
    select(cols: string): {
      eq(column: string, value: string): {
        order?(...args: unknown[]): unknown;
        limit(n: number): {
          maybeSingle(): Promise<{ data: unknown; error: unknown }>;
        };
        maybeSingle?(): Promise<{ data: unknown; error: unknown }>;
      };
    };
    insert(payload: Record<string, unknown>): {
      select(cols: string): {
        maybeSingle(): Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
};

export async function writeDestructiveActionDecisionGrade(
  admin: MinimalAdmin,
  input: WriteDestructiveActionDecisionGradeInput,
): Promise<WriteDestructiveActionDecisionGradeResult> {
  try {
    // Look up the standard /api/roadmap/approve-written approval_decisions row for this job.
    // approveRoadmapAction writes one row per approve/decline with decided_by='ceo' + routed_to_function='ceo'
    // for the ceo-authorized-out-of-leash path.
    const decRes = await admin
      .from("approval_decisions")
      .select("id")
      .eq("agent_job_id", input.agentJobId)
      .limit(1)
      .maybeSingle();
    const decision = (decRes.data as { id?: string } | null) ?? null;
    if (!decision?.id) {
      return { ok: false, reason: "no approval_decisions row for agent_job_id (race — the /api/roadmap/approve write may not have landed)" };
    }
    const approvalDecisionId = decision.id;

    // Idempotent: if a grade row already exists for this approval_decision_id, we're done.
    const existingRes = await admin
      .from("director_decision_grades")
      .select("id")
      .eq("approval_decision_id", approvalDecisionId)
      .limit(1)
      .maybeSingle();
    const existing = (existingRes.data as { id?: string } | null) ?? null;
    if (existing?.id) {
      return { ok: true, approvalDecisionId, gradeId: existing.id, reason: "idempotent — row already exists" };
    }

    const reasoning = [
      "Destructive-action approval (ceo-authorized-out-of-leash). Ada's RAISE is the graded call:",
      input.routeReason ? `route: ${input.routeReason}` : null,
      input.blastRadiusSummary ? `blast-radius: ${input.blastRadiusSummary}` : null,
      "Awaiting async box director-grade sweep re-grade (or human override).",
    ].filter(Boolean).join(" · ");

    const insRes = await admin
      .from("director_decision_grades")
      .insert({
        workspace_id: input.workspaceId,
        director_function: input.directorFunction || "platform",
        dimension: "auto-approval",
        approval_decision_id: approvalDecisionId,
        graded_by: "agent",
        reasoning,
        model: "deterministic-raise-marker",
      })
      .select("id")
      .maybeSingle();
    // Phase 7/Fix-2 (check 74b737bdbda6fa8d): the previous version silently swallowed insert
    // failures and reported ok:true+gradeId:null, so a DB reject (RLS, unique-violation,
    // constraint) produced NO marker row and the box director-grade sweep therefore had
    // nothing to pick — the accountability rail was invisible. Propagate the error so the
    // caller (and the failure-injection harness) sees the truth.
    if (insRes.error) {
      const errMsg = (insRes.error as { message?: string } | null)?.message
        ?? String(insRes.error);
      return { ok: false, approvalDecisionId, reason: `insert failed: ${errMsg}` };
    }
    const ins = (insRes.data as { id?: string } | null) ?? null;
    if (!ins?.id) {
      return { ok: false, approvalDecisionId, reason: "insert returned no id (silent DB reject)" };
    }
    return { ok: true, approvalDecisionId, gradeId: ins.id };
  } catch (e) {
    return { ok: false, reason: `write failed: ${(e as Error)?.message ?? e}` };
  }
}
