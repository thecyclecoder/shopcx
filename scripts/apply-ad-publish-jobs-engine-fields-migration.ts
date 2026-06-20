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

const MIGRATIONS = ["20260620180000_ad_publish_jobs_engine_fields.sql"];
const COLUMNS = ["ad_name", "recommendation_id"];

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
    for (const col of COLUMNS) {
      const { rows } = await c.query(
        "select 1 from information_schema.columns where table_schema='public' and table_name='ad_publish_jobs' and column_name=$1",
        [col],
      );
      console.log(`${rows.length ? "✓" : "✗"} public.ad_publish_jobs.${col} present`);
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
