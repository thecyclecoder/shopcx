// apply-claude-health-migration — create the claude_health singleton breaker table + add
// error_events.outage_correlated (docs/brain/specs/agent-outage-resilience.md, Phase 2). The
// Claude-down circuit-breaker's shared state, read by both Vercel/Inngest and the build box.
// Idempotent (CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
//   npx tsx scripts/apply-claude-health-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260703130000_claude_health_breaker.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select id, api_status, code_status, breaker_open from public.claude_health where id = 'singleton'",
    );
    console.log("✓ claude_health singleton:", rows);
    const { rows: col } = await c.query(
      "select column_name from information_schema.columns where table_name = 'error_events' and column_name = 'outage_correlated'",
    );
    console.log("✓ error_events.outage_correlated present:", col.map((r) => r.column_name));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
