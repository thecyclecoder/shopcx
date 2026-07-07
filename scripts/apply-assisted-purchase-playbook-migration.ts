// apply-assisted-purchase-playbook-migration — seed the assisted-purchase
// playbooks (spec-assisted-purchase-playbook.md Phase 2): extend the
// playbook_steps.type CHECK constraint (additive — retains every existing
// type in prod today), then insert two per-workspace playbooks + their
// two-step rows ('Assisted Order Purchase' / 'Assisted Subscription
// Purchase'). Idempotent via NOT EXISTS guards on both playbooks and
// every step insert.
//   npx tsx scripts/apply-assisted-purchase-playbook-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

async function main() {
  const sql = readFileSync(
    resolve(__dirname, "../supabase/migrations/20260707150000_seed_assisted_purchase_playbook.sql"),
    "utf8",
  );
  const c = pgClient();
  await c.connect();
  try {
    await c.query(sql);
    const { rows: playbooks } = await c.query(
      `select p.workspace_id, p.name, count(s.id)::int as step_count
       from playbooks p
       left join playbook_steps s on s.playbook_id = p.id
       where p.name in ('Assisted Order Purchase', 'Assisted Subscription Purchase')
       group by p.workspace_id, p.name
       order by p.workspace_id, p.name`,
    );
    console.log(`✓ seeded ${playbooks.length} assisted-purchase playbook row(s)`);
    for (const r of playbooks) {
      console.log(`  ${r.workspace_id} · ${r.name} · ${r.step_count} step(s)`);
    }
    const { rows: steps } = await c.query(
      `select p.name, s.step_order, s.type, s.name as step_name
       from playbook_steps s
       join playbooks p on p.id = s.playbook_id
       where p.name in ('Assisted Order Purchase', 'Assisted Subscription Purchase')
       order by p.workspace_id, p.name, s.step_order`,
    );
    for (const r of steps) {
      console.log(`  [${r.name} #${r.step_order}] ${r.type} — ${r.step_name}`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
