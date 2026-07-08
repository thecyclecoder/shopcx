// apply-ai-channel-config-sol-cap-hit-alarm-migration — add
//   ai_channel_config.sol_cap_hit_alarm integer NOT NULL DEFAULT 5
//
// Fix 1 (Phase 4) of docs/brain/specs/sol-runaway-re-session-cap-guardrail.md.
// Idempotent (ADD COLUMN IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-ai-channel-config-sol-cap-hit-alarm-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260930120001_ai_channel_config_sol_cap_hit_alarm.sql"];

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
          and column_name='sol_cap_hit_alarm'`,
    );
    if (rows.length !== 1) {
      throw new Error("ai_channel_config.sol_cap_hit_alarm column missing after migration");
    }
    const col = rows[0];
    if (col.data_type !== "integer") throw new Error(`expected integer, got ${col.data_type}`);
    if (col.is_nullable !== "NO") {
      throw new Error(`expected NOT NULL, got is_nullable=${col.is_nullable}`);
    }
    if (!String(col.column_default).startsWith("5")) {
      throw new Error(`expected default=5, got ${col.column_default}`);
    }
    console.log(
      `✓ ai_channel_config.sol_cap_hit_alarm integer NOT NULL default ${col.column_default}`,
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
