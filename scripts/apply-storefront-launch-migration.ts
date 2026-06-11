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

const migrationPath = resolve(__dirname, "../supabase/migrations/20260611190000_storefront_launch_at.sql");
const sql = readFileSync(migrationPath, "utf8");

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
    console.log("✓ Applied 20260611190000_storefront_launch_at.sql");
    // First live day for Superfoods: 2026-06-11 00:00 America/Chicago (CDT, -5).
    const ws = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
    const launch = "2026-06-11T05:00:00+00:00";
    const r = await client.query(
      "update public.workspaces set storefront_launch_at = $2 where id = $1 returning id, storefront_launch_at",
      [ws, launch]
    );
    console.log("set storefront_launch_at:", r.rows[0]?.storefront_launch_at);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
