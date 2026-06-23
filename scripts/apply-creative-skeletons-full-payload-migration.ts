// apply-creative-skeletons-full-payload-migration — add the full-AdLibrary-payload columns to
// public.creative_skeletons (ad-creative-scout Phase 1: destination domain, copy, CTA, spend,
// engagement, channel). Idempotent (ADD COLUMN IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-creative-skeletons-full-payload-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260702120000_creative_skeletons_full_payload.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      `select count(*)::int as n from information_schema.columns
       where table_name='creative_skeletons'
         and column_name in ('destination_domain','call_to_action','body','message',
                             'estimated_spend','like_count','platform','ads_type')`,
    );
    console.log(`✓ creative_skeletons full-payload columns present: ${rows[0].n}/8`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
