// apply-add-payment-method-journey-migration — seed the add-payment-method
// journey definition per workspace (spec-add-payment-method-journey.md Phase 1).
// Idempotent via NOT EXISTS guard.
//   npx tsx scripts/apply-add-payment-method-journey-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

async function main() {
  const sql = readFileSync(
    resolve(__dirname, "../supabase/migrations/20260707000000_seed_add_payment_method_journey.sql"),
    "utf8",
  );
  const c = pgClient();
  await c.connect();
  try {
    await c.query(sql);
    const { rows } = await c.query(
      `select workspace_id, slug, trigger_intent from journey_definitions
       where slug = 'add-payment-method'
       order by workspace_id`,
    );
    console.log(`✓ seeded ${rows.length} add-payment-method row(s)`);
    for (const r of rows) console.log(`  ${r.workspace_id} · ${r.slug} · ${r.trigger_intent}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
