# libraries/migration-safety

The **deterministic destructive-SQL classifier** — the leash rail that binds Ada on destructive migrations (**[[../specs/destructive-migration-safety-rails]]** Phase 1). PURE, no I/O. Called from **[[platform-director]]** `categoryFor` before the type-based `additive_migration`/`additive_backfill` classification returns: if the action's SQL is destructive, `categoryFor` returns `null` and the whole request falls **out of the leash** (escalates to the CEO), even though the action TYPE is `apply_migration`.

**File:** `src/lib/migration-safety.ts`

## Why this exists

The gap this closes ([[../specs/destructive-migration-safety-rails]]): every `apply_migration` / `run_prod_script` used to be leash-classified `additive_migration` / `additive_backfill` **by TYPE alone** ([[platform-director]] `categoryFor`, `LEASH_ACTION_TYPES`). Nothing inspected the SQL — the only thing between a `DROP TABLE` / unfiltered `DELETE` and auto-apply was Ada's LLM read. That is Goodhart-shaped: an autonomous supervisor optimizing a proxy (action TYPE) that a real destructive migration silently satisfies.

Phase 1's answer is a **deterministic, mechanical rail** that runs BEFORE Ada's soundness gate: string-match the SQL for destructive statements and force the whole request out of the leash if any match. Ada (the CTO seat — [[../functions/platform]]) stays the **final call** on the recoverable envelope (Phase 4 routing); the classifier only removes her ability to *auto*-approve destructive SQL. See [[../operational-rules]] § *North star (supervisable autonomy)*: the tool optimizes a bounded proxy, the role agent owns the objective.

## What it detects

`classifyMigrationSql(sql)` returns `{ severity, matches }` (PURE — no I/O).

| Pattern | Severity |
|---|---|
| `DROP TABLE` | `irreversible_destructive` |
| `DROP COLUMN` | `irreversible_destructive` |
| `TRUNCATE` | `irreversible_destructive` |
| `DELETE FROM x` **without** `WHERE` | `irreversible_destructive` |
| `UPDATE x SET …` **without** `WHERE` | `irreversible_destructive` |
| `ALTER … DROP CONSTRAINT` | `reversible_destructive` |
| `ALTER … DROP DEFAULT` | `reversible_destructive` |
| a NEWLY-introduced `ON DELETE CASCADE` | `reversible_destructive` |

- **Comment-stripped, case-insensitive.** Both `-- …` line comments and `/* … */` (nested-safe) block comments are removed before matching, so a keyword hidden behind a comment does not fool the scan and one inside a comment does not false-flag.
- **Destruction hidden inside `DO $$ … $$` blocks and `CREATE OR REPLACE FUNCTION` bodies is caught.** Dollar-quoted string boundaries are deliberately NOT stripped — a `DROP TABLE` inside a plpgsql body scans identically to a top-level `DROP TABLE`.
- **`INSERT … ON CONFLICT DO UPDATE SET`** is exempted from the UPDATE-no-WHERE check — the `ON CONFLICT` clause is inherently row-scoped and this is the canonical additive upsert shape (Postgres `ON CONFLICT` implies a predicate over the conflicting rows).
- **Errs SAFE.** Empty / non-string input → `additive` (defensive: no cmd is not destructive). False positives from destructive keywords inside string literals are accepted — over-flagging escalates, which is the correct default vs. under-flagging.
- **Deterministic and authoritative.** The Phase-5 skeptic pass (later phase) can *escalate* the deterministic severity but can NEVER *downgrade* a mechanically-flagged destructive migration back to additive.

## Exports

### `classifyMigrationSql` — function

```ts
function classifyMigrationSql(sql: string): {
  severity: "additive" | "reversible_destructive" | "irreversible_destructive";
  matches: string[];
};
```

### `MigrationSeverity` — type

### `MigrationClassification` — interface

## Callers

- `src/lib/agents/platform-director.ts` — `categoryFor` runs the classifier over the pending action's `cmd`+`preview` before returning `additive_migration` / `additive_backfill`; a non-additive severity forces `null` (out of leash, whole bundle escalates).
- `src/lib/migration-safety.test.ts` — pins the Phase-1 verification cases (`npm run test:migration-safety`).

## Gotchas

- **The classifier reads whatever SQL text is in `cmd`+`preview`.** For an `apply_migration`, the migration SQL is typically visible in `preview`; for a `run_prod_script`, the shell command alone may not surface destructive keywords. A script that hides destruction behind a file the classifier can't see is a Phase-3 concern (computed blast-radius via transactional dry-run) — the Phase-1 classifier IS the string-match rail on the SQL that's actually presented. Prefer to always surface the SQL body in `preview`.
- **A bundle is all-or-nothing** ([[platform-director]] `directorLeashCandidates`): one destructive action inside a bundled `apply_migration + run_prod_script` escalates the WHOLE request — the backfill script cannot ride in on a destructive migration.
- **Reversibility severity is advisory in Phase 1.** Both `reversible_destructive` and `irreversible_destructive` fall out of the leash today. The two-tier severity is what Phase 4 later reads to route `reversible_destructive` to Ada + `irreversible_destructive` + business-material to the CEO circuit-breaker.

## Verification cases (pinned by tests)

The `src/lib/migration-safety.test.ts` suite pins every Phase-1 verification bullet:
- `classifyMigrationSql` flags `DROP TABLE x`, `TRUNCATE x`, `DELETE FROM x` (no `WHERE`), and a statement adding `ON DELETE CASCADE`.
- returns `additive` for `ALTER TABLE x ADD COLUMN y int`, `CREATE TABLE …`, `CREATE INDEX …`.
- unfiltered `DELETE FROM x` classifies destructive, `DELETE FROM x WHERE id = $1` does not.
- `categoryFor` on an `apply_migration` whose cmd/preview contains `DROP TABLE` returns `null` (verdict `none`); an ADD-COLUMN-only cmd returns `additive_migration`.

---

[[../README]] · [[../../CLAUDE]]
