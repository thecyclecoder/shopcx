/**
 * Recover a migration that failed at a step which cannot be resumed.
 *
 * `resume` deliberately never re-applies customer codes (re-adding a fixed-amount discount to a
 * contract that already carries it doubles it), so a contract whose CODES step failed outright can
 * never be finished by resuming — the codes are missing and always will be.
 *
 * The recovery is to throw the inert contract away and migrate again from scratch. Safe because
 * the customer is still billed by Appstle throughout: nothing of ours ever billed the half-built
 * contract, which is the entire reason `billing_source` stays on the old engine until verify.
 *
 *   npx tsx scripts/_remigrate-broken.ts <appstleContractId> [--apply]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { shopifySubscriptionAction, getSubscriptionContract } from "../src/lib/commerce/shopify-subscription-client";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RULE = "ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19";
const OLD = process.argv[2];
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();
  const { data: snap } = await admin.from("appstle_contract_snapshots")
    .select("migrated_to_contract_id, migration_completed_at")
    .eq("workspace_id", WS).eq("appstle_contract_id", OLD).single();
  if (!snap) throw new Error("no snapshot");
  if (snap.migration_completed_at) throw new Error("migration COMPLETED — refusing to touch it");
  const inert = String(snap.migrated_to_contract_id ?? "").replace("gid://shopify/SubscriptionContract/", "");
  if (!inert) throw new Error("no contract to discard");

  // Refuse if our mirror ever pointed at it — that would mean the swap DID happen.
  const { data: swapped } = await admin.from("subscriptions")
    .select("id").eq("workspace_id", WS).eq("shopify_contract_id", inert).maybeSingle();
  if (swapped) throw new Error(`subscriptions row points at ${inert} — this was swapped, not inert`);

  console.log(`old=${OLD}  inert contract=${inert}`);
  if (!APPLY) { console.log("dry run — pass --apply"); return; }

  const cancel = await shopifySubscriptionAction(WS, inert, "cancel");
  const after = await getSubscriptionContract(WS, inert);
  console.log(`cancel: ${cancel.success ? "ok" : cancel.error}  verified status=${after.contract?.status}`);
  if (after.contract?.status !== "CANCELLED") throw new Error("contract not cancelled — stopping before clearing the marker");

  // Only now clear the markers, so a failure above can never leave an uncancelled duplicate
  // invisible to the next run.
  const { error } = await admin.from("appstle_contract_snapshots")
    .update({ migrated_to_contract_id: null, migrated_at: null, migration_attempted_at: null })
    .eq("workspace_id", WS).eq("appstle_contract_id", OLD);
  if (error) throw new Error(`marker clear failed: ${error.message}`);
  console.log("markers cleared");

  const { loadPricingContext, executeMigration } = await import("../src/lib/commerce/shopify-subscription-migrate");
  const ctx = await loadPricingContext(WS, RULE);
  const r = await executeMigration(WS, OLD, ctx, { completeSwap: true });
  console.log(`re-migrate: ${r.ok ? `SWAPPED → ${r.newContractId}` : `✗ ${r.stage}: ${r.error}`}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e.message); process.exit(1); });
