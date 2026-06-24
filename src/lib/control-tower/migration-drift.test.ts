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
} from "./migration-drift";

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
