// apply-retire-skip-next-order-routing-rule-migration — seed the sonnet_prompts
// (category='rule') row that instructs the Sonnet orchestrator to alias
// skip-next-order intents to change_next_date / bill_now, per workspace.
// Spec: docs/brain/specs/retire-skip-next-order-action-type-with-shadow-measured-alias
// (Phase 2). Idempotent: guarded by title uniqueness inside the migration.
//
// Run against the pooler:
//   npx tsx scripts/apply-retire-skip-next-order-routing-rule-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260917120000_retire_skip_next_order_routing_rule.sql";
const RULE_TITLE = "Retire skip_next_order — alias to change_next_date / bill_now";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);

    const { rows } = await c.query(
      `select workspace_id, category, enabled, status
         from sonnet_prompts
        where title = $1
        order by workspace_id`,
      [RULE_TITLE],
    );
    console.log(`✓ sonnet_prompts rows with the rule: ${rows.length}`);
    for (const r of rows) {
      console.log(
        `    workspace_id=${r.workspace_id}  category=${r.category}  enabled=${r.enabled}  status=${r.status}`,
      );
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
