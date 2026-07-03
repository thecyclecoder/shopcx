/**
 * Unit tests for the Phase-1 deterministic destructive-SQL classifier
 * (docs/brain/specs/destructive-migration-safety-rails.md Phase 1). Pins the pure
 * `classifyMigrationSql` against fixture SQL — the leash rail's authoritative gate.
 *
 * Also covers the wired-in behavior on `categoryFor` via the leash-gate contract:
 * an `apply_migration` action whose cmd/preview contains `DROP TABLE` must fall
 * OUT of the leash (returned as verdict:'none' / no `additive_migration` category)
 * even though the action TYPE is auto-approvable.
 *
 * Built-in node:test — run:
 *   npm run test:migration-safety
 *   (= tsx --test src/lib/migration-safety.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { classifyMigrationSql } from "./migration-safety";
import { directorLeashCandidates, type DirectorTargetJob } from "./agents/platform-director";

// ── classifyMigrationSql ───────────────────────────────────────────────────────

test("classifyMigrationSql flags DROP TABLE as irreversible_destructive", () => {
  const r = classifyMigrationSql("DROP TABLE customers;");
  assert.equal(r.severity, "irreversible_destructive");
  assert.ok(r.matches.includes("DROP TABLE"));
});

test("classifyMigrationSql flags TRUNCATE as irreversible_destructive", () => {
  const r = classifyMigrationSql("TRUNCATE orders;");
  assert.equal(r.severity, "irreversible_destructive");
  assert.ok(r.matches.includes("TRUNCATE"));
});

test("classifyMigrationSql flags DELETE FROM x (no WHERE) as irreversible_destructive", () => {
  const r = classifyMigrationSql("DELETE FROM orders;");
  assert.equal(r.severity, "irreversible_destructive");
  assert.ok(r.matches.includes("DELETE without WHERE"));
});

test("classifyMigrationSql flags a statement adding ON DELETE CASCADE as destructive (reversible)", () => {
  const r = classifyMigrationSql("ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES p(id) ON DELETE CASCADE;");
  assert.notEqual(r.severity, "additive");
  assert.ok(r.matches.includes("ON DELETE CASCADE"));
});

test("classifyMigrationSql returns additive for ALTER TABLE ... ADD COLUMN", () => {
  const r = classifyMigrationSql("ALTER TABLE x ADD COLUMN y int;");
  assert.equal(r.severity, "additive");
  assert.deepEqual(r.matches, []);
});

test("classifyMigrationSql returns additive for CREATE TABLE", () => {
  const r = classifyMigrationSql("CREATE TABLE foo (id uuid primary key, name text not null);");
  assert.equal(r.severity, "additive");
  assert.deepEqual(r.matches, []);
});

test("classifyMigrationSql returns additive for CREATE INDEX", () => {
  const r = classifyMigrationSql("CREATE INDEX idx_foo_name ON foo (name);");
  assert.equal(r.severity, "additive");
  assert.deepEqual(r.matches, []);
});

test("classifyMigrationSql: unfiltered DELETE is destructive but a WHERE-scoped DELETE is not", () => {
  assert.equal(classifyMigrationSql("DELETE FROM x;").severity, "irreversible_destructive");
  assert.equal(classifyMigrationSql("DELETE FROM x WHERE id = $1;").severity, "additive");
});

test("classifyMigrationSql: unfiltered UPDATE is destructive but a WHERE-scoped UPDATE is not", () => {
  assert.equal(classifyMigrationSql("UPDATE x SET a = 1;").severity, "irreversible_destructive");
  assert.equal(classifyMigrationSql("UPDATE x SET a = 1 WHERE id = $1;").severity, "additive");
});

test("classifyMigrationSql is case-insensitive", () => {
  assert.equal(classifyMigrationSql("drop table x;").severity, "irreversible_destructive");
  assert.equal(classifyMigrationSql("Drop Table X;").severity, "irreversible_destructive");
});

test("classifyMigrationSql strips line comments before matching", () => {
  const sql = "-- DROP TABLE fake_out\nALTER TABLE x ADD COLUMN y int;";
  assert.equal(classifyMigrationSql(sql).severity, "additive");
});

test("classifyMigrationSql strips block comments before matching", () => {
  const sql = "/* DROP TABLE fake_out */\nALTER TABLE x ADD COLUMN y int;";
  assert.equal(classifyMigrationSql(sql).severity, "additive");
});

test("classifyMigrationSql catches destruction hidden inside DO $$ ... $$ blocks", () => {
  const sql = "DO $$ BEGIN DROP TABLE tenants; END $$;";
  const r = classifyMigrationSql(sql);
  assert.equal(r.severity, "irreversible_destructive");
  assert.ok(r.matches.includes("DROP TABLE"));
});

test("classifyMigrationSql catches destruction hidden inside CREATE OR REPLACE FUNCTION bodies", () => {
  const sql = "CREATE OR REPLACE FUNCTION nuke() RETURNS void AS $$ BEGIN DELETE FROM orders; END; $$ LANGUAGE plpgsql;";
  const r = classifyMigrationSql(sql);
  assert.equal(r.severity, "irreversible_destructive");
  assert.ok(r.matches.includes("DELETE without WHERE"));
});

test("classifyMigrationSql flags DROP COLUMN as destructive", () => {
  const r = classifyMigrationSql("ALTER TABLE customers DROP COLUMN legacy_ref;");
  assert.equal(r.severity, "irreversible_destructive");
  assert.ok(r.matches.includes("DROP COLUMN"));
});

test("classifyMigrationSql flags ALTER … DROP CONSTRAINT / DROP DEFAULT as reversible_destructive", () => {
  const c = classifyMigrationSql("ALTER TABLE t DROP CONSTRAINT t_fk;");
  assert.equal(c.severity, "reversible_destructive");
  const d = classifyMigrationSql("ALTER TABLE t ALTER COLUMN a DROP DEFAULT;");
  assert.equal(d.severity, "reversible_destructive");
});

test("classifyMigrationSql: INSERT ... ON CONFLICT DO UPDATE SET (no WHERE) is NOT flagged (row-scoped by ON CONFLICT)", () => {
  const sql = "INSERT INTO t (id, a) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET a = excluded.a;";
  assert.equal(classifyMigrationSql(sql).severity, "additive");
});

test("classifyMigrationSql: empty / non-string input is treated as additive (defensive)", () => {
  assert.equal(classifyMigrationSql("").severity, "additive");
  assert.equal(classifyMigrationSql(undefined as unknown as string).severity, "additive");
});

test("classifyMigrationSql: mixed additive + destructive escalates to the most severe rail", () => {
  const sql = "ALTER TABLE x ADD COLUMN y int;\nDROP TABLE legacy;";
  const r = classifyMigrationSql(sql);
  assert.equal(r.severity, "irreversible_destructive");
});

// ── categoryFor wiring via directorLeashCandidates ──────────────────────────────

const jobWith = (action: { type: string; id?: string; cmd?: string; preview?: string }): DirectorTargetJob => ({
  id: "target-1",
  workspace_id: "ws-1",
  kind: "spec",
  spec_slug: "example",
  pending_actions: [{ id: "a1", status: "pending", ...action }],
});

test("categoryFor: apply_migration whose cmd contains DROP TABLE falls out of the leash (verdict:'none')", () => {
  const v = directorLeashCandidates(jobWith({ type: "apply_migration", cmd: "DROP TABLE customers;" }));
  assert.equal(v.verdict, "none");
  assert.deepEqual(v.actions, []);
});

test("categoryFor: apply_migration whose cmd only ADD COLUMNs is in-leash as additive_migration", () => {
  const v = directorLeashCandidates(jobWith({ type: "apply_migration", cmd: "ALTER TABLE x ADD COLUMN y int;" }));
  assert.equal(v.verdict, "single");
  assert.equal(v.actions[0]?.category, "additive_migration");
});

test("categoryFor: apply_migration destruction inside preview (not cmd) still binds the leash", () => {
  const v = directorLeashCandidates(
    jobWith({ type: "apply_migration", cmd: "npx tsx scripts/apply-x.ts", preview: "TRUNCATE orders;" }),
  );
  assert.equal(v.verdict, "none");
});

test("categoryFor: run_prod_script bundled with a destructive apply_migration escalates the whole bundle", () => {
  const job: DirectorTargetJob = {
    id: "target-2",
    workspace_id: "ws-1",
    kind: "spec",
    spec_slug: "example",
    pending_actions: [
      { id: "a1", status: "pending", type: "apply_migration", cmd: "DROP TABLE t;" },
      { id: "a2", status: "pending", type: "run_prod_script", cmd: "npx tsx scripts/backfill-foo.ts" },
    ],
  };
  const v = directorLeashCandidates(job);
  assert.equal(v.verdict, "none");
});
