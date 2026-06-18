import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}
async function main() {
  const { Client } = await import("pg");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const host = url.replace("https://", "").replace(".supabase.co", "");
  const password = process.env.SUPABASE_DB_PASSWORD!;
  const candidates = [
    `postgresql://postgres.${host}:${encodeURIComponent(password)}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${host}:${encodeURIComponent(password)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${host}:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres:${encodeURIComponent(password)}@db.${host}.supabase.co:5432/postgres`,
  ];
  let conn = "";
  for (const c of candidates) {
    const probe = new Client({ connectionString: c, connectionTimeoutMillis: 4000 });
    try { await probe.connect(); await probe.end(); conn = c; console.log("connected via", c.split("@")[1]); break; } catch {}
  }
  if (!conn) throw new Error("no connection string worked");
  const client = new Client({ connectionString: conn });
  await client.connect();
  const sql = readFileSync(resolve(__dirname, "../supabase/migrations/20260609120000_shopify_payment_method_sync.sql"), "utf8");
  await client.query(sql);
  const r = await client.query("select column_name, is_nullable from information_schema.columns where table_name='customer_payment_methods' and column_name in ('braintree_customer_id','braintree_payment_method_token','shopify_payment_method_id') order by column_name");
  console.log("✓ columns:", JSON.stringify(r.rows));
  const idx = await client.query("select indexname from pg_indexes where tablename='customer_payment_methods' and indexname='uq_customer_payment_methods_shopify_pm'");
  console.log("  shopify unique index:", idx.rows.map((x:{indexname:string})=>x.indexname).join(", ") || "MISSING");
  const chk = await client.query("select conname from pg_constraint where conname='customer_payment_methods_handle_present'");
  console.log("  handle-present check:", chk.rows.map((x:{conname:string})=>x.conname).join(", ") || "MISSING");
  await client.end();
}
main().catch(e => { console.error(e); process.exit(1); });
