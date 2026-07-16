// apply-media-buyer-cold-scaler-cac-ltv-snapshots-migration — create
// public.media_buyer_cold_scaler_cac_ltv_snapshots
// (bianca-cold-scaler-campaign-cac-ltv-sensor Phase 1). Per-(workspace,
// meta_ad_account, cold_scaler_cohort, iso_week) snapshot row that persists
// the campaign-scoped CAC:LTV numerator + denominator + derived ratio +
// band + human-readable flags — the durable, cite-able artifact the M4
// arming gate reads and the CEO grades against. Sibling of
// media_buyer_cold_scaler_arming_authorization (which pins the shadow→armed
// authorization). Idempotent (CREATE TABLE / TRIGGER / POLICY IF NOT
// EXISTS). Run against the pooler:
//   npx tsx scripts/apply-media-buyer-cold-scaler-cac-ltv-snapshots-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261024120000_media_buyer_cold_scaler_cac_ltv_snapshots.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='media_buyer_cold_scaler_cac_ltv_snapshots'",
    );
    console.log(`✓ media_buyer_cold_scaler_cac_ltv_snapshots table present: ${t[0].n === 1}`);
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='media_buyer_cold_scaler_cac_ltv_snapshots' order by ordinal_position",
    );
    console.log(
      `✓ media_buyer_cold_scaler_cac_ltv_snapshots columns: ${cols.map((r) => r.column_name).join(", ")}`,
    );
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename='media_buyer_cold_scaler_cac_ltv_snapshots' order by indexname",
    );
    console.log(
      `✓ media_buyer_cold_scaler_cac_ltv_snapshots indexes: ${idx.map((r) => r.indexname).join(", ")}`,
    );
    const { rows: chk } = await c.query(
      "select conname from pg_constraint where conrelid='public.media_buyer_cold_scaler_cac_ltv_snapshots'::regclass and contype='c' order by conname",
    );
    console.log(`✓ check constraints: ${chk.map((r) => r.conname).join(", ")}`);
    const { rows: rls } = await c.query(
      "select relrowsecurity from pg_class where relname='media_buyer_cold_scaler_cac_ltv_snapshots'",
    );
    console.log(`✓ RLS enabled: ${rls[0]?.relrowsecurity === true}`);
    const { rows: pol } = await c.query(
      "select policyname from pg_policies where tablename='media_buyer_cold_scaler_cac_ltv_snapshots' order by policyname",
    );
    console.log(`✓ policies: ${pol.map((r) => r.policyname).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
