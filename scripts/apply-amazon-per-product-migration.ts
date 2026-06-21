import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

// Load .env.local IF present (local dev). On the build box there is none — secrets come from the
// process env (systemd EnvironmentFile). Guard the read or the apply crashes with ENOENT.
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

const password = process.env.SUPABASE_DB_PASSWORD!;
const cs =
  process.env.SUPABASE_DB_URL ||
  process.env.DATABASE_URL ||
  `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;

const MIGRATIONS = [
  "20260621130000_amazon_asins_pack.sql",
  "20260621130100_daily_amazon_product_snapshots.sql",
];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      const sql = readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8");
      await c.query(sql);
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      "select column_name from information_schema.columns where table_name='amazon_asins' and column_name in ('pack_size','units_per_pack','pack_resolved_by')",
    );
    console.log(`✓ amazon_asins pack columns present: ${cols.length}/3`);
    const { rows: tbl } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='daily_amazon_product_snapshots'",
    );
    console.log(`✓ daily_amazon_product_snapshots table present: ${tbl[0].n === 1}`);
    const { rows: seeded } = await c.query(
      "select count(*)::int as n from public.amazon_asins where pack_size is not null",
    );
    console.log(`✓ pack_size seeded on ${seeded[0].n} asins`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
