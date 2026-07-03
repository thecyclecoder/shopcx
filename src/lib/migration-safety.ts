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
