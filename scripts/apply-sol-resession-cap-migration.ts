// apply-sol-resession-cap-migration — add
//   ticket_directions.resession_count integer NOT NULL DEFAULT 0
//   ai_channel_config.sol_max_resessions integer NULL DEFAULT 3
//
// Phase 1 of docs/brain/specs/sol-runaway-re-session-cap-guardrail.md.
// Idempotent (ADD COLUMN IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-sol-resession-cap-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260930120000_sol_resession_cap.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    const td = await c.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema='public'
          and table_name='ticket_directions'
          and column_name='resession_count'`,
    );
    if (td.rows.length !== 1) {
      throw new Error("ticket_directions.resession_count column missing after migration");
    }
    {
      const col = td.rows[0];
      if (col.data_type !== "integer") throw new Error(`expected integer, got ${col.data_type}`);
      if (col.is_nullable !== "NO") {
        throw new Error(`expected NOT NULL, got is_nullable=${col.is_nullable}`);
      }
      if (!String(col.column_default).startsWith("0")) {
        throw new Error(`expected default=0, got ${col.column_default}`);
      }
      console.log(
        `✓ ticket_directions.resession_count integer NOT NULL default ${col.column_default}`,
      );
    }

    const cfg = await c.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema='public'
          and table_name='ai_channel_config'
          and column_name='sol_max_resessions'`,
    );
    if (cfg.rows.length !== 1) {
      throw new Error("ai_channel_config.sol_max_resessions column missing after migration");
    }
    {
      const col = cfg.rows[0];
      if (col.data_type !== "integer") throw new Error(`expected integer, got ${col.data_type}`);
      if (col.is_nullable !== "YES") {
        throw new Error(`expected NULLABLE, got is_nullable=${col.is_nullable}`);
      }
      if (!String(col.column_default).startsWith("3")) {
        throw new Error(`expected default=3, got ${col.column_default}`);
      }
      console.log(
        `✓ ai_channel_config.sol_max_resessions integer NULL default ${col.column_default}`,
      );
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
