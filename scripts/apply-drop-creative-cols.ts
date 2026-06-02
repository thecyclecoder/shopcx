import { readFileSync } from "fs"; import { resolve } from "path"; import { Client } from "pg";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const password = process.env.SUPABASE_DB_PASSWORD!;
const host = process.env.SUPABASE_DB_HOST || "aws-1-us-east-1.pooler.supabase.com";
const PROJECT_REF = "urjbhjbygyxffrfkarqn";
const cs = `postgres://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@${host}:6543/postgres`;
const sql = readFileSync(resolve(__dirname, "../supabase/migrations/20260602230000_drop_meta_post_cache_creative_cols.sql"), "utf8");
async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try { await c.query(sql); console.log("✓ applied"); } finally { await c.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
