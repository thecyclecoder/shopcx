/**
 * apply-20261206120000-dashboard-notifications-fulfillment-alert-type — Phase 2 of
 * reconcile-migration-drift-2026-08-superseded-and-check-superset.
 *
 * Applies `supabase/migrations/20261206120000_dashboard_notifications_fulfillment_alert_type.sql`
 * (already on-main from PR #2250 amplifier-import-reliability-rail) as a manual belt-and-suspenders
 * against the pooler AND records the version in `supabase_migrations.schema_migrations` — the
 * write-a-migration-apply-script sanctioned pattern (pg Client on `:6543` transaction pooler +
 * `insert into supabase_migrations.schema_migrations(version) values ('20261206120000') on conflict do nothing`).
 *
 * The primary drain is [[../src/lib/control-tower/migration-drift]] `applyMergedMigrations` on the
 * box reconciler tick — it classifies this file as additive (`add constraint … check (…)` alongside
 * a `drop constraint if exists` on the same name, per the classifier), auto-applies it, and stamps
 * the ledger. This script is the human-runnable fallback for a stale worktree / dev DB / anywhere
 * the reconciler hasn't landed yet.
 *
 * ── Strict-superset pre-verification ──
 * The new CHECK adds three types on top of the current live set — 0 existing rows can violate:
 *   NEW  : macro_suggestion, pattern_review, knowledge_gap, system, fraud_alert,
 *          chargeback_alert, duplicate_order_alert, escalation_gap, agent_approval_request,
 *          agent_message, agent_daily_summary, mario_accuracy_alarm,
 *          fulfillment_alert   ← added
 *          return_request      ← added
 *          refund_drift        ← added
 *   LIVE : macro_suggestion, pattern_review, knowledge_gap, system, fraud_alert,
 *          chargeback_alert, duplicate_order_alert, escalation_gap, agent_approval_request,
 *          agent_message, agent_daily_summary, mario_accuracy_alarm
 * (`fulfillment_alert` unlocks the amplifier-import-reliability-rail escalation card; the other two
 * are the returns / refund-drift escalations 20260709120000 already added inline.)
 *
 * ── Idempotency ──
 * - `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` with the same name is safe on a re-run — the DROP
 *   no-ops if the object was already re-declared with this CHECK; ADD raises `duplicate_object`
 *   (42710) if it's already there and the ledger row is inserted anyway. `isDuplicateObjectError`
 *   (`src/lib/control-tower/migration-drift.ts`) is the shared classifier the auto-apply path uses;
 *   this script surfaces the same signal via a savepoint-scoped try/catch on the DDL.
 * - `insert into schema_migrations … on conflict (version) do nothing` — a second run inserts nothing.
 * - Three-shape fallback for the ledger row (name+statements → name → version-only) mirrors
 *   `scripts/_reconcile-migration-ledger.ts` `recordVersion` so the write survives across every
 *   Supabase schema revision of `schema_migrations`.
 *
 * Usage:
 *   npx tsx scripts/apply-20261206120000-dashboard-notifications-fulfillment-alert-type.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { errText } from "../src/lib/error-text";
import { pgClient } from "./_bootstrap";
import { isDuplicateObjectError } from "../src/lib/control-tower/migration-drift";

const VERSION = "20261206120000";
const FILE = "20261206120000_dashboard_notifications_fulfillment_alert_type.sql";
const NAME_WITHOUT_EXT = FILE.replace(/\.sql$/, "");

async function applyMigration(c: import("pg").Client, sql: string): Promise<{ alreadyApplied: boolean }> {
  const savepoint = `apply_${VERSION}`;
  await c.query(`SAVEPOINT ${savepoint}`);
  try {
    await c.query(sql);
    await c.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { alreadyApplied: false };
  } catch (err) {
    await c.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await c.query(`RELEASE SAVEPOINT ${savepoint}`);
    if (isDuplicateObjectError(err)) {
      return { alreadyApplied: true };
    }
    throw err;
  }
}

async function recordVersion(c: import("pg").Client, sql: string): Promise<void> {
  const attempts: Array<{ sql: string; params: unknown[] }> = [
    {
      sql: `insert into supabase_migrations.schema_migrations (version, name, statements)
            values ($1, $2, array[$3]::text[])
            on conflict (version) do nothing`,
      params: [VERSION, NAME_WITHOUT_EXT, sql],
    },
    {
      sql: `insert into supabase_migrations.schema_migrations (version, name)
            values ($1, $2)
            on conflict (version) do nothing`,
      params: [VERSION, NAME_WITHOUT_EXT],
    },
    {
      sql: `insert into supabase_migrations.schema_migrations (version)
            values ($1)
            on conflict (version) do nothing`,
      params: [VERSION],
    },
  ];
  const savepoint = `rec_${VERSION}`;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    await c.query(`SAVEPOINT ${savepoint}`);
    try {
      await c.query(a.sql, a.params);
      await c.query(`RELEASE SAVEPOINT ${savepoint}`);
      return;
    } catch (err) {
      await c.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await c.query(`RELEASE SAVEPOINT ${savepoint}`);
      if (i === attempts.length - 1) throw err;
    }
  }
}

async function main(): Promise<void> {
  const sql = readFileSync(resolve(__dirname, "../supabase/migrations", FILE), "utf8");
  console.log(`[apply-${VERSION}] applying ${FILE} against pooler`);
  const c = pgClient();
  await c.connect();
  try {
    await c.query("BEGIN");
    try {
      const applyRes = await applyMigration(c, sql);
      await recordVersion(c, sql);
      await c.query("COMMIT");
      if (applyRes.alreadyApplied) {
        console.log(`[apply-${VERSION}] CHECK constraint was already present — ledger row recorded (idempotent).`);
      } else {
        console.log(`[apply-${VERSION}] CHECK constraint applied + ledger row recorded.`);
      }
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`[apply-${VERSION}] failed: ${errText(e)}`);
  process.exit(1);
});
