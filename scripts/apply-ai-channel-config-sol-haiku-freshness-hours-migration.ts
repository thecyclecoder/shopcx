// apply-ai-channel-config-sol-haiku-freshness-hours-migration — add the nullable numeric
// sol_haiku_freshness_hours column (default 24) to public.ai_channel_config.
//
// Phase 3 of docs/brain/specs/sol-cheap-execution-over-ticket-direction.md. The column
// gates the model-picker's Direction-driven Haiku route: when a ticket has a live
// ticket_directions row (superseded_at IS NULL) whose authored_at is more recent than
// (now() - sol_haiku_freshness_hours * interval '1 hour') AND latest confidence >=
// ai_channel_config.problem_lockin_threshold AND chosen_path='stateless', the picker
// returns Haiku instead of Sonnet. NULL → route OFF per-channel; default 24 → the
// shipping default is a 24-hour Haiku window without an operator touching config.
// Idempotent (ADD COLUMN IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-ai-channel-config-sol-haiku-freshness-hours-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260927120000_ai_channel_config_sol_haiku_freshness_hours.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    const { rows } = await c.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema='public'
          and table_name='ai_channel_config'
          and column_name='sol_haiku_freshness_hours'`,
    );
    if (rows.length !== 1) throw new Error("sol_haiku_freshness_hours column missing after migration");
    const col = rows[0];
    if (col.data_type !== "numeric") throw new Error(`expected numeric, got ${col.data_type}`);
    if (col.is_nullable !== "YES") throw new Error(`expected nullable, got is_nullable=${col.is_nullable}`);
    if (!String(col.column_default ?? "").startsWith("24")) {
      throw new Error(`expected default=24, got ${col.column_default}`);
    }
    console.log(`✓ ai_channel_config.sol_haiku_freshness_hours numeric NULL default ${col.column_default}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
