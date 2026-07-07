// apply-assisted-purchase-sonnet-prompt-migration — seed the sonnet_prompts
// routing rule that steers Sonnet to prefer the assisted-purchase playbook
// over a bare create_order / create_subscription direct_action
// (spec-assisted-purchase-playbook.md Phase 3). Idempotent via NOT EXISTS
// guard on (workspace_id, title).
//   npx tsx scripts/apply-assisted-purchase-sonnet-prompt-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

async function main() {
  const sql = readFileSync(
    resolve(__dirname, "../supabase/migrations/20260731140000_seed_assisted_purchase_sonnet_prompt.sql"),
    "utf8",
  );
  const c = pgClient();
  await c.connect();
  try {
    await c.query(sql);
    const { rows } = await c.query(
      `select workspace_id, category, title, enabled, sort_order
       from sonnet_prompts
       where title = 'Assisted purchase (prefer playbook over bare create)'
       order by workspace_id`,
    );
    console.log(`✓ seeded ${rows.length} assisted-purchase sonnet_prompts row(s)`);
    for (const r of rows) {
      console.log(`  ${r.workspace_id} · ${r.category} · enabled=${r.enabled} · sort_order=${r.sort_order}`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
