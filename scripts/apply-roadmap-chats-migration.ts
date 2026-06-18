import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

// Load .env.local if present (local dev); on the box the DB creds may already be in process.env.
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

const password = process.env.SUPABASE_DB_PASSWORD;
const host = process.env.SUPABASE_DB_HOST || "aws-1-us-east-1.pooler.supabase.com";
const PROJECT_REF = "urjbhjbygyxffrfkarqn";
// Prefer an explicit connection string env if the box provides one; else build the pooler URL.
const connectionString =
  process.env.SUPABASE_DB_URL ||
  process.env.DATABASE_URL ||
  (password ? `postgres://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@${host}:6543/postgres` : "");

const MIGRATIONS = ["20260618140000_roadmap_chats.sql"];

async function main() {
  if (!connectionString) {
    throw new Error("No DB credentials: set SUPABASE_DB_PASSWORD (or SUPABASE_DB_URL / DATABASE_URL).");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const f of MIGRATIONS) {
      await client.query(readFileSync(resolve(__dirname, "../supabase/migrations", f), "utf8"));
      console.log(`✓ Applied ${f}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
