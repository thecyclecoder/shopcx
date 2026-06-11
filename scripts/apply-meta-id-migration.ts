import { readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

const envPath = "/Users/admin/Projects/shopcx/.env.local";
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

const migrationPath = resolve(__dirname, "../supabase/migrations/20260611160000_meta_id.sql");
const sql = readFileSync(migrationPath, "utf8");

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
    console.log("✓ Applied 20260611160000_meta_id.sql");
    const p = await client.query(
      "select count(*)::int as total, count(meta_id)::int as with_meta from public.products"
    );
    const v = await client.query(
      "select count(*)::int as total, count(meta_id)::int as with_meta from public.product_variants"
    );
    console.log("products:", p.rows[0], "| variants:", v.rows[0]);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
