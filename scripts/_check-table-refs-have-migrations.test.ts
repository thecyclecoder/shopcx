/**
 * Unit tests for scripts/_check-table-refs-have-migrations.ts — pins the Phase 1
 * verification fixtures (ci-guard-table-refs-have-migrations):
 *   - Reintroducing the #1265 shape (`.from('order_refunds')` with no creating
 *     migration) fails the check with that table named.
 *   - A table created by a migration passes (both `public.<t>` and bare `<t>`).
 *   - A table created then RENAMED — the new name passes, the old name fails.
 *   - An allowlisted view/external ref passes.
 *   - A dynamic `.from(variable)` ref does not trigger a false failure.
 *   - A `.storage.from("bucket")` ref does not trigger a false failure.
 *   - `.from("x")` inside a block comment does not trigger a false failure.
 *
 * Run:
 *   npm run test:check-table-refs-have-migrations
 *   (= tsx --test scripts/_check-table-refs-have-migrations.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildCreatedTableSet,
  scanFromRefs,
  loadAllowlist,
  findViolations,
} from "./_check-table-refs-have-migrations";

function makeMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "table-refs-mig-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function makeSrcDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "table-refs-src-"));
  for (const [name, body] of Object.entries(files)) {
    const abs = join(dir, name);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

test("buildCreatedTableSet: parses `create table public.<t>` + bare `create table <t>`", () => {
  const dir = makeMigrationsDir({
    "20260101000000_a.sql": "create table public.foo (id uuid);",
    "20260102000000_b.sql": "CREATE TABLE bar (id uuid);",
    "20260103000000_c.sql": "create table if not exists public.baz (id uuid);",
  });
  try {
    const set = buildCreatedTableSet(dir);
    assert.ok(set.has("foo"));
    assert.ok(set.has("bar"));
    assert.ok(set.has("baz"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildCreatedTableSet: rename removes old name, adds new (klaviyo_profile_events → profile_events)", () => {
  const dir = makeMigrationsDir({
    "20260101000000_a.sql": "create table klaviyo_profile_events (id uuid);",
    "20260102000000_b.sql": "ALTER TABLE IF EXISTS klaviyo_profile_events RENAME TO profile_events;",
  });
  try {
    const set = buildCreatedTableSet(dir);
    assert.ok(set.has("profile_events"), "new name should be in the created set");
    assert.ok(!set.has("klaviyo_profile_events"), "old name should be gone after rename");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildCreatedTableSet: strips full-line SQL comments so prose CREATE TABLE lines are ignored", () => {
  const dir = makeMigrationsDir({
    "20260101000000_a.sql": "-- create table ghost (id uuid);\ncreate table real_table (id uuid);",
  });
  try {
    const set = buildCreatedTableSet(dir);
    assert.ok(set.has("real_table"));
    assert.ok(!set.has("ghost"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanFromRefs: catches literal `.from(\"t\")` and `.from('t')` refs", () => {
  const dir = makeSrcDir({
    "a.ts": `await admin.from("foo").select();\nawait admin.from('bar').select();`,
  });
  try {
    const refs = scanFromRefs(dir);
    const tables = refs.map((r) => r.table).sort();
    assert.deepEqual(tables, ["bar", "foo"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanFromRefs: ignores dynamic `.from(variable)` refs", () => {
  const dir = makeSrcDir({
    "a.ts": `const t = "foo";\nawait admin.from(t).select();`,
  });
  try {
    assert.deepEqual(scanFromRefs(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanFromRefs: ignores `.storage.from(\"bucket\")` refs", () => {
  const dir = makeSrcDir({
    "a.ts": `supabase.storage.from("imports").upload("x", blob);`,
  });
  try {
    assert.deepEqual(scanFromRefs(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanFromRefs: ignores `.from(\"t\")` inside block comments", () => {
  const dir = makeSrcDir({
    "a.ts": `/**\n * Example: await admin.from("ghost").select();\n */\nawait admin.from("real").select();`,
  });
  try {
    const tables = scanFromRefs(dir).map((r) => r.table);
    assert.deepEqual(tables, ["real"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanFromRefs: ignores `.from(\"t\")` inside `//` line comments", () => {
  const dir = makeSrcDir({
    "a.ts": `// await admin.from("ghost").select();\nawait admin.from("real").select();`,
  });
  try {
    const tables = scanFromRefs(dir).map((r) => r.table);
    assert.deepEqual(tables, ["real"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanFromRefs: descends nested directories", () => {
  const dir = makeSrcDir({
    "top.ts": `await admin.from("a").select();`,
    "nested/deep/inner.ts": `await admin.from("b").select();`,
  });
  try {
    const tables = scanFromRefs(dir).map((r) => r.table).sort();
    assert.deepEqual(tables, ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAllowlist: parses bare + `name # reason` lines, skips comments/blanks", () => {
  const path = join(mkdtempSync(join(tmpdir(), "table-refs-allow-")), "list.txt");
  writeFileSync(
    path,
    "# a header comment\n\nfoo\nbar  # a view backed by materialized_view_bar\n# baz  # commented-out\n",
  );
  try {
    const set = loadAllowlist(path);
    assert.ok(set.has("foo"));
    assert.ok(set.has("bar"));
    assert.ok(!set.has("baz"));
  } finally {
    rmSync(path, { force: true });
  }
});

test("loadAllowlist: returns empty set when the file is missing", () => {
  const set = loadAllowlist(join(tmpdir(), "definitely-not-a-file-xyz.txt"));
  assert.equal(set.size, 0);
});

test("findViolations: order_refunds without a creating migration is flagged (the #1265 shape)", () => {
  const migrationsDir = makeMigrationsDir({
    "20260101000000_a.sql": "create table orders (id uuid);",
  });
  const srcDir = makeSrcDir({
    "refund.ts": `await admin.from("order_refunds").insert({});`,
  });
  try {
    const violations = findViolations({
      srcDir,
      migrationsDir,
      allowlist: new Set(),
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].table, "order_refunds");
    assert.equal(violations[0].hits.length, 1);
  } finally {
    rmSync(migrationsDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
});

test("findViolations: a migrated table passes", () => {
  const migrationsDir = makeMigrationsDir({
    "20260101000000_a.sql": "create table order_refunds (id uuid);",
  });
  const srcDir = makeSrcDir({
    "refund.ts": `await admin.from("order_refunds").insert({});`,
  });
  try {
    assert.deepEqual(
      findViolations({ srcDir, migrationsDir, allowlist: new Set() }),
      [],
    );
  } finally {
    rmSync(migrationsDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
});

test("findViolations: renamed-to name passes; renamed-from name fails", () => {
  const migrationsDir = makeMigrationsDir({
    "20260101000000_a.sql": "create table klaviyo_profile_events (id uuid);",
    "20260102000000_b.sql": "ALTER TABLE IF EXISTS klaviyo_profile_events RENAME TO profile_events;",
  });
  const srcDirOk = makeSrcDir({
    "a.ts": `await admin.from("profile_events").select();`,
  });
  const srcDirStale = makeSrcDir({
    "a.ts": `await admin.from("klaviyo_profile_events").select();`,
  });
  try {
    assert.deepEqual(
      findViolations({ srcDir: srcDirOk, migrationsDir, allowlist: new Set() }),
      [],
    );
    const bad = findViolations({ srcDir: srcDirStale, migrationsDir, allowlist: new Set() });
    assert.equal(bad.length, 1);
    assert.equal(bad[0].table, "klaviyo_profile_events");
  } finally {
    rmSync(migrationsDir, { recursive: true, force: true });
    rmSync(srcDirOk, { recursive: true, force: true });
    rmSync(srcDirStale, { recursive: true, force: true });
  }
});

test("findViolations: an allowlisted ref passes even without a migration", () => {
  const migrationsDir = makeMigrationsDir({
    "20260101000000_a.sql": "create table orders (id uuid);",
  });
  const srcDir = makeSrcDir({
    "a.ts": `await admin.from("v_some_view").select();`,
  });
  try {
    assert.deepEqual(
      findViolations({
        srcDir,
        migrationsDir,
        allowlist: new Set(["v_some_view"]),
      }),
      [],
    );
  } finally {
    rmSync(migrationsDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
});

test("findViolations: real repo scan passes (no false positives on current main)", () => {
  const migrationsDir = join(__dirname, "..", "supabase", "migrations");
  const srcDir = join(__dirname, "..", "src");
  const allowlistPath = join(__dirname, "_check-table-refs-have-migrations.allowlist.txt");
  const violations = findViolations({
    srcDir,
    migrationsDir,
    allowlist: loadAllowlist(allowlistPath),
  });
  if (violations.length) {
    // Print the violations so the failure mode is loud when this test regresses.
    console.error(
      `real-repo scan surfaced ${violations.length} table(s) without a creating migration:`,
    );
    for (const v of violations) console.error(`  • ${v.table} (${v.hits.length} ref site(s))`);
  }
  assert.equal(violations.length, 0, "current main must pass the check");
});
