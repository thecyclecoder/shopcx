/**
 * Apply the PDP-refinement-pass migrations (spec: pdp-refinement-pass, P1):
 *   1. 20260620130000_before_after_stories.sql — add product_page_content.before_after_stories JSONB
 *   2. 20260620140000_split_trust_pills.sql     — one-time split of comma-joined products.certifications / allergen_free
 *
 * Both are idempotent (IF NOT EXISTS / IS DISTINCT FROM guards), so re-running is safe.
 *
 *   npx tsx scripts/apply-pdp-refinement-migrations.ts
 */
import "./_bootstrap"; // loads .env.local locally; no-op on the box
import { readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

const password = process.env.SUPABASE_DB_PASSWORD!;
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;

const MIGRATIONS = [
  "20260620130000_before_after_stories.sql",
  "20260620140000_split_trust_pills.sql",
];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      const sql = readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8");
      await c.query(sql);
      console.log(`✓ applied ${file}`);
    }
    console.log("\n✓ all pdp-refinement migrations applied");
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
