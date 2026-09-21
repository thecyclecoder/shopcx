/**
 * Set `last_payment_status='failed'` on subs sitting in an OPEN dunning cycle.
 *
 * The shopcx renewal worker only ever wrote `last_payment_status` on success, so a sub whose card
 * declined kept advertising `succeeded` from its previous cycle — on the dashboard badge, the
 * portal, and every CS surface the orchestrator reads. Measured 2026-09-21: 36065771693 mid-dunning
 * with a declined card and a row reading `succeeded`.
 *
 * Idempotent, and scoped to cycles that are still OPEN — a recovered or closed cycle legitimately
 * ends with a successful charge and must not be rewritten.
 *
 *   npx tsx scripts/_backfill-dunning-row-status.ts [--apply]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const APPLY = process.argv.includes("--apply");
const OPEN = ["active", "rotating", "retrying", "skipped", "paused"];

async function main() {
  const admin = createAdminClient();
  const { data: cycles } = await admin
    .from("dunning_cycles")
    .select("subscription_id, shopify_contract_id, status, workspace_id")
    .in("status", OPEN)
    .not("subscription_id", "is", null);
  console.log(`open dunning cycles: ${cycles?.length ?? 0}`);

  let fixed = 0;
  for (const c of cycles ?? []) {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, shopify_contract_id, billing_source, last_payment_status")
      .eq("id", c.subscription_id as string).maybeSingle();
    if (!sub || sub.last_payment_status === "failed") continue;
    console.log(`  ${sub.shopify_contract_id} (${sub.billing_source}) ${sub.last_payment_status} → failed   [cycle ${c.status}]`);
    if (APPLY) {
      const { error } = await admin.from("subscriptions")
        .update({ last_payment_status: "failed", updated_at: new Date().toISOString() })
        .eq("id", sub.id);
      if (error) console.error(`    ✗ ${error.message}`); else fixed++;
    }
  }
  console.log(APPLY ? `\n${fixed} row(s) corrected` : "\ndry run — pass --apply to write");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
