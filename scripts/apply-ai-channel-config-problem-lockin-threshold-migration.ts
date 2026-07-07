// apply-ai-channel-config-problem-lockin-threshold-migration — add the numeric
// problem_lockin_threshold column to public.ai_channel_config (Phase 1 of
// docs/brain/specs/confidence-gated-problem-lockin-and-selective-clarify.md).
// Idempotent (ADD COLUMN IF NOT EXISTS + DO-block CHECK guard). Run against the pooler:
//   npx tsx scripts/apply-ai-channel-config-problem-lockin-threshold-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260707120000_ai_channel_config_problem_lockin_threshold.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    const { rows: cols } = await c.query(
      `select column_name, data_type, column_default, is_nullable
         from information_schema.columns
        where table_schema='public' and table_name='ai_channel_config'
          and column_name='problem_lockin_threshold'`,
    );
    if (cols.length === 0) throw new Error("problem_lockin_threshold column missing after migration");
    console.log(`✓ ai_channel_config.problem_lockin_threshold: ${cols[0].data_type} default=${cols[0].column_default} nullable=${cols[0].is_nullable}`);

    const { rows: chk } = await c.query(
      `select conname from pg_constraint where conname='ai_channel_config_problem_lockin_threshold_range'`,
    );
    if (chk.length === 0) throw new Error("problem_lockin_threshold range CHECK missing after migration");
    console.log(`✓ CHECK ${chk[0].conname} present`);
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
