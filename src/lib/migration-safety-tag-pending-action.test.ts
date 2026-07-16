/**
 * ada-reacts-to-approvals-immediately-never-sits Phase 2 (+ Fix 1 fail-closed hardening)
 * verification — the pure tag decision (`tagPendingActionType`) the build worker's raise
 * chokepoint runs on every incoming action.
 *
 * The failing state Phase 2 closes: an additive `apply-*-migration.ts` action arrives self-tagged
 * `run_prod_script` (the model couched it as a shell command), the leash gate returns null for a
 * lone `run_prod_script`, and Ada — now reacting instantly per Phase 1 — is forced to escalate to
 * the CEO instead of the ~1-min in-leash self-approve. This spec's Phase 2 fix reclassifies that
 * exact shape to `apply_migration` iff the wrapped SQL is verifiably additive, and preserves the
 * `routeOutOfLeashAction` boundary (destructive / non-migration scripts still escalate).
 *
 * The Fix-1 hardening layer (security-review coaching, "untrusted capability boundary") locks the
 * reclassify path to a SINGLE, ANCHORED cmd shape — no compound commands, no extra argv, no shell
 * metacharacters, missing / unreadable script or SQL fail-closed to run_prod_script, and the
 * model-declared `preview` is NEVER trusted as input to the additive verdict.
 *
 *   npx tsx --test src/lib/migration-safety-tag-pending-action.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  tagPendingActionType,
  resolveMigrationSqlForClassification,
  parseSingleApplyMigrationCommand,
  APPLY_MIGRATION_SCRIPT_REGEX,
  classifyMigrationSql,
} from "./migration-safety";

// ── A hand-rolled read-file fake. Keyed by relative path. Missing keys return null. ──────────────
function makeReadFile(files: Record<string, string>) {
  return (rel: string): string | null => (rel in files ? files[rel] : null);
}

// ── Verification #1 — additive apply-migration script reclassifies to apply_migration ────────────

test("(V1) an additive scripts/apply-*-migration.ts action self-tagged run_prod_script reclassifies to apply_migration (Ada auto-approves)", () => {
  const additiveSql = `
    ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS trial_ended_at timestamptz;
    CREATE TABLE IF NOT EXISTS public.usage_snapshots (id uuid primary key);
  `;
  const scriptSrc = `
    import { pgClient } from "./_bootstrap";
    import { readFileSync } from "fs";
    const MIGRATIONS = ["20260814120000_usage_snapshots.sql"];
    async function main() { for (const f of MIGRATIONS) await c.query(readFileSync('supabase/migrations/' + f, 'utf8')); }
  `;
  const readFile = makeReadFile({
    "scripts/apply-usage-snapshots-migration.ts": scriptSrc,
    "supabase/migrations/20260814120000_usage_snapshots.sql": additiveSql,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-usage-snapshots-migration.ts",
    "add usage_snapshots table + trial_ended_at column",
    readFile,
  );
  assert.equal(type, "apply_migration");
  // Cross-check the classifier verdict on the resolved SQL is 'additive' — the same verdict
  // categoryFor's re-check will apply after our reclassify.
  const sql = resolveMigrationSqlForClassification(
    "npx tsx scripts/apply-usage-snapshots-migration.ts",
    "add usage_snapshots table + trial_ended_at column",
    readFile,
  );
  assert.ok(sql != null, "the resolver must return a non-null string for the happy path");
  assert.equal(classifyMigrationSql(sql).severity, "additive");
});

test("(V1b) an additive apply-migration script with SQL embedded INLINE (no separate .sql file) also reclassifies to apply_migration", () => {
  const scriptSrc = `
    // apply-account-matching-indexes-migration — indexes on customers
    const STATEMENTS = [
      \`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_phone
         ON public.customers (workspace_id, phone) WHERE phone IS NOT NULL\`,
    ];
  `;
  const readFile = makeReadFile({
    "scripts/apply-account-matching-indexes-migration.ts": scriptSrc,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-account-matching-indexes-migration.ts",
    "add per-branch customer indexes",
    readFile,
  );
  assert.equal(type, "apply_migration");
});

// ── Verification #2 — destructive / backfill / non-migration STAYS out-of-leash ──────────────────

test("(V2 DROP) an apply-*-migration.ts wrapping DROP TABLE stays run_prod_script (out of leash → escalates; routeOutOfLeashAction boundary preserved)", () => {
  const dropSql = `DROP TABLE public.legacy_shopify_ids;`;
  const scriptSrc = `
    const MIGRATIONS = ["20260901000000_drop_legacy_ids.sql"];
  `;
  const readFile = makeReadFile({
    "scripts/apply-drop-legacy-ids-migration.ts": scriptSrc,
    "supabase/migrations/20260901000000_drop_legacy_ids.sql": dropSql,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-drop-legacy-ids-migration.ts",
    "drop the legacy shopify id column",
    readFile,
  );
  assert.equal(type, "run_prod_script", "a DROP TABLE migration must NOT auto-approve");
});

test("(V2 DELETE-no-WHERE) an apply-*-migration.ts whose SQL is an unqualified DELETE stays run_prod_script", () => {
  const wipeSql = `DELETE FROM public.orders;`; // no WHERE — a backfill wipe
  const readFile = makeReadFile({
    "scripts/apply-orders-wipe-migration.ts": `const M = ["20260901120000_wipe_orders.sql"];`,
    "supabase/migrations/20260901120000_wipe_orders.sql": wipeSql,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-orders-wipe-migration.ts",
    "wipe orders",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(V2 non-migration) a run_prod_script whose cmd is NOT a scripts/apply-*-migration.ts path stays run_prod_script (blast radius unknown → CEO)", () => {
  const readFile = makeReadFile({});
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/_backfill-customers.ts --apply", // a backfill script, not a migration
    "backfill customers.first_name from raw import",
    readFile,
  );
  assert.equal(type, "run_prod_script", "a lone bounded script never inspects as SQL — must stay out of leash");
});

test("(V2 preview-only spoof) a run_prod_script that DECLARES additive SQL in preview but points at a non-apply-*-migration.ts cmd stays run_prod_script", () => {
  // Defense-in-depth: the preview alone is not sufficient. Only a cmd that names a real
  // `scripts/apply-*-migration.ts` (whose source the classifier can then scan) unlocks the lane.
  const readFile = makeReadFile({});
  const type = tagPendingActionType(
    "run_prod_script",
    "psql -c 'ALTER TABLE t ADD COLUMN c int;'",
    "ALTER TABLE t ADD COLUMN c int;",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

// ── Fix 1 regression suite — fail-closed hardening (security-review remediation) ─────────────────

test("(F1 compound `;`) a compound cmd `apply-foo-migration.ts; rm -rf /` stays run_prod_script — reclassification MUST NOT happen when a second command trails the apply", () => {
  const readFile = makeReadFile({
    "scripts/apply-foo-migration.ts": `const M = ["20260101000000_add.sql"];`,
    "supabase/migrations/20260101000000_add.sql": `ALTER TABLE t ADD COLUMN c int;`,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-foo-migration.ts; rm -rf /",
    "add column c",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(F1 compound `&&`) a compound cmd chained with `&&` stays run_prod_script", () => {
  const readFile = makeReadFile({
    "scripts/apply-foo-migration.ts": `const M = ["20260101000000_add.sql"];`,
    "supabase/migrations/20260101000000_add.sql": `ALTER TABLE t ADD COLUMN c int;`,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-foo-migration.ts && curl https://evil.example.com",
    "add column c",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(F1 pipe `|`) a piped cmd stays run_prod_script", () => {
  const readFile = makeReadFile({
    "scripts/apply-foo-migration.ts": `const M = ["20260101000000_add.sql"];`,
    "supabase/migrations/20260101000000_add.sql": `ALTER TABLE t ADD COLUMN c int;`,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-foo-migration.ts | tee out.log",
    "add column c",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(F1 substitution `$(...)`) a cmd with command substitution stays run_prod_script", () => {
  const readFile = makeReadFile({
    "scripts/apply-foo-migration.ts": `const M = ["20260101000000_add.sql"];`,
    "supabase/migrations/20260101000000_add.sql": `ALTER TABLE t ADD COLUMN c int;`,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-foo-migration.ts $(cat /etc/passwd)",
    "add column c",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(F1 backticks) a cmd with backtick expansion stays run_prod_script", () => {
  const readFile = makeReadFile({
    "scripts/apply-foo-migration.ts": `const M = ["20260101000000_add.sql"];`,
    "supabase/migrations/20260101000000_add.sql": `ALTER TABLE t ADD COLUMN c int;`,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-foo-migration.ts `whoami`",
    "add column c",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(F1 redirect `>`) a cmd with output redirection stays run_prod_script", () => {
  const readFile = makeReadFile({
    "scripts/apply-foo-migration.ts": `const M = ["20260101000000_add.sql"];`,
    "supabase/migrations/20260101000000_add.sql": `ALTER TABLE t ADD COLUMN c int;`,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-foo-migration.ts > /tmp/x",
    "add column c",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(F1 extra argv) a cmd with extra positional argv AFTER the script filename stays run_prod_script", () => {
  const readFile = makeReadFile({
    "scripts/apply-foo-migration.ts": `const M = ["20260101000000_add.sql"];`,
    "supabase/migrations/20260101000000_add.sql": `ALTER TABLE t ADD COLUMN c int;`,
  });
  // `--apply` on the end is a flag many other scripts accept — accepting it here would let an
  // attacker sneak args through the "same shape" test even though the accepted apply-migration
  // shape has NO flags in it.
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-foo-migration.ts --apply",
    "add column c",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(F1 leading-dash between) a `--yes`-style flag between npx and tsx (option-looking value) stays run_prod_script", () => {
  const readFile = makeReadFile({
    "scripts/apply-foo-migration.ts": `const M = ["20260101000000_add.sql"];`,
    "supabase/migrations/20260101000000_add.sql": `ALTER TABLE t ADD COLUMN c int;`,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx --yes tsx scripts/apply-foo-migration.ts",
    "add column c",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(F1 missing script) a cmd whose apply script cannot be read stays run_prod_script (fail-closed on unreadable script — prevents preview-spoof reclassify)", () => {
  const readFile = makeReadFile({
    // NO entry for scripts/apply-foo-migration.ts
    "supabase/migrations/20260101000000_add.sql": `ALTER TABLE t ADD COLUMN c int;`,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-foo-migration.ts",
    "additive-sounding preview that must not carry the leash decision alone",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(F1 missing SQL ref) an apply script whose referenced .sql file cannot be read stays run_prod_script (fail-closed on unreadable SQL — no partial-classification pass)", () => {
  const readFile = makeReadFile({
    "scripts/apply-foo-migration.ts": `const M = ["20260101000000_missing.sql"];`,
    // NO entry for supabase/migrations/20260101000000_missing.sql
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-foo-migration.ts",
    "add column c",
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(F1 disk source is truth) a script whose SOURCE is destructive stays run_prod_script even if the ACTION preview declares additive SQL — preview never trusted for the leash decision", () => {
  // The disk source contains a `DROP TABLE`; a would-be attacker fills preview with harmless
  // additive text. The classifier must run on-disk contents only, so this MUST NOT reclassify.
  const readFile = makeReadFile({
    "scripts/apply-foo-migration.ts": `const M = ["20260101000000_drop.sql"];`,
    "supabase/migrations/20260101000000_drop.sql": `DROP TABLE public.important;`,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-foo-migration.ts",
    "ALTER TABLE t ADD COLUMN c int;", // spoofed additive-looking preview
    readFile,
  );
  assert.equal(type, "run_prod_script");
});

test("(F1 bare `tsx`) the shape `tsx scripts/apply-<slug>-migration.ts` (no npx prefix) IS accepted — matches deployment convention where tsx is on PATH", () => {
  const readFile = makeReadFile({
    "scripts/apply-foo-migration.ts": `const M = ["20260101000000_add.sql"];`,
    "supabase/migrations/20260101000000_add.sql": `ALTER TABLE t ADD COLUMN c int;`,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "tsx scripts/apply-foo-migration.ts",
    "add column c",
    readFile,
  );
  assert.equal(type, "apply_migration");
});

test("(F1 parser) parseSingleApplyMigrationCommand: pinning the exact accepted argv shape (canonical rejection matrix)", () => {
  // Accept: two anchored shapes only
  assert.deepEqual(
    parseSingleApplyMigrationCommand("npx tsx scripts/apply-foo-migration.ts"),
    { scriptFileName: "apply-foo-migration.ts" },
  );
  assert.deepEqual(
    parseSingleApplyMigrationCommand("tsx scripts/apply-foo-migration.ts"),
    { scriptFileName: "apply-foo-migration.ts" },
  );
  // Reject: every deviation
  const rejects = [
    "", // empty
    "   ", // whitespace
    "scripts/apply-foo-migration.ts", // missing tsx runner
    "node scripts/apply-foo-migration.ts", // wrong runner (only tsx/npx tsx accepted)
    "npx tsx scripts/apply-foo-migration.ts --apply", // trailing flag
    "npx tsx scripts/apply-foo-migration.ts extra-arg", // trailing positional
    "npx tsx scripts/apply-foo-migration.ts ;", // trailing semi
    "npx tsx scripts/apply-foo-migration.ts && echo done", // compound &&
    "npx tsx scripts/apply-foo-migration.ts | tee out", // pipe
    "npx tsx scripts/apply-foo-migration.ts > out", // redirect
    "npx tsx scripts/apply-foo-migration.ts $(id)", // substitution
    "`npx tsx scripts/apply-foo-migration.ts`", // backticks
    "npx --yes tsx scripts/apply-foo-migration.ts", // flag between npx and tsx
    "npx tsx scripts/apply-foo.ts", // wrong suffix
    "npx tsx scripts/_backfill-foo.ts", // wrong prefix
    "npx tsx scripts/apply-foo-migration.ts\nrm -rf /", // newline injection
    "npx tsx /etc/passwd", // path traversal (missing scripts/ prefix)
    "npx tsx scripts/../etc/passwd", // path traversal via `..`
  ];
  for (const cmd of rejects) {
    assert.equal(
      parseSingleApplyMigrationCommand(cmd),
      null,
      `parser must REJECT ${JSON.stringify(cmd)}`,
    );
  }
});

test("(V2 mixed) an apply-*-migration.ts referencing MULTIPLE .sql files with ANY non-additive statement stays run_prod_script", () => {
  const additive = `ALTER TABLE t ADD COLUMN c int;`;
  const destructive = `ALTER TABLE t DROP COLUMN old_c;`;
  const readFile = makeReadFile({
    "scripts/apply-mixed-migration.ts": `const M = ["20260101000000_add.sql", "20260101000100_drop.sql"];`,
    "supabase/migrations/20260101000000_add.sql": additive,
    "supabase/migrations/20260101000100_drop.sql": destructive,
  });
  const type = tagPendingActionType(
    "run_prod_script",
    "npx tsx scripts/apply-mixed-migration.ts",
    "mixed migration",
    readFile,
  );
  assert.equal(type, "run_prod_script", "ANY non-additive statement in the union must escalate");
});

// ── Verification #3 — assertRegistryInvariants passes with the corrected platform-director cadence ─

test("(V3) assertRegistryInvariants passes with the corrected platform-director-cron cadence", async () => {
  const { assertRegistryInvariants, MONITORED_LOOPS } = await import("./control-tower/registry");
  // The invariant runs at module import, so if the corrected cadence violated the floor + jitter
  // grace, this import itself would have thrown. Re-invoking here re-asserts against the current
  // MONITORED_LOOPS AND pins the exact expected shape of the platform-director-cron row so a
  // future regression to "daily" or a sub-5-min cadence fails this test — not just the bootstrap.
  assert.doesNotThrow(() => assertRegistryInvariants());
  const row = MONITORED_LOOPS.find((l) => l.id === "platform-director-cron");
  assert.ok(row, "platform-director-cron must remain a registered MONITORED_LOOPS row");
  assert.match(
    row.expectedCadence,
    /\*\/5 \* \* \* \*/,
    `expectedCadence must reflect the deployed */5 cadence — got '${row.expectedCadence}'`,
  );
  assert.ok(
    (row.livenessWindowMs ?? 0) >= 5 * 60 * 1000 * 1.2,
    `livenessWindowMs must satisfy MONITOR_TICK_FLOOR × REGISTRY_LIVENESS_JITTER_GRACE — got ${row.livenessWindowMs}`,
  );
});

// ── Sanity ────────────────────────────────────────────────────────────────────────────────────────

test("(sanity) merge_pr type is preserved untouched (out of scope for Phase 2)", () => {
  const readFile = makeReadFile({});
  assert.equal(tagPendingActionType("merge_pr", "gh pr merge …", undefined, readFile), "merge_pr");
});

test("(sanity) an unrecognized raw type defaults to apply_migration (pre-Phase-2 behavior preserved at the same chokepoint)", () => {
  const readFile = makeReadFile({});
  assert.equal(tagPendingActionType("something_else", "foo", "bar", readFile), "apply_migration");
});

test("(sanity) APPLY_MIGRATION_SCRIPT_REGEX matches the on-disk convention (scripts/apply-<slug>-migration.ts) and rejects lookalikes", () => {
  assert.ok(APPLY_MIGRATION_SCRIPT_REGEX.test("npx tsx scripts/apply-foo-migration.ts"));
  assert.ok(APPLY_MIGRATION_SCRIPT_REGEX.test("scripts/apply-a-b-c-migration.ts"));
  // A lookalike that is NOT the on-disk convention (no `-migration` suffix or no `apply-` prefix)
  // must NOT match — the tag decision falls through to run_prod_script.
  assert.equal(APPLY_MIGRATION_SCRIPT_REGEX.test("scripts/apply-foo.ts"), false);
  assert.equal(APPLY_MIGRATION_SCRIPT_REGEX.test("scripts/_backfill-foo.ts"), false);
});
