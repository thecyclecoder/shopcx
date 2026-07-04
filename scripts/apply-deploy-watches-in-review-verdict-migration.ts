// apply-deploy-watches-in-review-verdict-migration — extend deploy_watches.verdict CHECK to add
// 'in_review' (reva-box-session-causal-rollback Phase 1 — Reva moves off the deterministic cron path
// onto a supervised box session; the cron stamps `in_review` when it enqueues a deploy-review job
// instead of reverting/escalating directly). Idempotent (drop-then-recreate the CHECK constraint).
// Run against the pooler:
//   npx tsx scripts/apply-deploy-watches-in-review-verdict-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260820120000_deploy_watches_in_review_verdict.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    // Read the CHECK constraint's current expression via pg_get_constraintdef (the modern replacement
    // for the pg_catalog.pg_constraint.consrc column removed in PostgreSQL 12) and assert it accepts
    // `in_review`. information_schema.check_constraints would also work, but pg_get_constraintdef is
    // the canonical read + returns the fully-parenthesized expression Postgres actually enforces.
    const { rows } = await c.query(
      `select pg_get_constraintdef(oid) as def
         from pg_catalog.pg_constraint
        where conname = 'deploy_watches_verdict_check'`,
    );
    const def = rows.length ? String(rows[0].def) : null;
    if (!def) throw new Error("deploy_watches_verdict_check not found — the ALTER TABLE did not land");
    if (!/in_review/.test(def)) throw new Error(`deploy_watches_verdict_check does not accept 'in_review': ${def}`);
    console.log(`✓ deploy_watches_verdict_check accepts 'in_review': ${def}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
