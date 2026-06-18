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

// advertorial-landers + killer-statics go-live migrations (all idempotent).
const MIGRATIONS = [
  "20260615120000_advertorial_pages.sql",
  "20260616120000_advertorial_pages_reasons.sql",
  "20260615120000_ad_campaigns_landing_url.sql",
];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const t = await c.query("select count(*)::int n from information_schema.tables where table_name='advertorial_pages'");
    const col = await c.query("select count(*)::int n from information_schema.columns where table_name='ad_campaigns' and column_name='landing_url'");
    console.log(`✓ advertorial_pages table: ${t.rows[0].n === 1}; ad_campaigns.landing_url: ${col.rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
