/** Apply one migration file directly against the pooler, then nudge PostgREST's schema cache. */
import { pgClient } from "./_bootstrap";
import { readFileSync } from "node:fs";

const FILE = process.argv[2];
if (!FILE) { console.error("usage: npx tsx scripts/_apply-migration.ts <path/to/migration.sql>"); process.exit(1); }

async function main() {
  const sql = readFileSync(FILE, "utf8");
  const c = pgClient();
  await c.connect();
  try {
    await c.query(sql);
    console.log(`✅ applied ${FILE}`);
    await c.query("notify pgrst, 'reload schema'");
    console.log("sent: notify pgrst, 'reload schema'");
  } finally {
    await c.end();
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
