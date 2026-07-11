/**
 * Seed the workspace's portal_config.suppressed_variant_ids with the
 * Strawberry Lemonade Superfood Tabs variant (42614433480877 / SC-TABS-SL-2).
 *
 * Implements Phase 1 of docs/brain/specs/suppress-strawberry-lemonade-
 * superfood-tabs.md — a crisis availability lever: SL is IN STOCK but must
 * not be selectable as a swap/add/change-flavor target from the portal so
 * we preserve inventory for existing SL renewers. The code guard is in
 * [[../src/lib/portal/mutation-guard.ts]] (getSuppressedVariantIds +
 * assertNewVariantsSelectable); this script writes the config the guard
 * reads.
 *
 * Idempotent — merges with any existing suppressed_variant_ids entry
 * (Mixed Berry today is suppressed via inventory_quantity=0, not this set,
 * so nothing to merge yet). Existing SL subscription lines are UNTOUCHED.
 *
 *   npx tsx scripts/seed-suppress-strawberry-lemonade.ts
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";

const STRAWBERRY_LEMONADE_VARIANT_ID = "42614433480877";

async function main() {
  const admin = createAdminClient();

  // Find every workspace that has a product with this variant — this is
  // Superfoods today, but the script generalises so a future workspace-copy
  // (staging) inherits the same lever without editing the script.
  const { data: products } = await admin
    .from("products")
    .select("workspace_id, variants");
  if (!products) {
    console.error("Failed to load products");
    process.exit(1);
  }
  const workspaceIds = new Set<string>();
  for (const p of products) {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for (const v of variants as { id?: unknown }[]) {
      if (String(v.id ?? "") === STRAWBERRY_LEMONADE_VARIANT_ID) {
        if (p.workspace_id) workspaceIds.add(String(p.workspace_id));
        break;
      }
    }
  }

  if (!workspaceIds.size) {
    console.log("No workspace owns variant", STRAWBERRY_LEMONADE_VARIANT_ID, "— nothing to do.");
    return;
  }

  for (const wsId of workspaceIds) {
    const { data: ws } = await admin
      .from("workspaces")
      .select("portal_config")
      .eq("id", wsId)
      .single();
    const cfg = (ws?.portal_config as Record<string, unknown> | null) || {};
    const current = Array.isArray(cfg.suppressed_variant_ids) ? cfg.suppressed_variant_ids : [];
    const merged = Array.from(new Set([...current.map(String), STRAWBERRY_LEMONADE_VARIANT_ID]));
    if (merged.length === current.length) {
      console.log(`workspace ${wsId}: already suppressed — skipped`);
      continue;
    }
    const nextCfg = { ...cfg, suppressed_variant_ids: merged };
    const { error } = await admin
      .from("workspaces")
      .update({ portal_config: nextCfg })
      .eq("id", wsId);
    if (error) {
      console.error(`workspace ${wsId}: update failed —`, error.message);
      process.exit(1);
    }
    console.log(`workspace ${wsId}: added ${STRAWBERRY_LEMONADE_VARIANT_ID} → suppressed_variant_ids=[${merged.join(", ")}]`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
