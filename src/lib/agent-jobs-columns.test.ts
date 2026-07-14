/**
 * Drift guard for [[./agent-jobs-columns]] AGENT_JOB_COLUMNS — the typed source-of-truth for
 * `public.agent_jobs`' selectable columns. If a migration adds a new column without updating the
 * constant (or vice versa), this test fails BEFORE a hand-rolled `.select("<new-col>")` can start
 * silently returning empty via 42703. Runs pre-merge in the standard `tsx --test` gate — no DB
 * credentials required (build boxes don't have them).
 *
 *   npm run test:agent-jobs-columns
 *   (= tsx --test src/lib/agent-jobs-columns.test.ts)
 *
 * Approach: parse every `supabase/migrations/*.sql` file that touches `public.agent_jobs`, extract
 * the column names it CREATES (from the initial `create table` paren-block) or ADDS (from
 * `alter table … add column [if not exists] <name>`), and compare the union against
 * AGENT_JOB_COLUMNS. Migrations are the code-side source-of-truth for the live schema (they are
 * what gets applied to prod), so a migration-based check catches the same class as an
 * information_schema check without needing prod credentials in the build session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { AGENT_JOB_COLUMNS } from "./agent-jobs-columns";

const MIGRATIONS_DIR = resolve(__dirname, "../../supabase/migrations");

/** Extract the columns a migration declares on `public.agent_jobs`. Handles both:
 *   create table if not exists public.agent_jobs (col1 type…, col2 type…, primary key…, references…, …)
 *   alter table public.agent_jobs add column [if not exists] <name> <type> [, add column …];
 *  Skips constraint/index/policy noise. Returns lowercase column names.
 */
function extractAgentJobsColumns(sql: string): string[] {
  const out = new Set<string>();
  // Strip SQL comments first — a `-- foo, bar` line inside a create-table body would otherwise
  // pollute the comma split (its own text contains commas), and a `/* … */` block spanning columns
  // would hide real definitions from the regex.
  const stripped = sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i < 0 ? line : line.slice(0, i);
    })
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const lower = stripped.toLowerCase();

  // (1) CREATE TABLE … public.agent_jobs ( … );
  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.agent_jobs\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(lower)) !== null) {
    const openIdx = m.index + m[0].length - 1; // position of `(`
    let depth = 0;
    let end = -1;
    for (let i = openIdx; i < lower.length; i++) {
      const ch = lower[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    const body = lower.slice(openIdx + 1, end);
    // Split on commas that are AT depth 0 within the body (a column definition can itself carry
    // parens, e.g. `default '[]'::jsonb`, `references x(id)`), so a naive split(',') is unsafe.
    const parts: string[] = [];
    let d = 0;
    let start = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === "(") d++;
      else if (ch === ")") d--;
      else if (ch === "," && d === 0) {
        parts.push(body.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(body.slice(start));
    for (const p of parts) {
      const trimmed = p.trim();
      if (!trimmed) continue;
      // Skip table constraints: primary key, unique, foreign key, check, references-at-line-start, constraint <name>.
      const first = trimmed.split(/\s+/)[0];
      if (["primary", "unique", "foreign", "check", "constraint", "references", "exclude", "like"].includes(first)) continue;
      // A column definition starts with a bareword identifier (optionally quoted).
      const nameMatch = /^([a-z_][a-z0-9_]*)\b/.exec(trimmed);
      if (nameMatch) out.add(nameMatch[1]);
    }
  }

  // (2) ALTER TABLE public.agent_jobs ADD COLUMN [IF NOT EXISTS] <name> …[, ADD COLUMN <name> …];
  //     Match the whole statement up to the terminating `;` so a multi-column ALTER catches every name.
  const alterRe = /alter\s+table\s+(?:only\s+)?public\.agent_jobs\b([\s\S]*?);/g;
  while ((m = alterRe.exec(lower)) !== null) {
    const body = m[1];
    const colRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/g;
    let c: RegExpExecArray | null;
    while ((c = colRe.exec(body)) !== null) {
      out.add(c[1]);
    }
  }

  return [...out];
}

/** Union of every column any `agent_jobs` migration declares — the source-of-truth we compare against. */
function migrationColumnSet(): Set<string> {
  const all = new Set<string>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    if (!/public\.agent_jobs\b/i.test(sql)) continue;
    for (const c of extractAgentJobsColumns(sql)) all.add(c);
  }
  return all;
}

test("AGENT_JOB_COLUMNS ⊆ live migration schema (no unknown/typo'd column in the constant)", () => {
  const live = migrationColumnSet();
  assert.ok(live.size > 0, "expected at least one column parsed from supabase/migrations for public.agent_jobs");
  const unknown = AGENT_JOB_COLUMNS.filter((c) => !live.has(c));
  assert.deepEqual(
    unknown,
    [],
    `AGENT_JOB_COLUMNS names ${unknown.length} column(s) not declared by any supabase/migrations/*_agent_jobs*.sql migration — either the migration is missing or the constant has a typo: ${unknown.join(", ")}`,
  );
});

test("live migration schema ⊆ AGENT_JOB_COLUMNS (no column added by migration but missing from the constant)", () => {
  const live = migrationColumnSet();
  const missing = [...live].filter((c) => !(AGENT_JOB_COLUMNS as readonly string[]).includes(c));
  assert.deepEqual(
    missing,
    [],
    `${missing.length} column(s) declared by supabase/migrations/*_agent_jobs*.sql are missing from AGENT_JOB_COLUMNS in src/lib/agent-jobs-columns.ts — add them so readers composing a select via jobSelect() can name them: ${missing.join(", ")}`,
  );
});

test("AGENT_JOB_COLUMNS explicitly does NOT include the nonexistent merge_sha column (the historical 42703 trap)", () => {
  // agent_jobs has never carried a merge_sha column — the merge SHA lives on spec_phases.merge_sha
  // / spec_status_history. Two builder-worker selects (~:20209 and :20267) requested this column
  // and silently 42703'd every run until this constant made it a compile error. Keep the trap
  // wired: adding merge_sha to the constant would resurrect the silent-empty read.
  assert.equal(
    (AGENT_JOB_COLUMNS as readonly string[]).includes("merge_sha"),
    false,
    "merge_sha is NOT a real agent_jobs column — do not add it to AGENT_JOB_COLUMNS; source the SHA from spec_phases/spec_status_history instead.",
  );
});
