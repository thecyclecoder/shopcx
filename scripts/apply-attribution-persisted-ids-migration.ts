import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

// Load .env.local IF present (local dev). On the BUILD BOX there is none — secrets
// come from the process env (systemd EnvironmentFile). Guard with existsSync so an
// absent file doesn't throw ENOENT before we connect.
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
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;

const MIGRATIONS = ["20260619180000_attribution_persisted_ids.sql"];
const COLUMNS: [string, string][] = [
  ["storefront_sessions", "advertorial_page_id"],
  ["storefront_sessions", "ad_campaign_id"],
  ["orders", "advertorial_page_id"],
  ["orders", "ad_campaign_id"],
];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    await c.query("begin");
    for (const file of MIGRATIONS) {
      const sql = readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8");
      await c.query(sql);
      console.log(`✓ applied ${file}`);
    }
    await c.query("commit");
    for (const [table, col] of COLUMNS) {
      const { rows } = await c.query(
        "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2",
        [table, col],
      );
      console.log(`${rows[0].n === 1 ? "✓" : "✗"} public.${table}.${col} ${rows[0].n === 1 ? "present" : "MISSING"}`);
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
