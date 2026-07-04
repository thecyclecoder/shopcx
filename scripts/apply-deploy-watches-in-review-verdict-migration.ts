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
    const { rows } = await c.query(
      "select consrc from pg_catalog.pg_constraint where conname='deploy_watches_verdict_check'",
    );
    console.log(`✓ deploy_watches_verdict_check present: ${rows.length === 1}`);
    // Round-trip: an insert-then-rollback of a row carrying verdict='in_review' proves the new
    // CHECK accepts it (a transaction is rolled back so we don't leave a test row behind).
    await c.query("begin");
    try {
      // Sanity-only: pick any workspace, prove verdict='in_review' isn't rejected.
      const ws = await c.query("select id from public.workspaces limit 1");
      if (ws.rows.length) {
        await c.query(
          `insert into public.deploy_watches (workspace_id, slug, branch, deployed_at, window_ends_at, verdict)
             values ($1, 'in-review-verdict-probe', 'claude/probe', now(), now(), 'in_review')`,
          [ws.rows[0].id],
        );
        console.log("✓ verdict='in_review' accepted by the CHECK constraint");
      } else {
        console.log("· no workspaces present — skipped the CHECK round-trip");
      }
    } finally {
      await c.query("rollback");
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
