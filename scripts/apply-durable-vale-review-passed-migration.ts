import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient, loadEnv } from "./_bootstrap";

loadEnv();
const MIGRATIONS = ["20260727170000_durable_vale_review_passed_and_claim_cooldown.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
  } finally {
    await c.end();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
