import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
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

async function main() {
  const { Client } = await import("pg");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const host = url.replace("https://", "").replace(".supabase.co", "");
  const password = process.env.SUPABASE_DB_PASSWORD!;
  // Pooler hostnames are region-prefixed; try common regions until one connects.
  const candidates = [
    `postgresql://postgres.${host}:${encodeURIComponent(password)}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${host}:${encodeURIComponent(password)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${host}:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres:${encodeURIComponent(password)}@db.${host}.supabase.co:5432/postgres`,
  ];
  let conn = "";
  for (const c of candidates) {
    const probe = new Client({ connectionString: c, connectionTimeoutMillis: 4000 });
    try {
      await probe.connect();
      await probe.end();
      conn = c;
      console.log("connected via", c.replace(encodeURIComponent(password), "***"));
      break;
    } catch (e) {
      // try next
    }
  }
  if (!conn) throw new Error("no connection string worked");
  const client = new Client({ connectionString: conn });
  await client.connect();
  const sql = readFileSync(resolve(__dirname, "../supabase/migrations/20260605120000_loyalty_backfill_flag.sql"), "utf8");
  await client.query(sql);
  const r = await client.query("select column_name from information_schema.columns where table_name='loyalty_members' and column_name='needs_points_backfill'");
  console.log("✓ Migration applied. needs_points_backfill column present:", r.rows.length > 0);
  await client.end();
}
main().catch(e => { console.error(e); process.exit(1); });
