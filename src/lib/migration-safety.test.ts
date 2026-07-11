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
  runSkepticPass,
  defaultLenientSkeptic,
  deterministicDataLossSkeptic,
  isTransactionControlStatement,
  writeDestructiveActionDecisionGrade,
  BUSINESS_MATERIAL_ROW_THRESHOLD,
  type BlastRadius,
  type PgLike,
  type SkepticFn,
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
// (Every honored override REQUIRES a validated blastRadius.severity === 'reversible_destructive'
//  after secure-destructive-migration-preapproval-boundary — see the § below.)

test("routingOwnerForJob: honors routed_to_function_override='platform' on a validated reversible_destructive apply_migration", () => {
  const job = {
    kind: "ceo-authorized-out-of-leash",
    pending_actions: [
      {
        id: "a1",
        type: "apply_migration",
        status: "pending",
        routed_to_function_override: "platform",
        blastRadius: { measured: false, severity: "reversible_destructive", matches: ["ALTER … DROP CONSTRAINT"], summary: "reversible" },
      },
    ],
  };
  assert.equal(routingOwnerForJob(job), "platform");
});

test("routingOwnerForJob: honors routed_to_function_override='ceo' explicitly on a validated reversible_destructive apply_migration", () => {
  const job = {
    kind: "ceo-authorized-out-of-leash",
    pending_actions: [
      {
        id: "a1",
        type: "apply_migration",
        status: "pending",
        routed_to_function_override: "ceo",
        blastRadius: { measured: false, severity: "reversible_destructive", matches: ["ALTER … DROP CONSTRAINT"], summary: "reversible" },
      },
    ],
  };
  assert.equal(routingOwnerForJob(job), "ceo");
});

test("routingOwnerForJob: falls through to the canonical node registry / KIND_TO_FUNCTION_SHIM when no valid override is present", () => {
  const job = {
    kind: "ceo-authorized-out-of-leash",
    pending_actions: [
      {
        id: "a1",
        type: "apply_migration",
        status: "pending",
        routed_to_function_override: "bogus",
        blastRadius: { measured: false, severity: "reversible_destructive", matches: [], summary: "" },
      },
    ],
  };
  // control-tower-canonical-node-registry P2 — `ceo-authorized-out-of-leash` is now a first-class
  // Node in the canonical registry with owner=`ceo` (Eve's / the founder's own lane), so
  // ownerFunctionForKind returns "ceo" explicitly. resolveApprover("ceo", …) returns CEO the same
  // way the historical null fail-safe did — the routing terminus is unchanged, only the
  // intermediate value is now explicit. The load-bearing invariant this test pins is that a
  // rejected override doesn't sway routing to Platform; asserting the terminal CEO seat is the
  // canonical check.
  assert.equal(routingOwnerForJob(job), "ceo");
});

// ── secure-destructive-migration-preapproval-boundary ─────────────────────────
// The four vulnerabilities the safety-rails PR introduced, closed:
//   (1) shared-production pg execution from the approval-raising path,
//   (2) additive / non-SQL run_prod_script routing to the Platform lane,
//   (3) routed_to_function_override honored on unrelated job kinds / action shapes,
//   (4) authorized_by stamped CEO unconditionally.
// Test (1) is a HARNESS proving no pg.query on the shared production client — the raise-path
// wrapper never opens or touches a pg client; here we prove the pure `computeBlastRadius` never
// dispatches a candidate statement when no `pg` was passed (which the raise path now enforces).

test("(sec)(1) SELECT / function-call SQL never reaches pg.query on the shared production client from the raise path", async () => {
  // The raise path is `computeBlastRadius(sql)` — invoked with NO opts.pg. Prove no dispatch:
  const attempts = [
    "SELECT current_user; -- side-channel probe",
    "SELECT pg_read_server_files('/etc/passwd');",
    "SELECT set_config('search_path', 'evil', false);",
    "DO $$ BEGIN PERFORM pg_notify('c', 'x'); END $$;",
    "SELECT auth.uid();",
  ];
  for (const sql of attempts) {
    const r = await computeBlastRadius(sql);
    assert.equal(r.measured, false, `must not measure without a pg client: ${sql}`);
    assert.match(r.measurementSkipped ?? "", /no pg client/, `must report the skip reason: ${sql}`);
    assert.equal(r.affected, undefined, `must not carry per-statement rowcounts (no dispatch): ${sql}`);
  }
});

test("(sec)(1) a hostile pg WOULD have been dispatched to if a pg were supplied — proves the raise path's decision to omit pg is load-bearing", async () => {
  // Belt-and-suspenders: the pure primitive still CAN dispatch when a pg is injected (tests use
  // spies). The raise path's fix is the caller-side decision to NOT pass one. This test proves
  // the pure primitive's contract: given a pg, it would have called .query — which is exactly why
  // the caller must not supply the shared production client.
  const seen: string[] = [];
  const spy: PgLike = { async query(sql) { seen.push(sql); return { rowCount: null, rows: [] }; } };
  await computeBlastRadius("SELECT 1;", { pg: spy });
  assert.ok(seen.length > 0, "the primitive does dispatch — hence the caller must never wire the shared prod client");
});

test("(sec)(2) a non-SQL run_prod_script cannot install a Platform override — routeOutOfLeashAction returns CEO", async () => {
  const { routeOutOfLeashAction } = await import("./migration-safety");
  const br: BlastRadius = { measured: false, severity: "additive", matches: [], summary: "" };
  const r = routeOutOfLeashAction("run_prod_script", "curl https://example.com", br);
  assert.equal(r.routedToFunction, "ceo");
  assert.match(r.reason, /not SQL/i);
});

test("(sec)(2) an additive apply_migration routes to CEO (Ada does not silently self-approve out-of-leash asks)", async () => {
  const { routeOutOfLeashAction } = await import("./migration-safety");
  const br: BlastRadius = { measured: false, severity: "additive", matches: [], summary: "" };
  const r = routeOutOfLeashAction("apply_migration", "ALTER TABLE x ADD COLUMN y int;", br);
  assert.equal(r.routedToFunction, "ceo");
  assert.match(r.reason, /not eligible for the Platform lane/i);
});

test("(sec)(2) a run_prod_script whose classifier-derived severity is reversible_destructive still routes to CEO (actionType gate is authoritative)", async () => {
  const { routeOutOfLeashAction } = await import("./migration-safety");
  // Even if the injected classifier claimed reversible, a run_prod_script is not blast-radius-
  // validatable because it's shell, not SQL — the actionType gate closes the authority bypass.
  const br: BlastRadius = { measured: false, severity: "reversible_destructive", matches: ["ALTER … DROP CONSTRAINT"], summary: "" };
  const r = routeOutOfLeashAction("run_prod_script", "psql -c 'alter table t drop constraint fk;'", br);
  assert.equal(r.routedToFunction, "ceo");
});

test("(sec)(3) a validated reversible_destructive apply_migration may route to Platform via routeOutOfLeashAction", async () => {
  const { routeOutOfLeashAction } = await import("./migration-safety");
  const sql = "ALTER TABLE public.customers RENAME TO _deprecated_customers_20260703;";
  const br: BlastRadius = { measured: false, severity: "reversible_destructive", matches: ["ALTER … DROP CONSTRAINT"], summary: "" };
  const r = routeOutOfLeashAction("apply_migration", sql, br);
  assert.equal(r.routedToFunction, "platform");
  assert.equal(r.renameAndExpire, true);
});

test("(sec)(3) an irreversible apply_migration routes to CEO", async () => {
  const { routeOutOfLeashAction } = await import("./migration-safety");
  const br: BlastRadius = { measured: false, severity: "irreversible_destructive", matches: ["DROP TABLE"], summary: "DROP TABLE customers" };
  const r = routeOutOfLeashAction("apply_migration", "DROP TABLE customers;", br);
  assert.equal(r.routedToFunction, "ceo");
});

test("(sec)(3) a malformed / empty actionType routes to CEO", async () => {
  const { routeOutOfLeashAction } = await import("./migration-safety");
  const br: BlastRadius = { measured: false, severity: "reversible_destructive", matches: [], summary: "" };
  const r = routeOutOfLeashAction("", "anything;", br);
  assert.equal(r.routedToFunction, "ceo");
  assert.match(r.reason, /is not SQL/i);
});

test("(sec)(4) routingOwnerForJob IGNORES routed_to_function_override on every unrelated job kind", () => {
  // Any non-`ceo-authorized-out-of-leash` job with a hand-installed platform override is ignored.
  for (const kind of ["build", "spec-test", "migration-fix", "repair", "plan"]) {
    const job = {
      kind,
      pending_actions: [
        {
          id: "x",
          type: "apply_migration",
          status: "pending",
          routed_to_function_override: "platform",
          blastRadius: { measured: false, severity: "reversible_destructive", matches: [], summary: "" },
        },
      ],
    };
    // The override MUST NOT be honored. `platform` might coincidentally match the canonical node
    // registry's owner for some kinds (e.g. build → agent:build → platform), so assert that the
    // returned value is NOT influenced by the hand-installed override on kinds where the map default differs.
    const withoutOverride = routingOwnerForJob({ kind, pending_actions: [{ id: "x", type: "apply_migration", status: "pending" }] });
    assert.equal(routingOwnerForJob(job), withoutOverride, `override must not sway routing on kind=${kind}`);
  }
});

test("(sec)(4) routingOwnerForJob IGNORES a routed_to_function_override on a run_prod_script pending action", () => {
  const job = {
    kind: "ceo-authorized-out-of-leash",
    pending_actions: [
      {
        id: "a1",
        type: "run_prod_script",
        status: "pending",
        routed_to_function_override: "platform",
        blastRadius: { measured: false, severity: "reversible_destructive", matches: [], summary: "" },
      },
    ],
  };
  // The action type gate rejects the override — falls through to the canonical registry's
  // owner for the raiser (`ceo-authorized-out-of-leash` → owner=`ceo`, control-tower-canonical-
  // node-registry P2). Both null and "ceo" route to the CEO seat via resolveApprover.
  assert.equal(routingOwnerForJob(job), "ceo");
});

test("(sec)(4) routingOwnerForJob IGNORES a routed_to_function_override when action.blastRadius.severity is additive", () => {
  const job = {
    kind: "ceo-authorized-out-of-leash",
    pending_actions: [
      {
        id: "a1",
        type: "apply_migration",
        status: "pending",
        routed_to_function_override: "platform",
        blastRadius: { measured: false, severity: "additive", matches: [], summary: "" },
      },
    ],
  };
  assert.equal(routingOwnerForJob(job), "ceo");
});

test("(sec)(4) routingOwnerForJob IGNORES a routed_to_function_override when action.blastRadius.severity is irreversible_destructive", () => {
  const job = {
    kind: "ceo-authorized-out-of-leash",
    pending_actions: [
      {
        id: "a1",
        type: "apply_migration",
        status: "pending",
        routed_to_function_override: "platform",
        blastRadius: { measured: false, severity: "irreversible_destructive", matches: ["DROP TABLE"], summary: "" },
      },
    ],
  };
  assert.equal(routingOwnerForJob(job), "ceo");
});

test("(sec)(4) routingOwnerForJob IGNORES a routed_to_function_override when blastRadius is missing entirely (malformed input)", () => {
  const job = {
    kind: "ceo-authorized-out-of-leash",
    pending_actions: [
      { id: "a1", type: "apply_migration", status: "pending", routed_to_function_override: "platform" },
    ],
  };
  assert.equal(routingOwnerForJob(job), "ceo");
});

// ── Phase 5: adversarial skeptic pass ─────────────────────────────────────────

const additiveBRForSkeptic: BlastRadius = { measured: true, severity: "additive", matches: [], summary: "additive" };
const irrevBRForSkeptic = (opts: Partial<BlastRadius> = {}): BlastRadius => ({
  measured: true,
  severity: "irreversible_destructive",
  matches: ["DROP TABLE"],
  summary: "DROP TABLE customers — irreversible",
  affected: [{ statement: "drop table customers", rowCount: null }],
  ...opts,
});
const revBRForSkeptic = (opts: Partial<BlastRadius> = {}): BlastRadius => ({
  measured: true,
  severity: "reversible_destructive",
  matches: ["ALTER … DROP CONSTRAINT"],
  summary: "reversible destructive",
  affected: [{ statement: "alter table t drop constraint t_fk", rowCount: null }],
  ...opts,
});

test("runSkepticPass: additive migration → skipped:true, no verdict, blastRadius unchanged", async () => {
  const r = await runSkepticPass("CREATE TABLE foo (id uuid);", additiveBRForSkeptic);
  assert.equal(r.skipped, true);
  assert.equal(r.verdict, undefined);
  assert.strictEqual(r.finalBlastRadius, additiveBRForSkeptic);
});

test("runSkepticPass: destructive migration returns a data-loss finding when the skeptic confirms it", async () => {
  const skeptic: SkepticFn = () => ({ dataLossing: true, confidence: 0.95, reason: "DROP TABLE on a customer-facing ledger" });
  const r = await runSkepticPass("DROP TABLE customers;", irrevBRForSkeptic(), { skeptic });
  assert.equal(r.skipped, false);
  assert.equal(r.verdict?.dataLossing, true);
  assert.match(r.finalBlastRadius.summary, /data loss confirmed/);
  assert.equal(r.finalBlastRadius.severity, "irreversible_destructive");
});

test("runSkepticPass: skeptic CANNOT downgrade a mechanically-flagged destructive to additive (severity contract)", async () => {
  // The skeptic is LENIENT — it says no data loss found. The Phase-1 classifier already flagged
  // irreversible_destructive. The severity MUST stay irreversible_destructive.
  const lenient: SkepticFn = () => ({ dataLossing: false, confidence: 0.9, reason: "looks fine to me" });
  const r = await runSkepticPass("DROP TABLE customers;", irrevBRForSkeptic(), { skeptic: lenient });
  assert.equal(r.finalBlastRadius.severity, "irreversible_destructive");
  assert.match(r.finalBlastRadius.summary, /deterministic severity remains authoritative/);
});

test("runSkepticPass: high-confidence data-loss ESCALATES a reversible_destructive to irreversible_destructive", async () => {
  const escalating: SkepticFn = () => ({ dataLossing: true, confidence: 0.85, reason: "constraint drop cascades to unrecoverable rows" });
  const r = await runSkepticPass("ALTER TABLE t DROP CONSTRAINT t_fk;", revBRForSkeptic(), { skeptic: escalating });
  assert.equal(r.finalBlastRadius.severity, "irreversible_destructive");
});

test("runSkepticPass: low-confidence data-loss does NOT escalate a reversible_destructive", async () => {
  const softEscalating: SkepticFn = () => ({ dataLossing: true, confidence: 0.5, reason: "maybe" });
  const r = await runSkepticPass("ALTER TABLE t DROP CONSTRAINT t_fk;", revBRForSkeptic(), { skeptic: softEscalating });
  assert.equal(r.finalBlastRadius.severity, "reversible_destructive");
});

test("runSkepticPass: additional matches from the skeptic are unioned into blastRadius.matches", async () => {
  const skeptic: SkepticFn = () => ({ dataLossing: true, confidence: 0.8, reason: "hidden trigger destruction", additionalMatches: ["TRIGGER DROP"] });
  const r = await runSkepticPass("DROP TABLE customers;", irrevBRForSkeptic(), { skeptic });
  assert.ok(r.finalBlastRadius.matches.includes("DROP TABLE"));
  assert.ok(r.finalBlastRadius.matches.includes("TRIGGER DROP"));
});

test("runSkepticPass: verdict is ATTACHED to the finalBlastRadius even when lenient (for the CEO card)", async () => {
  const lenient: SkepticFn = () => ({ dataLossing: false, confidence: 0.4, reason: "cannot reproduce" });
  const r = await runSkepticPass("DROP TABLE customers;", irrevBRForSkeptic(), { skeptic: lenient });
  assert.equal(r.verdict?.reason, "cannot reproduce");
  assert.match(r.finalBlastRadius.summary, /skeptic: no additional data loss/);
});

test("runSkepticPass: an async (Promise-returning) skeptic works", async () => {
  const asyncSkeptic: SkepticFn = async () => Promise.resolve({ dataLossing: true, confidence: 0.9, reason: "async proof" });
  const r = await runSkepticPass("DROP TABLE customers;", irrevBRForSkeptic(), { skeptic: asyncSkeptic });
  assert.equal(r.verdict?.reason, "async proof");
});

test("runSkepticPass: default lenient skeptic echoes deterministic verdict (severity preserved either way)", async () => {
  const rIrrev = await runSkepticPass("DROP TABLE x;", irrevBRForSkeptic(), { skeptic: defaultLenientSkeptic });
  assert.equal(rIrrev.finalBlastRadius.severity, "irreversible_destructive");
  assert.equal(rIrrev.verdict?.dataLossing, true);

  const rAdd = await runSkepticPass("ALTER TABLE x ADD COLUMN y int;", additiveBRForSkeptic);
  assert.equal(rAdd.skipped, true); // additive → skipped entirely
});

// ── Fix 1: transaction-control statements never escape the dry-run wrapper ─────

test("isTransactionControlStatement flags BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE/END/START TRANSACTION", () => {
  for (const s of ["BEGIN;", "commit", " ROLLBACK ", "SAVEPOINT sp1", "RELEASE SAVEPOINT sp1", "END;", "START TRANSACTION;"]) {
    assert.equal(isTransactionControlStatement(s), true, `should flag: ${s}`);
  }
  for (const s of ["DELETE FROM x WHERE id=1;", "ALTER TABLE x ADD COLUMN y int;", "SELECT 1;"]) {
    assert.equal(isTransactionControlStatement(s), false, `should NOT flag: ${s}`);
  }
});

test("computeBlastRadius: rollback contract HOLDS even when input SQL contains COMMIT (Fix 1)", async () => {
  // Fault-injection harness from the failing pre-merge check evidence:
  //   `DELETE FROM orders WHERE id IS NOT NULL; COMMIT;`
  // Before the fix: our per-statement loop executed COMMIT from the input, committing the
  // transaction; the trailing ROLLBACK found nothing to roll back. After the fix: COMMIT is
  // stripped as a transaction-control statement, so BEGIN + DELETE run, then our finally
  // block's ROLLBACK unwinds cleanly.
  class HarnessPg implements PgLike {
    calls: string[] = [];
    committed = false;
    rollbackCalled = false;
    async query(sql: string) {
      this.calls.push(sql);
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith("BEGIN")) return { rowCount: null, rows: [] };
      if (upper.startsWith("COMMIT")) { this.committed = true; return { rowCount: null, rows: [] }; }
      if (upper.startsWith("ROLLBACK")) { this.rollbackCalled = true; return { rowCount: null, rows: [] }; }
      if (upper.startsWith("DELETE FROM ORDERS")) return { rowCount: 10, rows: [] };
      return { rowCount: null, rows: [] };
    }
  }
  const pg = new HarnessPg();
  const r = await computeBlastRadius("DELETE FROM orders WHERE id IS NOT NULL; COMMIT;", { pg });
  assert.equal(r.measured, true);
  // The DELETE's row count is measured …
  const del = r.affected?.find((a) => a.statement.toUpperCase().startsWith("DELETE"));
  assert.equal(del?.rowCount, 10);
  // … and the ROLLBACK contract HOLDS: pg observed ROLLBACK (not COMMIT) at the end.
  assert.equal(pg.committed, false, "input COMMIT must be stripped — the tx never commits");
  assert.equal(pg.rollbackCalled, true, "ROLLBACK still fires from the finally block");
  // The COMMIT statement is recorded as skipped-with-reason on the affected list.
  const commit = r.affected?.find((a) => a.statement.toUpperCase().startsWith("COMMIT"));
  assert.match(commit?.error ?? "", /transaction-control statement skipped/);
});

// ── Fix 1: deterministic data-loss skeptic actually runs ──────────────────────

test("deterministicDataLossSkeptic: agrees with the classifier on a mechanically-flagged destructive", async () => {
  const v = await deterministicDataLossSkeptic({ sql: "DROP TABLE customers;", blastRadius: irrevBRForSkeptic() });
  assert.equal(v.dataLossing, true);
  assert.ok(v.confidence >= 0.7);
  assert.match(v.reason, /classifier flagged irreversible_destructive/);
});

test("deterministicDataLossSkeptic: SURFACES a CTE-write without WHERE (a Phase-1 blind spot)", async () => {
  const sql = "WITH bad AS (DELETE FROM widgets RETURNING id) SELECT count(*) FROM bad;";
  const v = await deterministicDataLossSkeptic({ sql, blastRadius: additiveBRForSkeptic });
  assert.equal(v.dataLossing, true);
  assert.ok(v.additionalMatches?.includes("CTE write without WHERE"));
});

test("deterministicDataLossSkeptic: SURFACES a constraint drop on a business-material table", async () => {
  const sql = "ALTER TABLE customers DROP CONSTRAINT customers_email_uk;";
  const v = await deterministicDataLossSkeptic({ sql, blastRadius: revBRForSkeptic() });
  assert.ok(v.additionalMatches?.some((m) => /constraint drop on business-material/i.test(m)));
});

test("deterministicDataLossSkeptic: additive migration returns dataLossing:false with no extras", async () => {
  const v = await deterministicDataLossSkeptic({ sql: "ALTER TABLE x ADD COLUMN y int;", blastRadius: additiveBRForSkeptic });
  assert.equal(v.dataLossing, false);
  assert.equal(v.additionalMatches, undefined);
});

test("runSkepticPass wired with the deterministic skeptic: destructive migration returns a data-loss finding", async () => {
  const r = await runSkepticPass("DROP TABLE customers;", irrevBRForSkeptic(), { skeptic: deterministicDataLossSkeptic });
  assert.equal(r.skipped, false);
  assert.equal(r.verdict?.dataLossing, true);
  assert.match(r.finalBlastRadius.summary, /data loss confirmed/);
});

test("runSkepticPass wired with the deterministic skeptic: additive migration passes without a skeptic escalation", async () => {
  const r = await runSkepticPass("ALTER TABLE x ADD COLUMN y int;", additiveBRForSkeptic, { skeptic: deterministicDataLossSkeptic });
  assert.equal(r.skipped, true); // additive → nothing to refute → skipped entirely
  assert.equal(r.verdict, undefined);
});

// ── Fix 1: director_decision_grades row is written on destructive approval ─────

test("writeDestructiveActionDecisionGrade: writes an auto-approval grade row for the linked approval_decisions row", async () => {
  const inserted: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const admin = {
    from(table: string) {
      return {
        select() {
          return {
            eq(_col: string, _val: string) {
              return {
                limit(_n: number) {
                  return {
                    async maybeSingle() {
                      if (table === "approval_decisions") return { data: { id: "dec-1" }, error: null };
                      if (table === "director_decision_grades") return { data: null, error: null }; // not yet graded
                      return { data: null, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        insert(payload: Record<string, unknown>) {
          inserted.push({ table, payload });
          return {
            select() {
              return { async maybeSingle() { return { data: { id: "grade-1" }, error: null }; } };
            },
          };
        },
      };
    },
  };
  const r = await writeDestructiveActionDecisionGrade(admin, {
    workspaceId: "ws-1",
    agentJobId: "job-1",
    directorFunction: "platform",
    blastRadiusSummary: "deletes 48,201 rows from orders — irreversible",
    routeReason: "irreversible_destructive + business-material — CEO circuit-break",
  });
  assert.equal(r.ok, true);
  assert.equal(r.approvalDecisionId, "dec-1");
  assert.equal(r.gradeId, "grade-1");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].table, "director_decision_grades");
  assert.equal(inserted[0].payload.dimension, "auto-approval");
  assert.equal(inserted[0].payload.approval_decision_id, "dec-1");
  assert.equal(inserted[0].payload.graded_by, "agent");
  assert.match(inserted[0].payload.reasoning as string, /deletes 48,201 rows/);
});

// ── Phase 7/Fix-2 (check 74b737bdbda6fa8d) — insert failures surface, marker rows re-graded ───

test("writeDestructiveActionDecisionGrade: fault-injected insert error returns ok:false (does NOT swallow the failure)", async () => {
  const admin = {
    from(table: string) {
      return {
        select() {
          return {
            eq(_col: string, _val: string) {
              return {
                limit(_n: number) {
                  return {
                    async maybeSingle() {
                      if (table === "approval_decisions") return { data: { id: "dec-1" }, error: null };
                      if (table === "director_decision_grades") return { data: null, error: null }; // not yet graded
                      return { data: null, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        insert(_payload: Record<string, unknown>) {
          return {
            select() {
              return {
                async maybeSingle() {
                  // Fault-injection: the DB (RLS reject / unique violation / constraint) refused
                  // the insert. The marker writer MUST report the failure — previously it silently
                  // returned ok:true+gradeId:null, so the director-grade sweep had nothing to pick.
                  return { data: null, error: { message: "row-level security policy violation" } };
                },
              };
            },
          };
        },
      };
    },
  };
  const r = await writeDestructiveActionDecisionGrade(admin, {
    workspaceId: "ws-1",
    agentJobId: "job-1",
    directorFunction: "platform",
    blastRadiusSummary: "x",
    routeReason: "y",
  });
  assert.equal(r.ok, false, "an insert error must NOT be reported as ok:true");
  assert.equal(r.approvalDecisionId, "dec-1", "the approval decision lookup succeeded, so id is still returned");
  assert.match(r.reason || "", /row-level security policy violation/);
});

test("writeDestructiveActionDecisionGrade: idempotent — a second call skips the insert when a row already exists", async () => {
  const inserted: unknown[] = [];
  const admin = {
    from(table: string) {
      return {
        select() {
          return {
            eq(_col: string, _val: string) {
              return {
                limit(_n: number) {
                  return {
                    async maybeSingle() {
                      if (table === "approval_decisions") return { data: { id: "dec-1" }, error: null };
                      if (table === "director_decision_grades") return { data: { id: "existing-grade" }, error: null };
                      return { data: null, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        insert(payload: Record<string, unknown>) {
          inserted.push(payload);
          return { select() { return { async maybeSingle() { return { data: null, error: null }; } }; } };
        },
      };
    },
  };
  const r = await writeDestructiveActionDecisionGrade(admin, {
    workspaceId: "ws-1",
    agentJobId: "job-1",
    directorFunction: "platform",
    blastRadiusSummary: "x",
    routeReason: "y",
  });
  assert.equal(r.ok, true);
  assert.equal(r.gradeId, "existing-grade");
  assert.equal(inserted.length, 0, "insert must NOT run when a grade row already exists");
});
