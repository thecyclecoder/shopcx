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

const migrationPath = resolve(__dirname, "../supabase/migrations/20260611170000_internal_traffic.sql");
const sql = readFileSync(migrationPath, "utf8");

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
    console.log("✓ Applied 20260611170000_internal_traffic.sql");
    // Flag Dylan's customer record(s) as internal so logged-in/stitched
    // sessions are excluded immediately, across every device.
    const ws = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
    const emails = ["dylan@superfoodscompany.com", "dylanralston@gmail.com"];
    const r = await client.query(
      "update public.customers set is_internal = true where workspace_id = $1 and lower(email) = any($2) returning id, email",
      [ws, emails.map((e) => e.toLowerCase())]
    );
    console.log(`flagged ${r.rowCount} internal customer(s):`, r.rows.map((x) => x.email).join(", ") || "(none found)");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
