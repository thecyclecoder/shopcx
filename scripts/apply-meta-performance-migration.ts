import { readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const password = process.env.SUPABASE_DB_PASSWORD!;
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;

const MIGRATIONS = ["20260618140000_meta_performance_tables.sql"];
const TABLES = ["meta_campaigns", "meta_adsets", "meta_ads", "meta_insights_daily"];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    // Wrap in a transaction so a partial failure rolls back cleanly (idempotent re-run).
    await c.query("begin");
    for (const file of MIGRATIONS) {
      const sql = readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8");
      await c.query(sql);
      console.log(`✓ applied ${file}`);
    }
    await c.query("commit");
    for (const t of TABLES) {
      const { rows } = await c.query(
        "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name=$1",
        [t],
      );
      console.log(`✓ public.${t} has ${rows[0].n} columns`);
    }
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
