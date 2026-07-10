// apply-reenable-assisted-purchase-playbooks-migration — Fix 1 (Phase 6) of
// docs/brain/specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol.md.
//
// Applies supabase/migrations/20261011120000_reenable_assisted_purchase_playbooks.sql
// against the shared Supabase and verifies the flip landed. Phase 4 shipped
// the migration + the session-chosen-only exclusion, but the pre-merge
// spec-test's DB probe found the 4 rows across the 2 workspaces still
// `is_active=false` — the migration was authored but never executed. This
// script runs it and prints the resulting row set (workspace_id, slug,
// name, is_active) so the founder can eyeball the flip before signing off.
//
// Safe: the migration is a compare-and-set `UPDATE ... SET is_active=true
// WHERE is_active=false` — a re-run on an already-flipped row is a no-op.
// The session-chosen-only exclusion (Phase 4 in
// src/lib/playbook-executor.ts:matchPlaybook/matchPlaybookScored) makes
// over-fire impossible even with is_active=true, so the flip cannot
// re-introduce the over-triggering that got these playbooks manually
// deactivated in the first place.
//
//   npx tsx scripts/apply-reenable-assisted-purchase-playbooks-migration.ts

import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const ASSISTED_PURCHASE_SLUGS = [
  "assisted-order-purchase",
  "assisted-subscription-purchase",
] as const;

async function main() {
  const migrationPath = resolve(
    __dirname,
    "../supabase/migrations/20261011120000_reenable_assisted_purchase_playbooks.sql",
  );
  const sql = readFileSync(migrationPath, "utf8");

  const c = pgClient();
  await c.connect();
  try {
    // Snapshot BEFORE for the log — proves the pre-existing state matches the
    // pre-merge spec-test probe's finding (4 rows across the 2 workspaces, all
    // is_active=false).
    const { rows: before } = await c.query(
      `select workspace_id, slug, name, is_active
       from public.playbooks
       where slug = ANY($1::text[])
       order by workspace_id, slug`,
      [[...ASSISTED_PURCHASE_SLUGS]],
    );
    console.log(`BEFORE (${before.length} row(s)):`);
    for (const r of before) {
      console.log(`  ${r.workspace_id} · ${r.slug} · ${r.name} · is_active=${r.is_active}`);
    }

    await c.query(sql);

    // Verify AFTER — the exact predicate the pre-merge spec-test asserts on.
    const { rows: after } = await c.query(
      `select workspace_id, slug, name, is_active
       from public.playbooks
       where slug = ANY($1::text[])
       order by workspace_id, slug`,
      [[...ASSISTED_PURCHASE_SLUGS]],
    );
    console.log(`\nAFTER (${after.length} row(s)):`);
    for (const r of after) {
      console.log(`  ${r.workspace_id} · ${r.slug} · ${r.name} · is_active=${r.is_active}`);
    }

    const stillInactive = after.filter((r: { is_active: boolean }) => !r.is_active);
    if (stillInactive.length > 0) {
      console.error(
        `\n✗ ${stillInactive.length} row(s) still is_active=false after apply — the migration UPDATE didn't land as expected.`,
      );
      process.exit(1);
    }
    const activeCount = after.filter((r: { is_active: boolean }) => r.is_active).length;
    console.log(
      `\n✓ ${activeCount} row(s) now is_active=true — check 8b2b259c65b98924 (pre-merge spec-test DB probe) can flip pass on the next run.`,
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
