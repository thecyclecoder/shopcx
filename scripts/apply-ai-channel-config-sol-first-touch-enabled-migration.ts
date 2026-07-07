// apply-ai-channel-config-sol-first-touch-enabled-migration — add the boolean
// sol_first_touch_enabled column (default false) to public.ai_channel_config.
//
// Phase 3 of docs/brain/specs/sol-ticket-direction-artifact-and-first-touch-box-session.md.
// Idempotent (ADD COLUMN IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-ai-channel-config-sol-first-touch-enabled-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260926120000_ai_channel_config_sol_first_touch_enabled.sql"];

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
          and column_name='sol_first_touch_enabled'`,
    );
    if (rows.length !== 1) throw new Error("sol_first_touch_enabled column missing after migration");
    const col = rows[0];
    if (col.data_type !== "boolean") throw new Error(`expected boolean, got ${col.data_type}`);
    if (col.is_nullable !== "NO") throw new Error(`expected NOT NULL, got is_nullable=${col.is_nullable}`);
    if (!String(col.column_default).startsWith("false")) throw new Error(`expected default=false, got ${col.column_default}`);
    console.log(`✓ ai_channel_config.sol_first_touch_enabled boolean NOT NULL default ${col.column_default}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
