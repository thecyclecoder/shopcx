/**
 * Unit tests for the PURE migration-drift parser (migration-drift-track-table-renames spec, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/migration-drift.test.ts
 *
 * Focus: rename-awareness. A table renamed by a later migration must net to expecting ONLY the new
 * name — the regression that reddened the `migration-drift-check` tile (worker_*→agent_* with no
 * DROP left the old names stuck in `expected`, flagged as silently-skipped CREATEs on a healthy DB).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractRenamedTables,
  foldMigrations,
  computeDrift,
  computeMergedButUnapplied,
  extractMigrationVersion,
  detectDuplicateLocalVersions,
  runMigrationDriftCheck,
  applyMergedMigrations,
  anyApplied,
  driftSummary,
  isDuplicateObjectError,
  DUPLICATE_OBJECT_SQLSTATES,
  splitSqlStatements,
  type MergedUnappliedMigration,
} from "./migration-drift";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("extractRenamedTables captures ALTER TABLE … RENAME TO (if exists, public., quoted)", () => {
  const sql = `
    alter table if exists public.worker_action_grades rename to agent_action_grades;
    alter table "public"."worker_grader_prompts" rename to "agent_grader_prompts";
    ALTER TABLE worker_instructions RENAME TO agent_instructions;
  `;
  assert.deepEqual(extractRenamedTables(sql), [
    { from: "worker_action_grades", to: "agent_action_grades" },
    { from: "worker_grader_prompts", to: "agent_grader_prompts" },
    { from: "worker_instructions", to: "agent_instructions" },
  ]);
});

test("extractRenamedTables ignores RENAME COLUMN (only table renames count)", () => {
  const sql = `alter table if exists public.agent_action_grades rename column worker_kind to agent_kind;`;
  assert.deepEqual(extractRenamedTables(sql), []);
});

test("extractRenamedTables ignores commented-out renames", () => {
  const sql = `
    -- alter table public.foo rename to bar;
    /* alter table public.baz rename to qux; */
  `;
  assert.deepEqual(extractRenamedTables(sql), []);
});

test("create-then-rename nets to expecting ONLY the new name (the worker_*→agent_* regression)", () => {
  const files = [
    {
      file: "20260101000000_create_worker_tables.sql",
      sql: `
        create table public.worker_action_grades (id uuid primary key);
        create table public.worker_grader_prompts (id uuid primary key);
        create table public.worker_instructions (id uuid primary key);
        create table public.worker_coaching_log (id uuid primary key);
      `,
    },
    {
      file: "20260705150000_worker_to_agent_rename.sql",
      sql: `
        alter table if exists public.worker_action_grades rename to agent_action_grades;
        alter table if exists public.worker_grader_prompts rename to agent_grader_prompts;
        alter table if exists public.worker_instructions  rename to agent_instructions;
        alter table if exists public.worker_coaching_log  rename to agent_coaching_log;
        alter table if exists public.agent_action_grades rename column worker_kind to agent_kind;
      `,
    },
  ];
  const { expected } = foldMigrations(files);
  const names = [...expected.keys()].sort();
  assert.deepEqual(names, [
    "agent_action_grades",
    "agent_coaching_log",
    "agent_grader_prompts",
    "agent_instructions",
  ]);
  // No worker_* lingers.
  assert.equal(
    [...expected.keys()].some((t) => t.startsWith("worker_")),
    false,
  );
});

test("renamed table inherits the FIRST-creating migration (fallback: the rename file)", () => {
  const createFile = "20260101000000_create.sql";
  const renameFile = "20260705150000_rename.sql";
  const { expected } = foldMigrations([
    { file: createFile, sql: `create table public.worker_instructions (id uuid primary key);` },
    { file: renameFile, sql: `alter table public.worker_instructions rename to agent_instructions;` },
  ]);
  assert.equal(expected.get("agent_instructions"), createFile);

  // A rename of a table never seen as CREATEd falls back to the rename migration.
  const { expected: e2 } = foldMigrations([
    { file: renameFile, sql: `alter table if exists public.legacy_thing rename to new_thing;` },
  ]);
  assert.equal(e2.get("new_thing"), renameFile);
});

test("a healthy live schema (only agent_* present) yields ZERO drift after a rename", () => {
  const { expected } = foldMigrations([
    { file: "a.sql", sql: `create table public.worker_action_grades (id uuid primary key);` },
    { file: "b.sql", sql: `alter table public.worker_action_grades rename to agent_action_grades;` },
  ]);
  const { missing } = computeDrift(expected, ["agent_action_grades"]);
  assert.deepEqual(missing, []);
});

test("drop-awareness still holds alongside renames (create→rename→drop = net-absent)", () => {
  const { expected } = foldMigrations([
    { file: "a.sql", sql: `create table public.temp_old (id uuid primary key);` },
    { file: "b.sql", sql: `alter table public.temp_old rename to temp_new;` },
    { file: "c.sql", sql: `drop table if exists public.temp_new;` },
  ]);
  assert.equal(expected.has("temp_old"), false);
  assert.equal(expected.has("temp_new"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// migration-drift-check-stop-false-positive-on-present-tables spec Phase 2 —
// regression pin: expected tables that EXIST in the live-present set MUST NOT surface as absent.
// The 2026-07-08 incident: 20260908120000_god_mode_sessions_and_approvals CREATE-TABLEs both
// god_mode_sessions + god_mode_approvals; both tables physically existed in prod, but the pooler's
// per-role privilege filter on information_schema.tables hid them from the drift check's live-set
// read → both flagged missing → the loop:migration-drift-check tile paged a phantom alert. Phase 1
// swapped the fetch to pg_catalog.pg_class (permission-agnostic); this test pins the invariant at
// the pure layer so a future regression that shrinks the live set the same way is caught in unit-test.
// ─────────────────────────────────────────────────────────────────────────────
test("runMigrationDriftCheck — expected tables PRESENT in the live set are never flagged missing (god_mode phantom-alert regression pin)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migration-drift-test-"));
  try {
    writeFileSync(
      join(dir, "20260908120000_god_mode_sessions_and_approvals.sql"),
      `create table if not exists public.god_mode_sessions (id uuid primary key);
       create table if not exists public.god_mode_approvals (id uuid primary key);`,
    );
    const result = await runMigrationDriftCheck({
      migrationsDir: dir,
      // Both expected tables ARE present in the live-set read — the state that WAS misreported.
      fetchLiveTables: async () => ["god_mode_sessions", "god_mode_approvals"],
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.allowlistedMissing, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runMigrationDriftCheck — a GENUINELY-absent expected table still surfaces (no over-correction from the god_mode fix)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migration-drift-test-"));
  try {
    writeFileSync(
      join(dir, "20260908120000_god_mode_sessions_and_approvals.sql"),
      `create table if not exists public.god_mode_sessions (id uuid primary key);
       create table if not exists public.god_mode_approvals (id uuid primary key);`,
    );
    writeFileSync(
      join(dir, "20260930120000_truly_missing.sql"),
      `create table public.truly_missing (id uuid primary key);`,
    );
    // Live set has the god_mode pair but is genuinely missing `truly_missing` — the check MUST flag it.
    const result = await runMigrationDriftCheck({
      migrationsDir: dir,
      fetchLiveTables: async () => ["god_mode_sessions", "god_mode_approvals"],
    });
    assert.equal(result.status, "drift");
    assert.deepEqual(result.missing, [
      { table: "truly_missing", migration: "20260930120000_truly_missing.sql" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ci-guard-migrations-applied-not-just-merged spec Phase 1 — applied-set reconcile.
// Regression pin: 20260918120000_order_refunds_mirror.sql merged 2026-07-06 but never applied,
// so order_refunds did not exist in prod until a manual apply. The reconcile is the guard.
// ─────────────────────────────────────────────────────────────────────────────

test("extractMigrationVersion parses the 14-digit prefix (and returns null for off-format files)", () => {
  assert.equal(
    extractMigrationVersion("20260918120000_order_refunds_mirror.sql"),
    "20260918120000",
  );
  assert.equal(
    extractMigrationVersion("20260101000000_create_worker_tables.sql"),
    "20260101000000",
  );
  // Off-format (the write-migration recipe's scratch pattern) → skipped by the reconcile.
  assert.equal(extractMigrationVersion("_PENDING_meta_comments_retire_channel.sql"), null);
  assert.equal(extractMigrationVersion("misc.sql"), null);
});

test("computeMergedButUnapplied FLAGS a file on main whose version isn't in the applied set (order_refunds_mirror regression pin)", () => {
  // The exact 2026-07-06 incident: 20260918120000_order_refunds_mirror merged but never applied.
  const files = [
    "20260917120000_create_order_refunds.sql", // applied
    "20260918120000_order_refunds_mirror.sql", // MERGED-BUT-UNAPPLIED
    "20260919120000_cs_director_grader_anti_goodhart_clause.sql", // applied
  ];
  const applied = ["20260917120000", "20260919120000"];
  const { mergedButUnapplied, appliedNotOnMain } = computeMergedButUnapplied(files, applied);
  assert.deepEqual(mergedButUnapplied, [
    { version: "20260918120000", file: "20260918120000_order_refunds_mirror.sql" },
  ]);
  // No false reverse alarm: every applied version has a file.
  assert.deepEqual(appliedNotOnMain, []);
});

test("computeMergedButUnapplied — a fully-applied repo reports ZERO merged-but-unapplied", () => {
  const files = [
    "20260917120000_create_order_refunds.sql",
    "20260918120000_order_refunds_mirror.sql",
    "20260919120000_cs_director_grader_anti_goodhart_clause.sql",
  ];
  const applied = ["20260917120000", "20260918120000", "20260919120000"];
  const { mergedButUnapplied, appliedNotOnMain } = computeMergedButUnapplied(files, applied);
  assert.deepEqual(mergedButUnapplied, []);
  assert.deepEqual(appliedNotOnMain, []);
});

test("computeMergedButUnapplied — the reverse (applied version with no file on main) does NOT raise a merged-but-unapplied alarm", () => {
  // A renamed/deleted migration that was applied long ago. This is BENIGN — informational only.
  const files = [
    "20260917120000_create_order_refunds.sql",
    "20260918120000_order_refunds_mirror.sql",
  ];
  const applied = [
    "20260101000000", // an old apply whose file was renamed/deleted from main.
    "20260917120000",
    "20260918120000",
  ];
  const { mergedButUnapplied, appliedNotOnMain } = computeMergedButUnapplied(files, applied);
  assert.deepEqual(mergedButUnapplied, []); // NOT flagged as merged-but-unapplied.
  assert.deepEqual(appliedNotOnMain, ["20260101000000"]); // recorded informationally.
});

test("computeMergedButUnapplied — off-format files (e.g. _PENDING_*.sql) are neither flagged nor counted against the applied set", () => {
  const files = [
    "20260917120000_create_order_refunds.sql",
    "_PENDING_meta_comments_retire_channel.sql", // no version prefix — skipped.
  ];
  const applied = ["20260917120000"];
  const { mergedButUnapplied, appliedNotOnMain } = computeMergedButUnapplied(files, applied);
  assert.deepEqual(mergedButUnapplied, []); // _PENDING_ file not flagged.
  assert.deepEqual(appliedNotOnMain, []);
});

test("runMigrationDriftCheck surfaces mergedButUnapplied on the drift result (both axes on one tile)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migration-drift-test-"));
  try {
    writeFileSync(
      join(dir, "20260917120000_create_order_refunds.sql"),
      `create table public.order_refunds (id uuid primary key);`,
    );
    writeFileSync(
      join(dir, "20260918120000_order_refunds_mirror.sql"),
      `create table public.order_refunds_mirror (id uuid primary key);`,
    );
    // Live schema HAS both tables (nothing missing on the table-presence axis) but the applied set
    // is missing 20260918120000 → merged-but-unapplied alone should still flip status to 'drift'.
    const result = await runMigrationDriftCheck({
      migrationsDir: dir,
      fetchLiveTables: async () => ["order_refunds", "order_refunds_mirror"],
      fetchAppliedVersions: async () => ["20260917120000"],
    });
    assert.equal(result.status, "drift");
    assert.deepEqual(result.missing, []); // table-presence axis says fine.
    assert.deepEqual(result.mergedButUnapplied, [
      { version: "20260918120000", file: "20260918120000_order_refunds_mirror.sql" },
    ]);
    assert.equal(result.appliedCheckSkipped, false);
    assert.equal(result.appliedCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runMigrationDriftCheck honestly SKIPS the applied-set axis when no fetchAppliedVersions callback is supplied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migration-drift-test-"));
  try {
    writeFileSync(
      join(dir, "20260917120000_create_order_refunds.sql"),
      `create table public.order_refunds (id uuid primary key);`,
    );
    const result = await runMigrationDriftCheck({
      migrationsDir: dir,
      fetchLiveTables: async () => ["order_refunds"],
      // no fetchAppliedVersions — the tile's table-presence axis still runs.
    });
    assert.equal(result.status, "ok"); // table-presence axis is clean; no applied-set false-fire.
    assert.deepEqual(result.mergedButUnapplied, []);
    assert.equal(result.appliedCheckSkipped, true);
    assert.equal(result.appliedCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runMigrationDriftCheck — applied-set slice fetch that throws is captured (skipped, not a false clean)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migration-drift-test-"));
  try {
    writeFileSync(
      join(dir, "20260917120000_create_order_refunds.sql"),
      `create table public.order_refunds (id uuid primary key);`,
    );
    const result = await runMigrationDriftCheck({
      migrationsDir: dir,
      fetchLiveTables: async () => ["order_refunds"],
      fetchAppliedVersions: async () => {
        throw new Error("pg unreachable");
      },
    });
    // Table-presence axis is fine (status ok), applied-set axis is honestly marked skipped.
    assert.equal(result.status, "ok");
    assert.equal(result.appliedCheckSkipped, true);
    assert.match(result.reason ?? "", /applied-versions read failed.*pg unreachable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ci-guard-migrations-applied-not-just-merged spec Phase 2 — close the loop:
// alert + apply, never leave it inert. applyMergedMigrations classifies each merged-but-unapplied
// via the sanctioned classifyMigrationSql gate; additive → auto-apply, destructive → approval-needed.
// ─────────────────────────────────────────────────────────────────────────────

const ADDITIVE_ORDER_REFUNDS: MergedUnappliedMigration = {
  version: "20260918120000",
  file: "20260918120000_order_refunds_mirror.sql",
};
const ADDITIVE_INDEX: MergedUnappliedMigration = {
  version: "20260920120000",
  file: "20260920120000_add_index.sql",
};
const DESTRUCTIVE_DROP: MergedUnappliedMigration = {
  version: "20260921120000",
  file: "20260921120000_drop_stale_ledger.sql",
};
const DESTRUCTIVE_TRUNCATE: MergedUnappliedMigration = {
  version: "20260922120000",
  file: "20260922120000_truncate_stale.sql",
};

test("applyMergedMigrations — an ADDITIVE merged-but-unapplied migration is auto-applied (verification bullet 1)", async () => {
  const applied: string[] = [];
  const approvalCalls: string[] = [];
  const out = await applyMergedMigrations([ADDITIVE_ORDER_REFUNDS], {
    readSql: () => `create table public.order_refunds_mirror (id uuid primary key);`,
    applyMigration: async ({ version }) => {
      applied.push(version);
    },
    onApprovalNeeded: async ({ version }) => {
      approvalCalls.push(version);
    },
  });
  assert.deepEqual(applied, ["20260918120000"]);
  assert.deepEqual(approvalCalls, []); // additive DOES NOT reach the approval hook.
  assert.equal(out[0]?.outcome, "applied");
  assert.equal(out[0]?.severity, "additive");
  assert.equal(anyApplied(out), true);
});

test("applyMergedMigrations — a DESTRUCTIVE merged-but-unapplied migration is GATED (approval-needed, NEVER auto-applied — verification bullet 2)", async () => {
  const applied: string[] = [];
  const approvalCalls: Array<{ version: string; severity: string; matches: string[] }> = [];
  const out = await applyMergedMigrations([DESTRUCTIVE_DROP, DESTRUCTIVE_TRUNCATE], {
    readSql: (file) =>
      file.includes("truncate")
        ? `truncate table public.stale;`
        : `drop table public.stale_ledger;`,
    applyMigration: async ({ version }) => {
      applied.push(version); // MUST NOT fire for destructive
    },
    onApprovalNeeded: async ({ version, severity, matches }) => {
      approvalCalls.push({ version, severity, matches });
    },
  });
  assert.deepEqual(applied, []); // Critical invariant: NEVER auto-applied.
  assert.equal(approvalCalls.length, 2);
  assert.equal(out[0]?.outcome, "approval-needed");
  assert.equal(out[0]?.severity, "irreversible_destructive");
  assert.ok(out[0]?.matches?.includes("DROP TABLE"));
  assert.equal(out[1]?.outcome, "approval-needed");
  assert.ok(out[1]?.matches?.includes("TRUNCATE"));
  assert.equal(anyApplied(out), false); // no re-check needed when nothing applied.
});

test("applyMergedMigrations — a mixed batch applies the additive one and gates the destructive one in the SAME pass", async () => {
  const applied: string[] = [];
  const approvalCalls: string[] = [];
  const out = await applyMergedMigrations([ADDITIVE_INDEX, DESTRUCTIVE_DROP, ADDITIVE_ORDER_REFUNDS], {
    readSql: (file) => {
      if (file.includes("drop")) return `drop table public.stale_ledger;`;
      if (file.includes("index")) return `create index idx_foo on public.foo (bar);`;
      return `create table public.order_refunds_mirror (id uuid primary key);`;
    },
    applyMigration: async ({ version }) => {
      applied.push(version);
    },
    onApprovalNeeded: async ({ version }) => {
      approvalCalls.push(version);
    },
  });
  assert.deepEqual(applied.sort(), ["20260918120000", "20260920120000"]);
  assert.deepEqual(approvalCalls, ["20260921120000"]);
  assert.equal(out.map((m) => m.outcome).join(","), "applied,approval-needed,applied");
  assert.equal(anyApplied(out), true); // triggers a re-check by the caller.
});

test("applyMergedMigrations — an additive migration whose applyMigration THROWS is captured as apply-failed (never crashes the batch)", async () => {
  const applied: string[] = [];
  const out = await applyMergedMigrations([ADDITIVE_ORDER_REFUNDS, ADDITIVE_INDEX], {
    readSql: () => `create table public.foo (id uuid primary key);`,
    applyMigration: async ({ version }) => {
      if (version === "20260918120000") throw new Error("pg: constraint violation");
      applied.push(version);
    },
  });
  assert.equal(out[0]?.outcome, "apply-failed");
  assert.match(out[0]?.error ?? "", /constraint violation/);
  // The next migration in the batch still runs — a bad one in the middle never blocks the tail.
  assert.equal(out[1]?.outcome, "applied");
  assert.deepEqual(applied, ["20260920120000"]);
  assert.equal(anyApplied(out), true); // one still applied → re-check should fire.
});

test("applyMergedMigrations — onApprovalNeeded hook that throws does NOT downgrade the routing (destructive stays approval-needed)", async () => {
  const applied: string[] = [];
  const out = await applyMergedMigrations([DESTRUCTIVE_DROP], {
    readSql: () => `drop table public.stale_ledger;`,
    applyMigration: async ({ version }) => {
      applied.push(version); // MUST NOT fire.
    },
    onApprovalNeeded: async () => {
      throw new Error("dashboard write failed");
    },
  });
  assert.deepEqual(applied, []); // The hook failing does NOT open the auto-apply path.
  assert.equal(out[0]?.outcome, "approval-needed");
});

test("applyMergedMigrations — a readSql that throws yields apply-failed with the read error (never auto-applies uninspected SQL)", async () => {
  const applied: string[] = [];
  const out = await applyMergedMigrations([ADDITIVE_ORDER_REFUNDS], {
    readSql: () => {
      throw new Error("ENOENT: file not found");
    },
    applyMigration: async ({ version }) => {
      applied.push(version); // MUST NOT fire when we couldn't read the SQL.
    },
  });
  assert.deepEqual(applied, []);
  assert.equal(out[0]?.outcome, "apply-failed");
  assert.match(out[0]?.error ?? "", /read failed.*ENOENT/);
});

test("box control loop — after a successful auto-apply the reconciler reports zero drift on the applied-set axis (verification bullet 3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migration-drift-test-"));
  try {
    writeFileSync(
      join(dir, "20260918120000_order_refunds_mirror.sql"),
      `create table public.order_refunds_mirror (id uuid primary key);`,
    );
    // Simulate the box's applied-versions store — a Set the applyMigration callback mutates.
    const appliedStore = new Set<string>();
    const first = await runMigrationDriftCheck({
      migrationsDir: dir,
      fetchLiveTables: async () => ["order_refunds_mirror"],
      fetchAppliedVersions: async () => [...appliedStore],
    });
    assert.equal(first.status, "drift");
    assert.equal(first.mergedButUnapplied.length, 1);
    const processed = await applyMergedMigrations(first.mergedButUnapplied, {
      readSql: (file) => readFileSyncSync(dir, file),
      applyMigration: async ({ version }) => {
        appliedStore.add(version);
      },
    });
    assert.equal(processed[0]?.outcome, "applied");
    // Re-check: applied-set now contains the version → merged-but-unapplied clears.
    const second = await runMigrationDriftCheck({
      migrationsDir: dir,
      fetchLiveTables: async () => ["order_refunds_mirror"],
      fetchAppliedVersions: async () => [...appliedStore],
    });
    assert.equal(second.status, "ok");
    assert.deepEqual(second.mergedButUnapplied, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// migration-drift-reconciler-idempotent-on-already-applied-objects spec Phase 1 —
// A duplicate-object error during additive auto-apply means already-applied, not apply-failed.
// The 2026-07 incident: 103 migration versions were merged-but-unrecorded (their DDL had already
// been applied) so the reconciler kept re-running additive DDL and getting duplicate_table /
// duplicate_object / cannot_change_return_type back — recorded as apply-failed, retried every tick.
// The classifier + outcome fix teaches the loop that "the object already exists" means the ledger
// is behind, not the DDL is broken. isDuplicateObjectError is the one place that reads err.code;
// applyMergedMigrations respects both a callback-returned {alreadyApplied:true} signal AND
// (safety-net) a thrown duplicate-object error.
// ─────────────────────────────────────────────────────────────────────────────

test("isDuplicateObjectError — recognizes every duplicate-object-class SQLSTATE (the six the spec calls out)", () => {
  // Every code in the exported set MUST be recognized — no missing rows.
  for (const code of DUPLICATE_OBJECT_SQLSTATES) {
    assert.equal(isDuplicateObjectError({ code }), true, `expected ${code} to classify as duplicate-object`);
  }
  // The six the spec names — pinned individually so a future edit that shrinks the set fails loudly.
  assert.equal(isDuplicateObjectError({ code: "42P07" }), true); // duplicate_table
  assert.equal(isDuplicateObjectError({ code: "42710" }), true); // duplicate_object
  assert.equal(isDuplicateObjectError({ code: "42723" }), true); // duplicate_function
  assert.equal(isDuplicateObjectError({ code: "42P06" }), true); // duplicate_schema
  assert.equal(isDuplicateObjectError({ code: "42701" }), true); // duplicate_column
  assert.equal(isDuplicateObjectError({ code: "42P13" }), true); // cannot_change_return_type
});

test("isDuplicateObjectError — genuine failure SQLSTATEs stay apply-failed (never silently record a broken migration)", () => {
  assert.equal(isDuplicateObjectError({ code: "42601" }), false); // syntax_error
  assert.equal(isDuplicateObjectError({ code: "42P01" }), false); // undefined_table
  assert.equal(isDuplicateObjectError({ code: "42703" }), false); // undefined_column
  assert.equal(isDuplicateObjectError({ code: "22P02" }), false); // invalid_text_representation
  assert.equal(isDuplicateObjectError({ code: "23505" }), false); // unique_violation (NOT a duplicate-object)
});

test("isDuplicateObjectError — tolerates non-Error / missing-code / non-string-code shapes without throwing", () => {
  assert.equal(isDuplicateObjectError(null), false);
  assert.equal(isDuplicateObjectError(undefined), false);
  assert.equal(isDuplicateObjectError("42P07"), false); // string, not object with .code
  assert.equal(isDuplicateObjectError(new Error("boom")), false); // vanilla Error, no code
  assert.equal(isDuplicateObjectError({}), false);
  assert.equal(isDuplicateObjectError({ code: 42101 }), false); // number, not string
});

test("applyMergedMigrations — an additive migration whose callback returns {alreadyApplied:true} tags outcome='already-applied' (not 'applied')", async () => {
  const applied: string[] = [];
  const out = await applyMergedMigrations([ADDITIVE_ORDER_REFUNDS], {
    readSql: () => `create table public.order_refunds_mirror (id uuid primary key);`,
    applyMigration: async ({ version }) => {
      applied.push(version);
      return { alreadyApplied: true };
    },
  });
  assert.deepEqual(applied, ["20260918120000"]);
  assert.equal(out[0]?.outcome, "already-applied");
  assert.equal(out[0]?.severity, "additive");
  // anyApplied is true — the reconciler should re-check so the ledger fix clears the tile.
  assert.equal(anyApplied(out), true);
});

test("applyMergedMigrations — a callback that THROWS a duplicate-object SQLSTATE is classified as already-applied (safety net when the caller forgot to catch)", async () => {
  const attempted: string[] = [];
  const out = await applyMergedMigrations([ADDITIVE_ORDER_REFUNDS], {
    readSql: () => `create table public.order_refunds_mirror (id uuid primary key);`,
    applyMigration: async ({ version }) => {
      attempted.push(version);
      // The exact shape node-postgres surfaces — Error subclass with a `code` property.
      const err = Object.assign(new Error(`relation "order_refunds_mirror" already exists`), {
        code: "42P07",
      });
      throw err;
    },
  });
  assert.deepEqual(attempted, ["20260918120000"]);
  assert.equal(out[0]?.outcome, "already-applied");
  assert.equal(out[0]?.severity, "additive");
  assert.equal(out[0]?.error, undefined); // already-applied is NOT an error
  assert.equal(anyApplied(out), true);
});

test("applyMergedMigrations — a genuine (non-duplicate-object) throw STILL yields apply-failed (regression pin — no over-swallowing)", async () => {
  const out = await applyMergedMigrations([ADDITIVE_ORDER_REFUNDS], {
    readSql: () => `create tabel public.typo (id uuid primary key);`, // syntax error
    applyMigration: async () => {
      const err = Object.assign(new Error("syntax error at or near \"tabel\""), { code: "42601" });
      throw err;
    },
  });
  assert.equal(out[0]?.outcome, "apply-failed");
  assert.match(out[0]?.error ?? "", /syntax error/);
});

test("applyMergedMigrations — mixed batch: fresh-apply + already-applied + genuine failure route to three DISTINCT outcomes on the same tick", async () => {
  const out = await applyMergedMigrations(
    [ADDITIVE_ORDER_REFUNDS, ADDITIVE_INDEX, { version: "20260930120000", file: "20260930120000_broken.sql" }],
    {
      readSql: (file) => {
        if (file.includes("broken")) return `create tabel public.oops (id uuid primary key);`;
        if (file.includes("index")) return `create index idx_foo on public.foo (bar);`;
        return `create table public.order_refunds_mirror (id uuid primary key);`;
      },
      applyMigration: async ({ version }) => {
        // order_refunds — fresh apply (fine, no throw, no signal).
        if (version === "20260918120000") return;
        // index — already-applied via return signal.
        if (version === "20260920120000") return { alreadyApplied: true };
        // broken — genuine syntax error.
        throw Object.assign(new Error("syntax error at or near \"tabel\""), { code: "42601" });
      },
    },
  );
  assert.equal(out[0]?.outcome, "applied");
  assert.equal(out[1]?.outcome, "already-applied");
  assert.equal(out[2]?.outcome, "apply-failed");
  assert.equal(anyApplied(out), true);
});

test("anyApplied — an already-applied outcome triggers a re-check (the ledger row was inserted; the tile should clear on the same tick)", () => {
  const items: MergedUnappliedMigration[] = [
    { ...ADDITIVE_ORDER_REFUNDS, outcome: "already-applied", severity: "additive", matches: [] },
    { ...DESTRUCTIVE_DROP, outcome: "approval-needed", severity: "irreversible_destructive", matches: ["DROP TABLE"] },
  ];
  assert.equal(anyApplied(items), true);
});

test("driftSummary — the outcome tail names an already-applied count when the reconciler cleared a ledger gap", () => {
  const summary = driftSummary({
    status: "drift",
    missing: [],
    allowlistedMissing: [],
    mergedButUnapplied: [
      { ...ADDITIVE_ORDER_REFUNDS, outcome: "already-applied", severity: "additive", matches: [] },
      { ...ADDITIVE_INDEX, outcome: "applied", severity: "additive", matches: [] },
    ],
    appliedNotOnMain: [],
    duplicateVersions: [],
    expectedCount: 0,
    liveCount: 0,
    parsedFiles: 0,
    appliedCount: 0,
    appliedCheckSkipped: false,
  });
  assert.match(summary, /1 applied/);
  assert.match(summary, /1 already-applied/);
});

// ─────────────────────────────────────────────────────────────────────────────
// migration-drift-reconciler-idempotent-on-already-applied-objects spec Phase 3 —
// Statement-level duplicate-object reconciliation. Regression pin for the security review's
// finding: the whole-file duplicate shortcut can hide unapplied tail statements when a
// multi-statement migration throws duplicate-object on an early statement. splitSqlStatements is
// the primitive; per-statement savepoint classification is the behaviour.
// ─────────────────────────────────────────────────────────────────────────────

test("splitSqlStatements — a single-statement file returns one element (the trivial case)", () => {
  assert.deepEqual(splitSqlStatements(`create table public.foo (id uuid primary key);`), [
    `create table public.foo (id uuid primary key)`,
  ]);
});

test("splitSqlStatements — multi-statement file splits at top-level semicolons (the security-review case)", () => {
  const sql = `create table public.foo (id uuid primary key);
create index idx_foo on public.foo (id);
insert into public.foo (id) values ('00000000-0000-0000-0000-000000000001');`;
  const stmts = splitSqlStatements(sql);
  assert.equal(stmts.length, 3);
  assert.match(stmts[0], /^create table/);
  assert.match(stmts[1], /^create index/);
  assert.match(stmts[2], /^insert into/);
});

test("splitSqlStatements — semicolons inside single-quoted string literals are NOT split points", () => {
  const sql = `insert into public.notes (body) values ('a;b;c');
insert into public.notes (body) values ('two');`;
  const stmts = splitSqlStatements(sql);
  assert.equal(stmts.length, 2);
  assert.ok(stmts[0].includes("'a;b;c'"));
  assert.ok(stmts[1].includes("'two'"));
});

test("splitSqlStatements — the SQL '' escape (doubled single quote) does not close the string early", () => {
  const sql = `insert into public.notes (body) values ('it''s fine; still one string');
select 1;`;
  const stmts = splitSqlStatements(sql);
  assert.equal(stmts.length, 2);
  assert.ok(stmts[0].includes("'it''s fine; still one string'"));
  assert.equal(stmts[1], "select 1");
});

test("splitSqlStatements — dollar-quoted function bodies protect embedded semicolons (the CREATE FUNCTION case)", () => {
  const sql = `create or replace function public.reset_sync_data()
returns void
language sql
security definer
as $$
  truncate public.orders, public.customers, public.sync_jobs cascade;
$$;
create index idx_after_function on public.orders (id);`;
  const stmts = splitSqlStatements(sql);
  assert.equal(stmts.length, 2);
  assert.ok(stmts[0].includes("$$"));
  assert.ok(stmts[0].includes("truncate public.orders"));
  assert.match(stmts[1], /^create index idx_after_function/);
});

test("splitSqlStatements — tagged dollar-quotes ($body$…$body$) also protect embedded semicolons", () => {
  const sql = `create or replace function public.foo() returns int language plpgsql as $body$
begin
  perform 1;
  perform 2;
  return 3;
end;
$body$;
select 1;`;
  const stmts = splitSqlStatements(sql);
  assert.equal(stmts.length, 2);
  assert.ok(stmts[0].includes("$body$"));
  assert.equal(stmts[1], "select 1");
});

test("splitSqlStatements — line comments (`--`) and block comments (`/* */`) don't hide statement boundaries", () => {
  const sql = `-- create table public.commented (id uuid); still one statement below
create table public.foo (id uuid primary key);
/* multi-line
   block; comment; nothing here */
create table public.bar (id uuid primary key);`;
  const stmts = splitSqlStatements(sql);
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /^-- create table[\s\S]*\ncreate table public\.foo/);
  assert.match(stmts[1], /^\/\* multi-line[\s\S]*create table public\.bar/);
});

test("splitSqlStatements — quoted identifiers with `;` inside stay intact", () => {
  const sql = `alter table public.foo rename to "weird;name";
select 1;`;
  const stmts = splitSqlStatements(sql);
  assert.equal(stmts.length, 2);
  assert.ok(stmts[0].includes(`"weird;name"`));
  assert.equal(stmts[1], "select 1");
});

test("splitSqlStatements — empty / comments-only inputs return an empty array", () => {
  assert.deepEqual(splitSqlStatements(""), []);
  assert.deepEqual(splitSqlStatements("   "), []);
  assert.deepEqual(splitSqlStatements(";;;"), []); // no non-empty statements between the terminators
  assert.deepEqual(
    splitSqlStatements(`-- comment only\n/* block */`),
    [`-- comment only\n/* block */`],
  );
});

test("splitSqlStatements — trailing statement without a final semicolon still counts", () => {
  const sql = `create table public.foo (id uuid primary key);
create table public.bar (id uuid primary key)`;
  const stmts = splitSqlStatements(sql);
  assert.equal(stmts.length, 2);
  assert.match(stmts[1], /^create table public\.bar/);
});

test("driftSummary — with Phase 2 outcomes populated, the summary tail names the outcome mix", () => {
  const summary = driftSummary({
    status: "drift",
    missing: [],
    allowlistedMissing: [],
    mergedButUnapplied: [
      { ...ADDITIVE_ORDER_REFUNDS, outcome: "applied", severity: "additive", matches: [] },
      { ...DESTRUCTIVE_DROP, outcome: "approval-needed", severity: "irreversible_destructive", matches: ["DROP TABLE"] },
    ],
    appliedNotOnMain: [],
    duplicateVersions: [],
    expectedCount: 0,
    liveCount: 0,
    parsedFiles: 0,
    appliedCount: 0,
    appliedCheckSkipped: false,
  });
  assert.match(summary, /1 applied/);
  assert.match(summary, /1 approval-needed/);
});

// ─────────────────────────────────────────────────────────────────────────────
// migration-drift-detect-duplicate-14-digit-version-collisions spec Phase 1 —
// Two supabase/migrations/*.sql files sharing the SAME 14-digit YYYYMMDDNNNNNN prefix silently
// dedupe on the applied-set axis (schema_migrations.version is unique) and the loser's DDL never
// runs. detectDuplicateLocalVersions surfaces the collision as drift so the tile red-flags it
// instead of silently dropping the loser (the media_buyer_cohort_excluded_all_customers_audience
// regression).
// ─────────────────────────────────────────────────────────────────────────────

test("detectDuplicateLocalVersions — two files sharing a 14-digit prefix are returned as a collision group (media_buyer regression pin)", () => {
  const files = [
    "20261026120000_ad_creative_copy_qc_verdicts_scroll_stop.sql",
    "20261026120000_media_buyer_cohort_excluded_all_customers_audience.sql",
    "20261026130000_media_buyer_all_customers_refresh_runs.sql", // different prefix — not a collision.
  ];
  assert.deepEqual(detectDuplicateLocalVersions(files), [
    {
      version: "20261026120000",
      files: [
        "20261026120000_ad_creative_copy_qc_verdicts_scroll_stop.sql",
        "20261026120000_media_buyer_cohort_excluded_all_customers_audience.sql",
      ],
    },
  ]);
});

test("detectDuplicateLocalVersions — a healthy repo (all unique 14-digit prefixes) returns an empty array", () => {
  const files = [
    "20260917120000_create_order_refunds.sql",
    "20260918120000_order_refunds_mirror.sql",
    "20260919120000_cs_director_grader_anti_goodhart_clause.sql",
  ];
  assert.deepEqual(detectDuplicateLocalVersions(files), []);
});

test("detectDuplicateLocalVersions — off-format files (no 14-digit prefix) cannot collide via the versioned index and are skipped", () => {
  const files = [
    "20260917120000_create_order_refunds.sql",
    "_PENDING_meta_comments_retire_channel.sql",
    "_PENDING_other_scratch.sql", // two off-format files — MUST NOT be reported as a "collision"
  ];
  assert.deepEqual(detectDuplicateLocalVersions(files), []);
});

test("detectDuplicateLocalVersions — three files sharing a prefix produce one group with all three files (files-within-group sorted lexically)", () => {
  const files = [
    "20261026120000_z_last.sql",
    "20261026120000_a_first.sql",
    "20261026120000_m_middle.sql",
  ];
  assert.deepEqual(detectDuplicateLocalVersions(files), [
    {
      version: "20261026120000",
      files: [
        "20261026120000_a_first.sql",
        "20261026120000_m_middle.sql",
        "20261026120000_z_last.sql",
      ],
    },
  ]);
});

test("detectDuplicateLocalVersions — multiple colliding prefixes are returned sorted by version", () => {
  const files = [
    "20261026120000_b.sql",
    "20261026120000_a.sql",
    "20260101000000_x.sql",
    "20260101000000_y.sql",
  ];
  assert.deepEqual(detectDuplicateLocalVersions(files), [
    { version: "20260101000000", files: ["20260101000000_x.sql", "20260101000000_y.sql"] },
    { version: "20261026120000", files: ["20261026120000_a.sql", "20261026120000_b.sql"] },
  ]);
});

test("runMigrationDriftCheck — two files sharing a 14-digit prefix flip status to 'drift' via the duplicateVersions axis (even when table-presence + applied-set are clean)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migration-drift-test-"));
  try {
    writeFileSync(
      join(dir, "20261026120000_ad_creative_copy_qc_verdicts_scroll_stop.sql"),
      `alter table public.ad_creative_copy_qc_verdicts add column if not exists scroll_stop text;`,
    );
    writeFileSync(
      join(dir, "20261026120000_media_buyer_cohort_excluded_all_customers_audience.sql"),
      `alter table public.media_buyer_test_cohorts add column if not exists excluded_all_customers_audience_id text;`,
    );
    // Live schema has every expected table AND the applied set knows both a version (which the
    // reconcile keys on) — but the duplicateVersions axis MUST still surface the collision.
    const result = await runMigrationDriftCheck({
      migrationsDir: dir,
      fetchLiveTables: async () => ["ad_creative_copy_qc_verdicts", "media_buyer_test_cohorts"],
      fetchAppliedVersions: async () => ["20261026120000"],
    });
    assert.equal(result.status, "drift");
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.mergedButUnapplied, []); // applied-set says the version is present — the silent-drop case.
    assert.deepEqual(result.duplicateVersions, [
      {
        version: "20261026120000",
        files: [
          "20261026120000_ad_creative_copy_qc_verdicts_scroll_stop.sql",
          "20261026120000_media_buyer_cohort_excluded_all_customers_audience.sql",
        ],
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("driftSummary — a duplicateVersions entry produces a 'duplicate version' parts entry (the tile detail text)", () => {
  const summary = driftSummary({
    status: "drift",
    missing: [],
    allowlistedMissing: [],
    mergedButUnapplied: [],
    appliedNotOnMain: [],
    duplicateVersions: [
      {
        version: "20261026120000",
        files: [
          "20261026120000_ad_creative_copy_qc_verdicts_scroll_stop.sql",
          "20261026120000_media_buyer_cohort_excluded_all_customers_audience.sql",
        ],
      },
    ],
    expectedCount: 0,
    liveCount: 0,
    parsedFiles: 2,
    appliedCount: 1,
    appliedCheckSkipped: false,
  });
  assert.match(summary, /1 duplicate version:/);
  assert.match(summary, /20261026120000/);
  assert.match(summary, /ad_creative_copy_qc_verdicts_scroll_stop\.sql/);
  assert.match(summary, /media_buyer_cohort_excluded_all_customers_audience\.sql/);
});

// Helper for the tmpdir-fixture reconcile test — the tests use writeFileSync so a sync read is fine.
function readFileSyncSync(dir: string, file: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs");
  return readFileSync(join(dir, file), "utf8");
}
