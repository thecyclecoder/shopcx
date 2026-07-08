// apply-ticket-directions-journey-path-migration — extend the
// public.ticket_direction_path enum with the fourth value 'journey' so Sol's Direction can name
// the specific matched journey slug on the Direction (chosen_path='journey' + plan.journey_slug).
//
// Phase 1 of docs/brain/specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta.md.
// Idempotent (ADD VALUE IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-ticket-directions-journey-path-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261004120000_ticket_directions_journey_path.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    const { rows: enumVals } = await c.query(
      `select unnest(enum_range(NULL::public.ticket_direction_path))::text as v`,
    );
    const vals = enumVals.map((r) => r.v).sort();
    const want = ["journey", "needs_info", "playbook", "stateless"];
    if (JSON.stringify(vals) !== JSON.stringify(want)) {
      throw new Error(
        `ticket_direction_path enum values mismatch: got ${JSON.stringify(vals)} want ${JSON.stringify(want)}`,
      );
    }
    console.log(`✓ ticket_direction_path enum values: ${vals.join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
