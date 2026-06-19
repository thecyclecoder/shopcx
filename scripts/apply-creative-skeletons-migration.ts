/**
 * Apply the creative_skeletons migration (winning-static-creative-finder Phase 1).
 *
 * Loads .env.local IF present (local dev). On the build box there is none — secrets
 * come from the process env (systemd EnvironmentFile). Run:
 *   npx tsx scripts/apply-creative-skeletons-migration.ts
 */
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

const MIGRATIONS = ["20260619220000_creative_skeletons.sql"];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      const sql = readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8");
      await c.query(sql);
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='creative_skeletons' and column_name in ('hook','mechanism_claim','proof','offer','dedup_key','advertiser')",
    );
    console.log(`✓ creative_skeletons skeleton columns present: ${rows[0].n === 6}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
