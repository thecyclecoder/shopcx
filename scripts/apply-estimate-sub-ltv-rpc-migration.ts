import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

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

const FILE = "20260708120000_estimate_sub_ltv_rpc.sql";

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    const sql = readFileSync(resolve(__dirname, "../supabase/migrations", FILE), "utf8");
    await c.query(sql);
    console.log(`✓ applied ${FILE}`);

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes where schemaname='public' and tablename='subscriptions' and indexname='idx_subscriptions_items_gin'`,
    );
    console.log(`✓ GIN index present: ${idx.length === 1}`);

    const { rows: fn } = await c.query(
      `select proname from pg_proc where proname='estimate_sub_ltv'`,
    );
    console.log(`✓ estimate_sub_ltv function present: ${fn.length >= 1}`);
  } finally {
    await c.end();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
