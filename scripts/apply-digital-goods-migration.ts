// apply-digital-goods-migration — create public.digital_goods, the digital-goods
// catalog for Phase 1 of digital-goods-delivery. Idempotent (CREATE TABLE IF
// NOT EXISTS + CREATE INDEX IF NOT EXISTS + drop/create policy + drop/add
// constraint). Run against the pooler:
//   npx tsx scripts/apply-digital-goods-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260923120000_create_digital_goods.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: t } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='digital_goods'",
    );
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='digital_goods' order by ordinal_position",
    );
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename='digital_goods' order by indexname",
    );
    const { rows: rls } = await c.query(
      "select relrowsecurity as on from pg_class where relname='digital_goods'",
    );
    console.log(
      `✓ digital_goods present: ${t[0].n === 1} | RLS: ${rls[0]?.on} | columns: ${cols
        .map((r: any) => r.column_name)
        .join(", ")} | indexes: ${idx.map((r: any) => r.indexname).join(", ")}`,
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
