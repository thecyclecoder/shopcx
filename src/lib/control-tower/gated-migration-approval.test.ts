/**
 * Unit tests for the gated-migration approval filing (gated-migration-approval-card).
 *
 * Built-in node:test. Run:
 *   npx tsx --test src/lib/control-tower/gated-migration-approval.test.ts
 *
 * Pins: dedupe (≤1 approval per version+content, decline sticks until the file changes, edited file
 * supersedes the stale open card), routing (routeDestructiveAction + dormant-Platform ⇒ CEO), the card
 * content (file, severity, matches, SQL preview), and the executor's pre-apply re-check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  GATED_MIGRATION_JOB_KIND,
  isOutOfLeashExecutableClaimStatus,
  buildGatedMigrationApprovalJob,
  decideGatedMigrationFiling,
  gatedMigrationDedupeKey,
  gatedMigrationSpecSlug,
  migrationContentHash,
  parseExistingGatedMigrationRow,
  readGatedMigrationMarker,
  resolveGatedMigrationRoute,
  validateGatedMigrationExecution,
  type ExistingGatedMigrationRow,
} from "./gated-migration-approval";
import { classifyMigrationSql, computeBlastRadius } from "@/lib/migration-safety";
import { buildApprovalContent, routingOwnerForJob, type ApprovalJobRow } from "@/lib/agents/approval-inbox";

const V = "20270109120000";
const FILE = `${V}_dashboard_notifications_billing_alert_and_auth_expired_types.sql`;
const CHECK_WIDEN_SQL = `ALTER TABLE public.dashboard_notifications
  DROP CONSTRAINT IF EXISTS dashboard_notifications_type_check;
ALTER TABLE public.dashboard_notifications
  ADD CONSTRAINT dashboard_notifications_type_check CHECK (type = ANY (ARRAY['system','billing_alert']::text[]));`;

// ── dedupe ───────────────────────────────────────────────────────────────────

test("dedupe key = version + content hash; changes with content, stable for same bytes", () => {
  const a = gatedMigrationDedupeKey(V, CHECK_WIDEN_SQL);
  assert.equal(a, gatedMigrationDedupeKey(V, CHECK_WIDEN_SQL));
  assert.ok(a.startsWith(`migration-drift::${V}::`));
  assert.notEqual(a, gatedMigrationDedupeKey(V, `${CHECK_WIDEN_SQL}\n-- edited`));
  assert.notEqual(a, gatedMigrationDedupeKey("20270109120001", CHECK_WIDEN_SQL));
});

test("no prior row → file", () => {
  const d = decideGatedMigrationFiling([], { version: V, dedupeKey: gatedMigrationDedupeKey(V, CHECK_WIDEN_SQL) });
  assert.equal(d.action, "file");
  assert.deepEqual(d.supersedeIds, []);
});

test("re-tick with an open approval for same version+content → skip (never fans out)", () => {
  const key = gatedMigrationDedupeKey(V, CHECK_WIDEN_SQL);
  const existing: ExistingGatedMigrationRow[] = [{ id: "job-1", status: "needs_approval", dedupeKey: key, version: V }];
  for (let tick = 0; tick < 5; tick++) {
    const d = decideGatedMigrationFiling(existing, { version: V, dedupeKey: key });
    assert.equal(d.action, "skip");
  }
});

test("declined (completed) for same content → not re-filed; any non-open status also skips", () => {
  const key = gatedMigrationDedupeKey(V, CHECK_WIDEN_SQL);
  for (const status of ["completed", "queued_resume", "claimed", "needs_attention", "failed"]) {
    const d = decideGatedMigrationFiling([{ id: "j", status, dedupeKey: key, version: V }], { version: V, dedupeKey: key });
    assert.equal(d.action, "skip", status);
  }
});

test("file content changed → files fresh + supersedes the stale OPEN card only", () => {
  const oldKey = gatedMigrationDedupeKey(V, CHECK_WIDEN_SQL);
  const newKey = gatedMigrationDedupeKey(V, `${CHECK_WIDEN_SQL}\n-- v2`);
  const d = decideGatedMigrationFiling(
    [
      { id: "open-old", status: "needs_approval", dedupeKey: oldKey, version: V },
      { id: "declined-older", status: "completed", dedupeKey: "migration-drift::" + V + "::deadbeefdeadbeef", version: V },
    ],
    { version: V, dedupeKey: newKey },
  );
  assert.equal(d.action, "file");
  assert.deepEqual(d.supersedeIds, ["open-old"]);
});

test("rows for a different version never block or get superseded", () => {
  const key = gatedMigrationDedupeKey(V, CHECK_WIDEN_SQL);
  const d = decideGatedMigrationFiling(
    [{ id: "other", status: "needs_approval", dedupeKey: gatedMigrationDedupeKey("20261008120000", "x"), version: "20261008120000" }],
    { version: V, dedupeKey: key },
  );
  assert.equal(d.action, "file");
  assert.deepEqual(d.supersedeIds, []);
});

test("parseExistingGatedMigrationRow reads instructions; malformed JSON ⇒ null key (never throws)", () => {
  const job = buildJob(false);
  const parsed = parseExistingGatedMigrationRow({ id: "x", status: "needs_approval", instructions: job.instructions });
  assert.equal(parsed.dedupeKey, gatedMigrationDedupeKey(V, CHECK_WIDEN_SQL));
  assert.equal(parsed.version, V);
  const bad = parseExistingGatedMigrationRow({ id: "y", status: "completed", instructions: "{not json" });
  assert.equal(bad.dedupeKey, null);
});

// ── routing ──────────────────────────────────────────────────────────────────

test("CHECK-widening (DROP CONSTRAINT IF EXISTS) is reversible_destructive → Platform when Ada is live+autonomous", async () => {
  const br = await computeBlastRadius(CHECK_WIDEN_SQL);
  assert.equal(br.severity, "reversible_destructive");
  const r = resolveGatedMigrationRoute({ sql: CHECK_WIDEN_SQL, blastRadius: br, platformAutoApprover: true });
  assert.equal(r.routedToFunction, "platform");
  assert.equal(r.platformDormantFallback, false);
});

test("Platform route + Ada dormant → CEO (never waits on a dormant approver)", async () => {
  const br = await computeBlastRadius(CHECK_WIDEN_SQL);
  const r = resolveGatedMigrationRoute({ sql: CHECK_WIDEN_SQL, blastRadius: br, platformAutoApprover: false });
  assert.equal(r.baseRoutedToFunction, "platform");
  assert.equal(r.routedToFunction, "ceo");
  assert.equal(r.platformDormantFallback, true);
  assert.match(r.reason, /not live\+autonomous/);
});

test("irreversible (DROP TABLE) → CEO regardless of Platform autonomy; never widened to Platform", async () => {
  const sql = "drop table public.stale_ledger;";
  const br = await computeBlastRadius(sql);
  for (const platformAutoApprover of [true, false]) {
    const r = resolveGatedMigrationRoute({ sql, blastRadius: br, platformAutoApprover });
    assert.equal(r.routedToFunction, "ceo");
    assert.equal(r.platformDormantFallback, false);
  }
});

test("reversible but business-material (mass row touch) → CEO even with Ada live", () => {
  const sql = "alter table public.x drop constraint if exists x_check;";
  const br = {
    measured: true,
    severity: "reversible_destructive" as const,
    matches: ["ALTER … DROP CONSTRAINT"],
    summary: "measured",
    affected: [{ statement: sql, rowCount: 5000 }],
  };
  const r = resolveGatedMigrationRoute({ sql, blastRadius: br, platformAutoApprover: true });
  assert.equal(r.businessMaterial, true);
  assert.equal(r.routedToFunction, "ceo");
  assert.equal(r.platformDormantFallback, false);
});

// ── the job row + card ───────────────────────────────────────────────────────

function buildJob(platformAutoApprover: boolean) {
  const cls = classifyMigrationSql(CHECK_WIDEN_SQL);
  const blastRadius = {
    measured: false,
    severity: cls.severity,
    matches: cls.matches,
    summary: "static",
    measurementSkipped: "no pg client provided",
  };
  const route = resolveGatedMigrationRoute({ sql: CHECK_WIDEN_SQL, blastRadius, platformAutoApprover });
  return buildGatedMigrationApprovalJob({
    workspaceId: "ws-1",
    version: V,
    file: FILE,
    sql: CHECK_WIDEN_SQL,
    severity: cls.severity,
    matches: cls.matches,
    blastRadius,
    route,
  });
}

test("job row rides the existing out-of-leash kind with ONE apply_migration action + marker", () => {
  const job = buildJob(false);
  assert.equal(job.kind, GATED_MIGRATION_JOB_KIND);
  assert.equal(job.kind, "ceo-authorized-out-of-leash");
  assert.equal(job.status, "needs_approval");
  assert.equal(job.spec_slug, gatedMigrationSpecSlug(V));
  assert.equal(job.pending_actions.length, 1);
  const a = job.pending_actions[0];
  assert.equal(a.type, "apply_migration");
  assert.equal(a.status, "pending");
  assert.equal(a.out_of_leash, true);
  assert.deepEqual(readGatedMigrationMarker(a), { version: V, file: FILE, content_hash: migrationContentHash(CHECK_WIDEN_SQL) });
  const instr = JSON.parse(job.instructions);
  assert.equal(instr.origin, "migration-drift");
  assert.equal(instr.dedupe_key, gatedMigrationDedupeKey(V, CHECK_WIDEN_SQL));
});

test("approval card shows file name, severity, classifier matches and the SQL preview", () => {
  const job = buildJob(false);
  const { title, body } = buildApprovalContent({ id: "j1", ...job } as unknown as ApprovalJobRow);
  assert.match(title, new RegExp(FILE));
  for (const needle of [FILE, "reversible_destructive", "ALTER … DROP CONSTRAINT", "DROP CONSTRAINT IF EXISTS dashboard_notifications_type_check", "billing_alert"]) {
    assert.ok(body.includes(needle), `card body missing: ${needle}`);
  }
});

test("inbox routing honors the CEO override (dormant Ada) and the Platform override only for reversible_destructive", () => {
  const ceoJob = buildJob(false);
  assert.equal(routingOwnerForJob({ kind: ceoJob.kind, pending_actions: ceoJob.pending_actions as never }), "ceo");
  const platformJob = buildJob(true);
  assert.equal(routingOwnerForJob({ kind: platformJob.kind, pending_actions: platformJob.pending_actions as never }), "platform");
});

test("long SQL is truncated on the card but the action still names the file", () => {
  const big = `${CHECK_WIDEN_SQL}\n${"-- padding line\n".repeat(400)}`;
  const cls = classifyMigrationSql(big);
  const br = { measured: false, severity: cls.severity, matches: cls.matches, summary: "s" };
  const job = buildGatedMigrationApprovalJob({
    workspaceId: "w", version: V, file: FILE, sql: big, severity: cls.severity, matches: cls.matches, blastRadius: br,
    route: resolveGatedMigrationRoute({ sql: big, blastRadius: br, platformAutoApprover: false }),
  });
  const preview = String(job.pending_actions[0].preview);
  assert.ok(preview.length < 3000);
  assert.match(preview, /truncated/);
  assert.ok(preview.includes(FILE));
});

// ── executor pre-apply re-check ──────────────────────────────────────────────

const marker = { version: V, file: FILE, content_hash: migrationContentHash(CHECK_WIDEN_SQL) };

test("execution: same bytes + unapplied → ok", () => {
  assert.deepEqual(validateGatedMigrationExecution({ marker, onDiskSql: CHECK_WIDEN_SQL, appliedVersions: new Set() }), { ok: true });
  assert.deepEqual(validateGatedMigrationExecution({ marker, onDiskSql: CHECK_WIDEN_SQL, appliedVersions: null }), { ok: true });
});

test("execution: file edited after filing → refuse (content-changed)", () => {
  const r = validateGatedMigrationExecution({ marker, onDiskSql: `${CHECK_WIDEN_SQL} -- x`, appliedVersions: new Set() });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.outcome, "content-changed");
});

test("execution: already in ledger → already-applied; missing file → missing", () => {
  const a = validateGatedMigrationExecution({ marker, onDiskSql: CHECK_WIDEN_SQL, appliedVersions: new Set([V]) });
  assert.equal(!a.ok && a.outcome, "already-applied");
  const m = validateGatedMigrationExecution({ marker, onDiskSql: null, appliedVersions: new Set() });
  assert.equal(!m.ok && m.outcome, "missing");
});

test("execution: path-traversal / version-mismatch markers are refused", () => {
  for (const bad of [
    { ...marker, file: `../../etc/${FILE}` },
    { ...marker, file: `sub/${FILE}` },
    { ...marker, version: "20270109120001" },
    { ...marker, file: "not-a-migration.sql" },
  ]) {
    const r = validateGatedMigrationExecution({ marker: bad, onDiskSql: CHECK_WIDEN_SQL, appliedVersions: new Set() });
    assert.equal(!r.ok && r.outcome, "invalid", JSON.stringify(bad));
  }
});

test("the live stuck migration on main is gated (destructive) and would file a card", () => {
  const path = join(__dirname, "../../../supabase/migrations", FILE);
  let sql: string;
  try {
    sql = readFileSync(path, "utf8");
  } catch {
    return; // file renamed/removed later — nothing to pin
  }
  const cls = classifyMigrationSql(sql);
  assert.notEqual(cls.severity, "additive");
  const d = decideGatedMigrationFiling([], { version: V, dedupeKey: gatedMigrationDedupeKey(V, sql) });
  assert.equal(d.action, "file");
});

test("executor entry guard accepts the claimed row (claim_agent_job flips queued_resume → building)", () => {
  assert.equal(isOutOfLeashExecutableClaimStatus("building"), true);
  assert.equal(isOutOfLeashExecutableClaimStatus("queued_resume"), true);
  for (const s of ["needs_approval", "queued", "completed", "needs_attention", null, undefined]) {
    assert.equal(isOutOfLeashExecutableClaimStatus(s as string | null | undefined), false, String(s));
  }
});

test("claim_agent_job returns the row as 'building' (the guard must not require queued_resume)", () => {
  const dir = join(process.cwd(), "supabase/migrations");
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".sql")).sort();
  const latest = [...files].reverse().find((f: string) =>
    /create or replace function public\.claim_agent_job\(/i.test(readFileSync(join(dir, f), "utf8")),
  );
  assert.ok(latest, "a claim_agent_job definition exists");
  const sql = readFileSync(join(dir, latest as string), "utf8");
  assert.match(sql, /set status = 'building'/, `${latest} claims by flipping to building`);
  assert.equal(isOutOfLeashExecutableClaimStatus("building"), true);
});
