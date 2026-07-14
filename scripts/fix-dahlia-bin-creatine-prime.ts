/**
 * ads-supervisor fix — Dahlia's ready-to-test bin is thin (2/4) for product
 * `658f8c0c-944e-4744-a26a-51a484f788e8` ("Creatine Prime+"). See
 * `.box/spec-ads-supervisor-fix-fdc11e10-dahlia-bin-658f8c0c-944e-4744-a26a-51a484f788e8.md`.
 *
 * The bin below the DEFAULT_BIN_FLOOR of 4 has two possible causes:
 *   (1) product_ad_angles is empty → the ad-creative-cadence cron never enqueues
 *       Dahlia for this product (`src/lib/inngest/ad-creative-cadence.ts:78-89`
 *       filters candidates to products with ≥1 angle row).
 *   (2) angles exist AND Dahlia is being dispatched but `runAdCreativeJob` is
 *       failing before the ad_campaigns insert.
 *
 * This script diagnoses which and applies the SMALLER fix:
 *   - empty angles + is_advertised=true → `generateAngles(productId)` (the
 *     intelligence-fill fix; unblocks the cron for the next tick).
 *   - angles exist but no recent dispatch → nothing to do here (this is a
 *     cron/dispatch bug that needs its own fix-spec).
 *   - angles + dispatch + still-thin → nothing to do here (Dahlia's
 *     runAdCreativeJob is failing; that's a separate spec).
 *
 * Usage:
 *   npx tsx scripts/fix-dahlia-bin-creatine-prime.ts           # dry-run diagnose
 *   npx tsx scripts/fix-dahlia-bin-creatine-prime.ts --apply   # apply the fix
 */
import { createAdminClient } from "./_bootstrap";

const PRODUCT_ID = "658f8c0c-944e-4744-a26a-51a484f788e8";
const DEFAULT_BIN_FLOOR = 4;
const LOOKBACK_HOURS = 24;

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  // (0) Confirm the product exists + get workspace + advertising gate.
  const { data: product, error: prodErr } = await admin
    .from("products")
    .select("id, workspace_id, title, is_advertised")
    .eq("id", PRODUCT_ID)
    .maybeSingle();
  if (prodErr) throw new Error(`products read failed: ${prodErr.message}`);
  if (!product) throw new Error(`product ${PRODUCT_ID} not found`);
  const workspaceId = product.workspace_id as string;
  console.log(
    `product id=${PRODUCT_ID} title=${JSON.stringify(product.title)} ` +
      `workspace=${workspaceId} is_advertised=${product.is_advertised}`,
  );
  if (!product.is_advertised) {
    console.log("→ product is not advertised — Dahlia's cadence intentionally skips it. Nothing to fix.");
    return;
  }

  // (1) Read recent ad-creative dispatches for this product.
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();
  const { data: jobs, error: jobsErr } = await admin
    .from("agent_jobs")
    .select("id, status, created_at, instructions")
    .eq("workspace_id", workspaceId)
    .eq("kind", "ad-creative")
    .gte("created_at", sinceIso);
  if (jobsErr) throw new Error(`agent_jobs read failed: ${jobsErr.message}`);
  const productJobs = (jobs ?? []).filter((j) => {
    if (!j.instructions) return false;
    try {
      const parsed = JSON.parse(j.instructions) as { product_id?: unknown };
      return typeof parsed?.product_id === "string" && parsed.product_id === PRODUCT_ID;
    } catch {
      return false;
    }
  });
  console.log(`ad-creative jobs (last ${LOOKBACK_HOURS}h) for this product: ${productJobs.length}`);
  for (const j of productJobs) console.log(`  · id=${j.id} status=${j.status} created=${j.created_at}`);

  // (2) Read product_ad_angles for this workspace + product.
  const { data: angles, error: angErr } = await admin
    .from("product_ad_angles")
    .select("id, is_active, hook_slug, generated_by, created_at")
    .eq("workspace_id", workspaceId)
    .eq("product_id", PRODUCT_ID);
  if (angErr) throw new Error(`product_ad_angles read failed: ${angErr.message}`);
  const activeAngles = (angles ?? []).filter((a) => a.is_active);
  console.log(`product_ad_angles: total=${(angles ?? []).length} active=${activeAngles.length}`);

  // (3) Read current ready-to-test bin depth for this product (confirm the drift is still real).
  const { data: campaigns, error: campErr } = await admin
    .from("ad_campaigns")
    .select("id, status, created_at")
    .eq("workspace_id", workspaceId)
    .eq("product_id", PRODUCT_ID)
    .eq("status", "ready");
  if (campErr) throw new Error(`ad_campaigns read failed: ${campErr.message}`);
  const depth = (campaigns ?? []).length;
  console.log(`ready-to-test ad_campaigns rows for this product: depth=${depth} floor=${DEFAULT_BIN_FLOOR}`);

  // (4) Decide the smaller fix.
  if (depth >= DEFAULT_BIN_FLOOR) {
    console.log("→ bin has recovered to the floor — nothing to fix. (Drift may have self-healed since the supervisor's pass.)");
    return;
  }
  if (activeAngles.length === 0) {
    console.log(
      `→ intelligence-fill fix: product_ad_angles is empty. ` +
        `The ad-creative-cadence cron never enqueues Dahlia without ≥1 angle row.`,
    );
    if (!apply) {
      console.log("   (dry-run — re-run with --apply to call generateAngles).");
      return;
    }
    const { generateAngles } = await import("../src/lib/ad-angles");
    const res = await generateAngles(PRODUCT_ID);
    console.log(
      `generateAngles: ok=${res.ok} inserted=${res.inserted.length} rejected=${res.rejected.length}` +
        `${res.reason ? " reason=" + res.reason : ""}`,
    );
    if (!res.ok) {
      process.exitCode = 1;
      return;
    }
    console.log(
      "→ intelligence-fill applied. The next ad-creative-cadence cron tick (0 11 * * * UTC) will enqueue Dahlia " +
        "for this product and refill the bin.",
    );
    return;
  }
  if (productJobs.length === 0) {
    console.log(
      `→ dispatch gap: angles=${activeAngles.length} exist but no ad-creative job was enqueued in the last ${LOOKBACK_HOURS}h. ` +
        `The ad-creative-cadence cron isn't dispatching for this product — likely a workspace/advertised-product misconfiguration. ` +
        `Not fixable from this script; a follow-up spec is needed.`,
    );
    return;
  }
  console.log(
    `→ Dahlia failure: angles=${activeAngles.length}, ${productJobs.length} recent dispatch(es), but the bin is still thin. ` +
      `Dahlia's runAdCreativeJob is failing before the ad_campaigns insert — not fixable from this script; ` +
      `inspect the failed job(s) above and file a follow-up spec.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
