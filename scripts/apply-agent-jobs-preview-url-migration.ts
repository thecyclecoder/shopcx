// apply-agent-jobs-preview-url-migration — add preview_url + preview_state to public.agent_jobs
// (per-build-vercel-preview-deploys Phase 2) so the per-build preview deployment can be persisted
// on the owning build's row. Idempotent (ADD COLUMN IF NOT EXISTS · CREATE INDEX IF NOT EXISTS).
//
//   npx tsx scripts/apply-agent-jobs-preview-url-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260727120000_agent_jobs_preview_url.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name = 'agent_jobs' and column_name in ('preview_url','preview_state') order by column_name",
    );
    console.log("✓ agent_jobs new columns:", rows.map((r) => r.column_name).join(", ") || "(none)");
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
