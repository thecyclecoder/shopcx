// apply-ticket-resolution-events-clarified-migration — add 'clarified' to the
// ticket_resolution_events.verified_outcome CHECK (Phase 2 of
// docs/brain/specs/confidence-gated-problem-lockin-and-selective-clarify.md).
// Idempotent (DROP CONSTRAINT IF EXISTS + DO-block re-add). Run against the pooler:
//   npx tsx scripts/apply-ticket-resolution-events-clarified-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260707120001_ticket_resolution_events_verified_outcome_clarified.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    const { rows } = await c.query(
      `select pg_get_constraintdef(oid) as def
         from pg_constraint
        where conname='ticket_resolution_events_verified_outcome_check'`,
    );
    if (rows.length === 0) throw new Error("verified_outcome CHECK missing after migration");
    const def = String(rows[0].def);
    if (!def.includes("'clarified'")) {
      throw new Error(`CHECK does not include 'clarified': ${def}`);
    }
    console.log(`✓ ${def}`);
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
