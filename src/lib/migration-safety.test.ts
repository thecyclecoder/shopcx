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

import {
  classifyMigrationSql,
  computeBlastRadius,
  splitSqlStatements,
  isRenameAndExpire,
  isBusinessMaterial,
  routeDestructiveAction,
  BUSINESS_MATERIAL_ROW_THRESHOLD,
  type BlastRadius,
  type PgLike,
} from "./migration-safety";
import { directorLeashCandidates, type DirectorTargetJob } from "./agents/platform-director";
import { routingOwnerForJob } from "./agents/approval-inbox";

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

// ── Phase 3: computeBlastRadius ────────────────────────────────────────────────

/** A pg spy that records every query and returns programmable rowCounts. Also proves
 *  that a real DELETE never persists — the spy tracks a `committed` flag that stays
 *  false because computeBlastRadius always ROLLBACKs. */
class PgSpy implements PgLike {
  calls: string[] = [];
  committed = false;
  txOpen = false;
  rollbackCalled = false;
  constructor(private readonly rowCounts: Record<string, number | null> = {}) {}
  async query(sql: string) {
    this.calls.push(sql);
    const upper = sql.trim().toUpperCase();
    if (upper === "BEGIN") { this.txOpen = true; return { rowCount: null, rows: [] }; }
    if (upper === "COMMIT") { if (this.txOpen) this.committed = true; this.txOpen = false; return { rowCount: null, rows: [] }; }
    if (upper === "ROLLBACK") { this.rollbackCalled = true; this.txOpen = false; return { rowCount: null, rows: [] }; }
    // Programmable per-statement rowcount; default null (like DDL).
    for (const [prefix, count] of Object.entries(this.rowCounts)) {
      if (sql.trim().toUpperCase().startsWith(prefix.toUpperCase())) {
        return { rowCount: count, rows: [] };
      }
    }
    return { rowCount: null, rows: [] };
  }
}

test("computeBlastRadius: DELETE FROM t WHERE … returns real affected-row count and ROLLBACKs (unchanged after)", async () => {
  const pg = new PgSpy({ "DELETE FROM orders": 48201 });
  const r = await computeBlastRadius("DELETE FROM orders WHERE created_at < now() - interval '90 days';", { pg });
  assert.equal(r.measured, true);
  assert.equal(r.severity, "additive"); // WHERE-scoped DELETE is not destructive per Phase-1
  assert.ok(r.affected && r.affected[0].rowCount === 48201);
  assert.match(r.summary, /48,201 rows from orders/);
  // ROLLBACK contract — the tx never committed. This is the "row count unchanged afterward" proof.
  assert.equal(pg.committed, false);
  assert.equal(pg.rollbackCalled, true);
  assert.equal(pg.calls[0].toUpperCase(), "BEGIN");
  assert.equal(pg.calls[pg.calls.length - 1].toUpperCase(), "ROLLBACK");
});

test("computeBlastRadius: an unfiltered DELETE FROM t reports the destructive severity + the measured count", async () => {
  const pg = new PgSpy({ "DELETE FROM orders": 1_234_567 });
  const r = await computeBlastRadius("DELETE FROM orders;", { pg });
  assert.equal(r.measured, true);
  assert.equal(r.severity, "irreversible_destructive");
  assert.match(r.summary, /1,234,567 rows from orders/);
  assert.match(r.summary, /irreversible$/);
  assert.equal(pg.rollbackCalled, true);
});

test("computeBlastRadius: a lock-heavy DDL (ALTER COLUMN TYPE) returns measured:false with the static severity", async () => {
  const pg = new PgSpy();
  const r = await computeBlastRadius("ALTER TABLE big_events ALTER COLUMN payload SET DATA TYPE jsonb;", { pg });
  assert.equal(r.measured, false);
  assert.equal(r.severity, "additive"); // classifier doesn't flag a plain ALTER TYPE (Phase 1 patterns)
  assert.match(r.measurementSkipped ?? "", /lock-heavy/i);
  // Critically: NO BEGIN was issued — we NEVER lock prod to measure.
  assert.equal(pg.calls.length, 0);
});

test("computeBlastRadius: no pg client → measured:false with static Phase-1 severity", async () => {
  const r = await computeBlastRadius("DROP TABLE orders;");
  assert.equal(r.measured, false);
  assert.equal(r.severity, "irreversible_destructive");
  assert.match(r.summary, /measurement skipped: no pg client/);
});

test("computeBlastRadius: skipDryRun bypasses even when pg is provided", async () => {
  const pg = new PgSpy({ "DELETE FROM x": 100 });
  const r = await computeBlastRadius("DELETE FROM x;", { pg, skipDryRun: true });
  assert.equal(r.measured, false);
  assert.equal(r.severity, "irreversible_destructive");
  assert.equal(pg.calls.length, 0);
});

test("computeBlastRadius: ROLLBACK still runs when a statement mid-migration throws", async () => {
  class FailingPg implements PgLike {
    calls: string[] = [];
    rollbackCalled = false;
    async query(sql: string) {
      this.calls.push(sql);
      if (sql.trim().toUpperCase() === "BEGIN") return { rowCount: null, rows: [] };
      if (sql.trim().toUpperCase() === "ROLLBACK") { this.rollbackCalled = true; return { rowCount: null, rows: [] }; }
      throw new Error("simulated pg failure");
    }
  }
  const pg = new FailingPg();
  const r = await computeBlastRadius("DELETE FROM x WHERE id = 1;", { pg });
  assert.equal(r.measured, true);
  assert.ok(r.affected && r.affected[0].error);
  assert.equal(pg.rollbackCalled, true);
});

test("computeBlastRadius: additive migration reports 'no destructive rows affected'", async () => {
  const pg = new PgSpy();
  const r = await computeBlastRadius("ALTER TABLE x ADD COLUMN y int;", { pg });
  assert.equal(r.measured, true);
  assert.equal(r.severity, "additive");
  assert.match(r.summary, /no destructive rows affected/);
});

// ── splitSqlStatements ────────────────────────────────────────────────────────

test("splitSqlStatements: respects dollar-quoted bodies (`;` inside $$…$$ is not a separator)", () => {
  const sql = "DO $$ BEGIN INSERT INTO t VALUES(1); END $$;\nALTER TABLE t ADD COLUMN y int;";
  const parts = splitSqlStatements(sql);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /DO \$\$/);
  assert.match(parts[1], /ADD COLUMN/);
});

test("splitSqlStatements: respects single-quoted strings", () => {
  const sql = "INSERT INTO t (name) VALUES ('a;b;c'); UPDATE t SET x=1;";
  const parts = splitSqlStatements(sql);
  assert.equal(parts.length, 2);
});

// ── Phase 4: routing helpers ──────────────────────────────────────────────────

const additiveBR: BlastRadius = { measured: true, severity: "additive", matches: [], summary: "additive" };
const revBR = (opts: Partial<BlastRadius> = {}): BlastRadius => ({
  measured: true,
  severity: "reversible_destructive",
  matches: ["ALTER … DROP CONSTRAINT"],
  summary: "reversible destructive",
  affected: [{ statement: "alter table things drop constraint things_fk", rowCount: null }],
  ...opts,
});
const irrevBR = (opts: Partial<BlastRadius> = {}): BlastRadius => ({
  measured: true,
  severity: "irreversible_destructive",
  matches: ["DROP TABLE"],
  summary: "irreversible destructive",
  affected: [{ statement: "drop table things", rowCount: null }],
  ...opts,
});

test("isRenameAndExpire: matches ALTER TABLE ... RENAME TO _deprecated_x_YYYYMMDD", () => {
  assert.equal(isRenameAndExpire("ALTER TABLE public.x RENAME TO _deprecated_x_20260703;"), true);
  assert.equal(isRenameAndExpire("alter table foo rename to _deprecated_foo_20270101;"), true);
});

test("isRenameAndExpire: matches ALTER TABLE ... RENAME COLUMN ... TO _deprecated_y_YYYYMMDD", () => {
  assert.equal(isRenameAndExpire("ALTER TABLE x RENAME COLUMN y TO _deprecated_y_20260703;"), true);
});

test("isRenameAndExpire: rejects a plain DROP TABLE / rename that isn't the deprecation form", () => {
  assert.equal(isRenameAndExpire("DROP TABLE x;"), false);
  assert.equal(isRenameAndExpire("ALTER TABLE x RENAME TO x_new;"), false);
});

test("isBusinessMaterial: flag when a destructive statement touches customers/orders", () => {
  assert.equal(isBusinessMaterial(irrevBR({ affected: [{ statement: "drop table customers", rowCount: null }] })), true);
  assert.equal(isBusinessMaterial(irrevBR({ affected: [{ statement: "delete from orders", rowCount: 5 }] })), true);
});

test("isBusinessMaterial: flag when any affected row count exceeds the mass threshold", () => {
  assert.equal(
    isBusinessMaterial(revBR({ affected: [{ statement: "update products set flag=1", rowCount: BUSINESS_MATERIAL_ROW_THRESHOLD + 1 }] })),
    true,
  );
});

test("isBusinessMaterial: NOT material for a small internal-table change", () => {
  assert.equal(
    isBusinessMaterial(revBR({ affected: [{ statement: "alter table director_directives drop constraint dd_ck", rowCount: null }] })),
    false,
  );
});

test("isBusinessMaterial: measured:false + material table name is still flagged (conservative fallback)", () => {
  const br: BlastRadius = { measured: false, severity: "irreversible_destructive", matches: ["DROP TABLE"], summary: "DROP TABLE customers — irreversible; measurement skipped: pooler unreachable" };
  assert.equal(isBusinessMaterial(br), true);
});

test("routeDestructiveAction: additive → platform (in-leash)", () => {
  const r = routeDestructiveAction("CREATE TABLE foo(id uuid);", additiveBR);
  assert.equal(r.routedToFunction, "platform");
});

test("routeDestructiveAction: reversible_destructive + rename-and-expire → platform (Ada owns final call)", () => {
  const sql = "ALTER TABLE public.customers RENAME TO _deprecated_customers_20260703;";
  const br = revBR({ affected: [{ statement: sql, rowCount: null }] });
  const r = routeDestructiveAction(sql, br);
  assert.equal(r.routedToFunction, "platform");
  assert.equal(r.renameAndExpire, true);
  assert.match(r.reason, /rename-and-expire/);
});

test("routeDestructiveAction: reversible_destructive + NOT material → platform (Ada owns final call)", () => {
  const sql = "ALTER TABLE things DROP CONSTRAINT things_fk;";
  const r = routeDestructiveAction(sql, revBR());
  assert.equal(r.routedToFunction, "platform");
  assert.equal(r.businessMaterial, false);
});

test("routeDestructiveAction: reversible_destructive + material + NOT rename-form → CEO", () => {
  const br = revBR({ affected: [{ statement: "update customers set flag=1", rowCount: 250_000 }] });
  const r = routeDestructiveAction("update customers set flag=1;", br);
  assert.equal(r.routedToFunction, "ceo");
  assert.equal(r.businessMaterial, true);
});

test("routeDestructiveAction: irreversible_destructive + business-material → CEO circuit-break", () => {
  const sql = "DROP TABLE customers;";
  const br = irrevBR({ affected: [{ statement: sql, rowCount: null }] });
  const r = routeDestructiveAction(sql, br);
  assert.equal(r.routedToFunction, "ceo");
  assert.match(r.reason, /circuit-break/);
});

test("routeDestructiveAction: irreversible_destructive + NOT business-material → CEO fail-safe (unfamiliar shape)", () => {
  const sql = "DROP TABLE _scratch_debug;";
  const br = irrevBR({ affected: [{ statement: sql, rowCount: null }] });
  const r = routeDestructiveAction(sql, br);
  assert.equal(r.routedToFunction, "ceo");
});

// ── Phase 4: routing wiring via routed_to_function_override ────────────────────

test("routingOwnerForJob: honors routed_to_function_override='platform' on a ceo-authorized-out-of-leash job", () => {
  const job = {
    kind: "ceo-authorized-out-of-leash",
    pending_actions: [
      { id: "a1", type: "apply_migration", status: "pending", routed_to_function_override: "platform" },
    ],
  };
  assert.equal(routingOwnerForJob(job), "platform");
});

test("routingOwnerForJob: honors routed_to_function_override='ceo' explicitly", () => {
  const job = {
    kind: "ceo-authorized-out-of-leash",
    pending_actions: [
      { id: "a1", type: "apply_migration", status: "pending", routed_to_function_override: "ceo" },
    ],
  };
  assert.equal(routingOwnerForJob(job), "ceo");
});

test("routingOwnerForJob: falls through to KIND_TO_FUNCTION when no valid override is present", () => {
  const job = {
    kind: "ceo-authorized-out-of-leash",
    pending_actions: [
      { id: "a1", type: "apply_migration", status: "pending", routed_to_function_override: "bogus" },
    ],
  };
  // ceo-authorized-out-of-leash is UNMAPPED in KIND_TO_FUNCTION → null → CEO fail-safe.
  assert.equal(routingOwnerForJob(job), null);
});
