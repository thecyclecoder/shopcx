/**
 * Apply the customers audience-resolve indexes directly to Supabase
 * Postgres so the next campaign schedule benefits immediately. Uses
 * CONCURRENTLY to avoid blocking writes on the customers table.
 *
 * CREATE INDEX CONCURRENTLY can't run inside a transaction, so we
 * issue each statement separately. Idempotent via IF NOT EXISTS.
 */
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
const host = process.env.SUPABASE_DB_HOST || "aws-1-us-east-1.pooler.supabase.com";
const PROJECT_REF = "urjbhjbygyxffrfkarqn";
const connectionString = `postgres://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@${host}:6543/postgres`;

const statements = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS customers_sms_audience_idx
     ON public.customers (workspace_id, sms_marketing_status)
     WHERE phone IS NOT NULL;`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS customers_segments_gin
     ON public.customers USING GIN (segments);`,
];

async function main() {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    for (const sql of statements) {
      const label = sql.split("\n")[0].trim().slice(0, 80);
      console.log(`→ ${label}`);
      const started = Date.now();
      await client.query(sql);
      console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    // Confirm both exist.
    const { rows } = await client.query(`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'customers'
        and indexname in ('customers_sms_audience_idx', 'customers_segments_gin')
      order by indexname;
    `);
    console.log("\nVerified:");
    for (const r of rows) console.log(`  ${r.indexname}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
