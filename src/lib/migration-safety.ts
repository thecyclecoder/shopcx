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
 *   - NEWLY-introduced `ON DELETE CASCADE` → reversible_destructive
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
  if (/\bon\s+delete\s+cascade\b/.test(lower)) push("ON DELETE CASCADE", "rev");

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
