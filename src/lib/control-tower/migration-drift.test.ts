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
  runMigrationDriftCheck,
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
