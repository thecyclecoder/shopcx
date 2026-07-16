// apply-ad-campaigns-audience-temperature-migration — add public.ad_campaigns.audience_temperature
// (docs/brain/specs/dahlia-audience-temperature-marking-and-cold-offer-gate.md Phase 1). Idempotent
// (ADD COLUMN IF NOT EXISTS with a CHECK constraint on null | cold | warm | hot).
//   npx tsx scripts/apply-ad-campaigns-audience-temperature-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261022120000_ad_campaigns_audience_temperature.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select data_type, is_nullable from information_schema.columns where table_schema='public' and table_name='ad_campaigns' and column_name='audience_temperature'",
    );
    if (rows.length !== 1) throw new Error(`expected 1 audience_temperature column, got ${rows.length}`);
    console.log(`✓ ad_campaigns.audience_temperature present: type=${rows[0].data_type} nullable=${rows[0].is_nullable}`);
    const { rows: checkRows } = await c.query(
      "select conname from pg_constraint where conrelid = 'public.ad_campaigns'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%audience_temperature%'",
    );
    console.log(`✓ CHECK constraint(s) on audience_temperature: ${checkRows.map((r) => r.conname).join(", ") || "(none — CHECK missing!)"}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
