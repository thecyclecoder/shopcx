/**
 * Apply the competitors table migration (docs/brain/specs/competitor-scout.md, Phase 1).
 *
 *   npx tsx scripts/apply-competitors-migration.ts
 *
 * Creates public.competitors and migrates the 11 hardcoded COMPETITOR_SEEDS → approved rows
 * for every ad-tool workspace. Idempotent (create-if-not-exists + ON CONFLICT DO NOTHING).
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
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    const sql = readFileSync(
      resolve(__dirname, "../supabase/migrations/20260623120000_competitors.sql"),
      "utf8",
    );
    await c.query(sql);
    console.log("✓ applied 20260623120000_competitors.sql");

    const { rows } = await c.query(
      "select status, count(*)::int as n from public.competitors group by status order by status",
    );
    console.log("competitors by status:", rows);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
