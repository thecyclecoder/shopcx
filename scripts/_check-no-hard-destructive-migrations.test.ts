/**
 * Unit tests for scripts/_check-no-hard-destructive-migrations.ts — pins the four
 * Phase-2 verification fixtures (destructive-migration-safety-rails):
 *   - Exits 1 on a migration containing a bare `drop table x`.
 *   - Exits 0 on the rename-and-expire form.
 *   - Exits 0 on a DROP annotated `-- reversible: <reason>`.
 *   - Exits 0 on an additive-only migration.
 *
 * Run:
 *   npm run test:check-no-hard-destructive-migrations
 *   (= tsx --test scripts/_check-no-hard-destructive-migrations.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { scanMigrationsDir } from "./_check-no-hard-destructive-migrations";

function makeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-safety-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

// A timestamp that is comfortably after the GRANDFATHER_TS (2026-07-03) so the fixtures
// are subject to the rule. We pin far enough into the future that this test cannot slip.
const TS_A = "20270101000000";
const TS_B = "20270101010000";

test("scan: bare `drop table x` fails (exit 1 equivalent — one violation)", () => {
  const dir = makeDir({
    [`${TS_A}_bare_drop.sql`]: "drop table x;",
  });
  try {
    const v = scanMigrationsDir(dir);
    assert.equal(v.length, 1);
    assert.equal(v[0].pattern, "DROP TABLE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan: rename-and-expire form passes (no violation)", () => {
  const dir = makeDir({
    [`${TS_A}_rename_expire.sql`]: "alter table public.x rename to _deprecated_x_20270101;",
  });
  try {
    assert.deepEqual(scanMigrationsDir(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan: DROP TABLE annotated `-- reversible: <reason>` passes (no violation)", () => {
  const dir = makeDir({
    [`${TS_A}_annotated_drop.sql`]:
      "drop table public._deprecated_x_20260601;   -- reversible: 30d deprecation window elapsed\n",
  });
  try {
    assert.deepEqual(scanMigrationsDir(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan: annotation on the immediately preceding line also passes", () => {
  const dir = makeDir({
    [`${TS_A}_prev_line_annotation.sql`]:
      "-- reversible: scratch table never went to prod\ndrop table public._scratch_test;\n",
  });
  try {
    assert.deepEqual(scanMigrationsDir(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan: additive-only migration passes (no violation)", () => {
  const dir = makeDir({
    [`${TS_A}_additive.sql`]:
      "create table public.foo (id uuid primary key, name text not null);\n" +
      "alter table public.foo add column extra int;\n" +
      "create index idx_foo_name on public.foo(name);\n",
  });
  try {
    assert.deepEqual(scanMigrationsDir(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan: bare DROP COLUMN and TRUNCATE both flag", () => {
  const dir = makeDir({
    [`${TS_A}_drop_col.sql`]: "alter table public.x drop column y;",
    [`${TS_B}_truncate.sql`]: "truncate public.orders;",
  });
  try {
    const v = scanMigrationsDir(dir);
    assert.equal(v.length, 2);
    const patterns = v.map((x) => x.pattern).sort();
    assert.deepEqual(patterns, ["DROP COLUMN", "TRUNCATE"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan: pre-grandfather migrations are exempt (no violation for old bare drop)", () => {
  const dir = makeDir({
    "20260101000000_old_bare_drop.sql": "drop table x;",
  });
  try {
    assert.deepEqual(scanMigrationsDir(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan: line-comment prose containing `drop table` is not a violation", () => {
  const dir = makeDir({
    [`${TS_A}_comment_only.sql`]:
      "-- background: this replaces the old drop table approach\ncreate table public.new_thing (id uuid primary key);\n",
  });
  try {
    assert.deepEqual(scanMigrationsDir(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
