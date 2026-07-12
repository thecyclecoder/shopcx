// apply-director-cockpit-token-migration — director-sms-cockpit-per-director Phase 1.
//
// Adds the four cockpit-token columns to director_coach_threads so the /god/[token] surface
// can resolve a director-scoped token through the same 48-hex + sliding/absolute TTL discipline
// as Eve's cockpit, without ever granting god-mode env access. Additive + idempotent.
//
//   npx tsx scripts/apply-director-cockpit-token-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20261015120000_director_cockpit_token.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name='director_coach_threads' and column_name in ('cockpit_token','token_expires_at','absolute_expires_at','sms_notified_at') order by column_name",
    );
    console.log("✓ cockpit columns present:", rows.map((r) => r.column_name));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
