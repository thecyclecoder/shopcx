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

### `computeBlastRadius` — async function ([[../specs/destructive-migration-safety-rails]] Phase 3)

```ts
async function computeBlastRadius(sql: string, opts?: {
  pg?: PgLike;              // injected client; when absent → measured:false
  skipDryRun?: boolean;     // caller declares "don't dry-run this against prod"
  lockHeavy?: boolean;      // force lock-heavy classification (usually auto-detected)
}): Promise<{
  measured: boolean;                                // false when skipped
  severity: MigrationSeverity;                      // Phase-1 static severity (authoritative)
  matches: string[];                                // Phase-1 rails that fired
  summary: string;                                  // plain-English (e.g. "deletes 48,201 rows from orders — irreversible")
  affected?: { statement: string; rowCount: number | null; error?: string }[];
  measurementSkipped?: string;                      // reason when measured:false
}>;
```

Runs the migration inside `BEGIN → each statement → ROLLBACK` on the injected `PgLike` (typically a `pg.Client` connected to the Supabase pooler). The transaction NEVER commits — the `ROLLBACK` sits in a `finally` so even a mid-migration exception unwinds cleanly. Per-statement rowcounts are captured and rolled into a human summary (e.g. `deletes 48,201 rows from orders — irreversible`). The Phase-1 static severity stays authoritative for the leash decision — a measured 0-row DELETE still classifies destructive if the classifier flagged the SQL.

**Never locks prod to measure.** Lock-heavy DDL (`ALTER TABLE … ALTER COLUMN … SET DATA TYPE` — a table rewrite that holds `ACCESS EXCLUSIVE`) is detected up front and returns `{ measured: false }` with a `measurementSkipped: "lock-heavy DDL …"` reason instead. The caller can pass `skipDryRun: true` for an explicit bypass. An ephemeral Supabase branch DB is the future path — the injected-`PgLike` accepts one unchanged.

### `splitSqlStatements` — function

Splits a SQL blob into per-statement chunks. Respects `-- …` / `/* … */` comments, `$$…$$` and `$tag$…$tag$` dollar-quoted bodies (a `;` inside a plpgsql function body is NOT a separator), and single-quoted strings (with `''` doubling). Used by `computeBlastRadius`; exported so callers can walk the same statement stream for their own dry-run wrappers.

### `PgLike` — interface

Minimal pg-Client shape (`query(sql: string): Promise<{ rowCount, rows }>`). The real `pg.Client` satisfies it directly; tests inject a spy that records `BEGIN` / statement / `ROLLBACK` calls.

### `routeDestructiveAction` — function ([[../specs/destructive-migration-safety-rails]] Phase 4)

```ts
function routeDestructiveAction(sql: string, blastRadius: BlastRadius): {
  routedToFunction: "platform" | "ceo";
  renameAndExpire: boolean;
  businessMaterial: boolean;
  reason: string;
};
```

Route a destructive-action raise on (Phase-1 severity × Phase-2 rename-and-expire × business-materiality). PURE.

| Case | Routes to |
|---|---|
| `additive` | Platform (in-leash — Ada auto-approves) |
| `reversible_destructive` AND rename-and-expire | Platform (Ada owns final call, PITR backstop) |
| `reversible_destructive` AND NOT business-material | Platform (Ada owns final call) |
| `reversible_destructive` AND business-material AND NOT rename-form | CEO (mass mutation circuit-break) |
| `irreversible_destructive` AND business-material | CEO (circuit-break — mass customer/financial destruction) |
| everything else destructive | CEO (fail-safe — unfamiliar destructive shape) |

Every destructive-action approval writes a `director_decision_grades` row via the existing box director-grade sweep (Ada's approvals only — CEO circuit-break decisions aren't self-graded). Accountability is grading, not per-decision pre-approval. See [[../operational-rules]] § *North star*.

### `isRenameAndExpire(sql)` — function

Matches the Phase-2 reversible-by-default conventions (see [[../operational-rules]] § Reversible-by-default DB changes):
- `ALTER TABLE public.x RENAME TO _deprecated_x_YYYYMMDD;`
- `ALTER TABLE x RENAME COLUMN y TO _deprecated_y_YYYYMMDD;`

### `isBusinessMaterial(blastRadius)` — function

True when any dry-run-measured affected row count exceeds `BUSINESS_MATERIAL_ROW_THRESHOLD` (100) OR any affected statement touches a business-material table (customers / orders / subscriptions / payments / invoices / tickets / billing / ledger). Falls back conservatively when `measured:false`: an unmeasured irreversible destructive is treated as material by default so a lock-heavy `DROP TABLE public.customers` still surfaces to the CEO circuit-breaker.

### `runSkepticPass` — async function ([[../specs/destructive-migration-safety-rails]] Phase 5)

```ts
async function runSkepticPass(
  sql: string,
  blastRadius: BlastRadius,
  opts?: { skeptic?: SkepticFn },
): Promise<{
  skipped: boolean;               // true when classifier said additive (nothing to refute)
  verdict?: SkepticVerdict;       // { dataLossing, confidence, reason, additionalMatches? }
  finalBlastRadius: BlastRadius;  // severity NEVER downgrades; extras unioned into matches
}>;
```

Adversarial skeptic — a BONUS defense-in-depth layer over the Phase-1 classifier + Phase-3 dry-run. The skeptic's SOLE mandate is to prove data loss, mirroring the solver→skeptic→quorum shape used for escalations. The Phase-1 severity stays AUTHORITATIVE for the leash decision — a lenient skeptic can NEVER downgrade a mechanically-flagged destructive migration to additive.

Rules:
- Classifier said `additive` + no matches → `skipped:true`, blastRadius passes through untouched (the bonus layer costs nothing to skip).
- Skeptic verdict `dataLossing:true` with `confidence ≥ 0.7` → severity floor `irreversible_destructive` (can ESCALATE `reversible_destructive` → `irreversible_destructive`).
- Skeptic verdict `dataLossing:true` with `confidence < 0.7` → severity floor `reversible_destructive` (can ESCALATE `additive` — but that combination never reaches the skeptic because we skip additive up front).
- Skeptic verdict `dataLossing:false` → severity floor `additive` (no escalation), but the CLASSIFIER's severity is preserved (`maxSeverity(classifier, floor)`).
- Any `additionalMatches` the skeptic surfaces are unioned into `blastRadius.matches`.
- A one-line `skeptic: …` note is appended to `blastRadius.summary` so the CEO card reads it inline; lenient verdicts carry `deterministic severity remains authoritative`.

Production wires a Max `claude -p` session as the injected skeptic; tests inject a fake. The `defaultLenientSkeptic` (also exported) echoes the deterministic verdict — provided so callers that haven't wired a real skeptic yet still exercise the severity-preservation contract end-to-end.

### `deterministicDataLossSkeptic` — SkepticFn

The built-in adversarial pass the box worker wires as the default skeptic (Phase 5 Fix 1). Its SOLE mandate is to prove data loss: it agrees with the classifier when the classifier flagged destructive AND independently scans for shapes the mechanical classifier can miss — `WITH … UPDATE/DELETE … RETURNING` CTE writes without WHERE, and `ALTER TABLE … DROP CONSTRAINT` on a business-material table (customers/orders/subscriptions/…). Adds `additionalMatches` when it surfaces a new shape. Never claims `dataLossing:false` on a classifier-destructive input (belt-and-suspenders — even before `runSkepticPass`'s severity-preservation rule fires).

### `writeDestructiveActionDecisionGrade` — async function (Phase 4 accountability rail, Fix 1 · Phase 7 Fix 2 hardening)

Writes ONE `director_decision_grades` row for a destructive-action approval decision — Ada's raise is the graded call even when the CEO decides the specific approval. Idempotent on `agent_job_id`; `graded_by='agent'`, `grade=null`, `model='deterministic-raise-marker'` so the picker can tell a MARKER row from a real grade; a subsequent box director-grade sweep (or human) overrides via the same key. Best-effort; failures logged, never thrown.

Called from `runCeoAuthorizedOutOfLeashJob` (scripts/builder-worker.ts) after every destructive-action approval decision, keyed on `blast_radius.severity !== 'additive'`.

**Phase 7 / Fix 2 (spec-test check `74b737bdbda6fa8d`):** the insert result's `error` is now inspected — a DB reject (RLS / unique violation / constraint) returns `{ok:false, reason: 'insert failed: …'}` instead of silently reporting `{ok:true, gradeId:null}`. Silent-swallow previously left the accountability rail invisible whenever the insert failed. A missing returned `id` is also treated as failure.

### `isTransactionControlStatement(sql)` — function (Fix 1)

Comment-stripped, case-insensitive — true for `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `RELEASE` / `END` / `START TRANSACTION`. Used by `computeBlastRadius` to STRIP transaction-control from the input SQL so a hostile / naive migration containing `... ; COMMIT;` cannot escape the dry-run's atomic wrapper — the dry-run OWNS `BEGIN` / `ROLLBACK`.

### `SkepticVerdict` · `SkepticFn` · `RunSkepticPassOpts` · `SkepticPassResult` — types

### `BlastRadius` · `BlastRadiusStatement` · `DestructiveRoute` · `RouteDestination` · `MigrationSeverity` · `MigrationClassification` — types / interfaces

## Callers

- `src/lib/agents/platform-director.ts` — `categoryFor` runs the classifier over the pending action's `cmd`+`preview` before returning `additive_migration` / `additive_backfill`; a non-additive severity forces `null` (out of leash, whole bundle escalates).
- `scripts/builder-worker.ts` — `applyOutOfLeashRequestActionInline` runs `computeBlastRadius` on the raised out-of-leash `apply_migration` / `run_prod_script` action; the measured summary replaces the self-declared `reversibility` string on the pending action's `preview` + `reversibility` field + `log_tail`, and the structured `blastRadius` object is persisted on the pending action + the job's `instructions` JSON. **Phase 4**: the same call site runs `routeDestructiveAction` and stamps `routed_to_function_override: 'platform' | 'ceo'` on the pending action; the reconciler's `routingOwnerForJob` honors it so a reversible+rename-safe raise lands in Ada's inbox instead of the CEO's, and the raised `director_activity` row records the route + reason. **Phase 5**: `runSkepticPass` runs BEFORE `routeDestructiveAction` (so a skeptic escalation flows into routing); its verdict is attached to the pending action + log_tail + instructions + `director_activity`. The deterministic Phase-1 severity remains authoritative — a lenient skeptic never downgrades a mechanically-flagged destructive.
- `src/lib/agents/approval-inbox.ts` — `routingOwnerForJob` honors the pending action's Phase-4 `routed_to_function_override` (whitelist `'platform' | 'ceo'`) before falling back to `KIND_TO_FUNCTION`, so a reversible_destructive + rename-and-expire raise routes to Platform (Ada owns the final call) and irreversible+business-material stays on the CEO circuit-breaker.
- `src/lib/migration-safety.test.ts` — pins the Phase-1 + Phase-3 + Phase-4 + Phase-5 verification cases (`npm run test:migration-safety`).

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
