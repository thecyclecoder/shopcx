/**
 * wire-starter-kit-offer — Phase 4 of offer-creator (Superfoods Starter Kit).
 *
 * Idempotent seed. Given the constants below (workspace + primary product +
 * frother/mug/e-guide refs), creates or updates:
 *
 *   1. The Starter Kit product_variants row (an intro-priced SKU on the
 *      primary product — inherits the primary's pricing rule so quantity-
 *      break × S&S naturally lands its renewal near ~$59.95, per the spec).
 *   2. The $10 fixed_amount coupon with recurring_cycle_limit=1 (fires on
 *      the first order only; renewal engine consumes the counter and stops).
 *   3. The offer row anchored on the Starter Kit variant with the three
 *      included items (frother + mug = physical, e-guide = digital),
 *      scope='checkout_only' (default) and overrides_pricing_rule_gifts=true.
 *   4. Points `products.bundle_variant_id` at the Starter Kit variant and
 *      `products.bundle_coupon_code` at the coupon code — the bundle PDP's
 *      Select Bundle CTA (Phase 4 code) reads both.
 *
 * Fill in the FIVE production ids at the top before running. Every write is
 * an upsert keyed by the natural unique index (sku for the variant, code for
 * the coupon, (workspace_id, variant_id) for the offer), so re-runs after a
 * partial success are safe.
 *
 * ⚠️ This script MUTATES production and requires approval to run.
 * ⚠️ Run the accompanying migration first:
 *      npx tsx scripts/apply-products-bundle-variant-and-coupon-migration.ts
 *
 * Run:
 *   npx tsx scripts/wire-starter-kit-offer.ts
 */
import { createAdminClient } from "./_bootstrap";

// ── Fill these before running ──────────────────────────────────────────
// (Query the DB with `probe-db` to confirm each id belongs to the target
// workspace and matches the intended product / variant / digital good.)
const WORKSPACE_ID = "REPLACE_ME_WORKSPACE_ID";
const PRIMARY_PRODUCT_ID = "REPLACE_ME_PRIMARY_PRODUCT_ID"; // The product whose bundle PDP renders this Starter Kit
const FROTHER_VARIANT_ID = "REPLACE_ME_FROTHER_VARIANT_ID"; // physical include #1
const MUG_VARIANT_ID = "REPLACE_ME_MUG_VARIANT_ID";         // physical include #2
const EGUIDE_DIGITAL_GOOD_ID = "REPLACE_ME_EGUIDE_DIGITAL_GOOD_ID"; // digital include

// ── Configuration knobs (safe defaults) ────────────────────────────────
const STARTER_KIT_SKU = "SF-STARTER-KIT";
const STARTER_KIT_TITLE = "Starter Kit";
const STARTER_KIT_PRICE_CENTS = 7995; // MSRP shown on the bundle PDP; S&S % (25%) → ~59.96 renewal
const COUPON_CODE = "STARTERKIT10";
const COUPON_VALUE_CENTS = 1000; // $10 off first order
const COUPON_RECURRING_CYCLE_LIMIT = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  for (const [k, v] of Object.entries({
    WORKSPACE_ID,
    PRIMARY_PRODUCT_ID,
    FROTHER_VARIANT_ID,
    MUG_VARIANT_ID,
    EGUIDE_DIGITAL_GOOD_ID,
  })) {
    if (!UUID_RE.test(v)) {
      throw new Error(
        `${k} is not a UUID — fill in the real id at the top of this script before running.`,
      );
    }
  }

  const admin = createAdminClient();

  // ── 1. Starter Kit product_variants row ─────────────────────────
  // Upsert by workspace-scoped sku so a re-run heals price / title drift.
  const { data: existingVariant } = await admin
    .from("product_variants")
    .select("id, price_cents, title")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("sku", STARTER_KIT_SKU)
    .maybeSingle();

  let starterKitVariantId: string;
  if (existingVariant?.id) {
    starterKitVariantId = existingVariant.id as string;
    // Compare-and-set: only overwrite when the intended fields drifted so a
    // hand-tuned price stamped by the founder in the admin doesn't get
    // reverted by a re-run of this script.
    if (
      (existingVariant.price_cents as number) !== STARTER_KIT_PRICE_CENTS ||
      (existingVariant.title as string) !== STARTER_KIT_TITLE
    ) {
      const { error, data } = await admin
        .from("product_variants")
        .update({
          title: STARTER_KIT_TITLE,
          price_cents: STARTER_KIT_PRICE_CENTS,
        })
        .eq("id", starterKitVariantId)
        .eq("workspace_id", WORKSPACE_ID)
        .select("id");
      if (error) throw new Error(`variant update failed: ${error.message}`);
      if (!data || data.length !== 1) {
        throw new Error(`variant compare-and-set matched ${data?.length ?? 0} rows — bailing`);
      }
    }
    console.log(`✓ Starter Kit variant present (${starterKitVariantId})`);
  } else {
    const { data: inserted, error } = await admin
      .from("product_variants")
      .insert({
        workspace_id: WORKSPACE_ID,
        product_id: PRIMARY_PRODUCT_ID,
        sku: STARTER_KIT_SKU,
        title: STARTER_KIT_TITLE,
        price_cents: STARTER_KIT_PRICE_CENTS,
        position: 100, // sits after the base variants; the bundle PDP CTA points here explicitly
        available: true,
      })
      .select("id")
      .single();
    if (error || !inserted?.id) {
      throw new Error(`variant insert failed: ${error?.message || "no id"}`);
    }
    starterKitVariantId = inserted.id as string;
    console.log(`✓ Starter Kit variant created (${starterKitVariantId})`);
  }

  // ── 2. $10 recurring_cycle_limit=1 coupon ───────────────────────
  const { data: existingCoupon } = await admin
    .from("coupons")
    .select("id, type, value, recurring_cycle_limit")
    .eq("workspace_id", WORKSPACE_ID)
    .ilike("code", COUPON_CODE)
    .maybeSingle();

  if (existingCoupon?.id) {
    if (
      existingCoupon.type !== "fixed_amount" ||
      (existingCoupon.value as number) !== COUPON_VALUE_CENTS ||
      (existingCoupon.recurring_cycle_limit as number | null) !== COUPON_RECURRING_CYCLE_LIMIT
    ) {
      const { data, error } = await admin
        .from("coupons")
        .update({
          type: "fixed_amount",
          value: COUPON_VALUE_CENTS,
          recurring_cycle_limit: COUPON_RECURRING_CYCLE_LIMIT,
          scope: "order",
        })
        .eq("id", existingCoupon.id as string)
        .eq("workspace_id", WORKSPACE_ID)
        .select("id");
      if (error) throw new Error(`coupon update failed: ${error.message}`);
      if (!data || data.length !== 1) {
        throw new Error(`coupon compare-and-set matched ${data?.length ?? 0} rows — bailing`);
      }
    }
    console.log(`✓ ${COUPON_CODE} coupon present`);
  } else {
    const { error } = await admin.from("coupons").insert({
      workspace_id: WORKSPACE_ID,
      code: COUPON_CODE,
      type: "fixed_amount",
      value: COUPON_VALUE_CENTS,
      scope: "order",
      recurring_cycle_limit: COUPON_RECURRING_CYCLE_LIMIT,
      single_use: false,
    });
    if (error) throw new Error(`coupon insert failed: ${error.message}`);
    console.log(`✓ ${COUPON_CODE} coupon created`);
  }

  // ── 3. Offer anchored on the Starter Kit variant ────────────────
  const included = [
    { ref_id: FROTHER_VARIANT_ID, kind: "physical" as const, quantity: 1 },
    { ref_id: MUG_VARIANT_ID, kind: "physical" as const, quantity: 1 },
    { ref_id: EGUIDE_DIGITAL_GOOD_ID, kind: "digital" as const, quantity: 1 },
  ];

  const { data: existingOffer } = await admin
    .from("offers")
    .select("id")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("variant_id", starterKitVariantId)
    .maybeSingle();

  if (existingOffer?.id) {
    const { data, error } = await admin
      .from("offers")
      .update({
        name: STARTER_KIT_TITLE,
        included,
        scope: "checkout_only",
        overrides_pricing_rule_gifts: true,
        is_active: true,
      })
      .eq("id", existingOffer.id as string)
      .eq("workspace_id", WORKSPACE_ID)
      .select("id");
    if (error) throw new Error(`offer update failed: ${error.message}`);
    if (!data || data.length !== 1) {
      throw new Error(`offer compare-and-set matched ${data?.length ?? 0} rows — bailing`);
    }
    console.log(`✓ Starter Kit offer present (${existingOffer.id})`);
  } else {
    const { data, error } = await admin
      .from("offers")
      .insert({
        workspace_id: WORKSPACE_ID,
        variant_id: starterKitVariantId,
        name: STARTER_KIT_TITLE,
        included,
        scope: "checkout_only",
        overrides_pricing_rule_gifts: true,
        is_active: true,
      })
      .select("id")
      .single();
    if (error || !data?.id) {
      throw new Error(`offer insert failed: ${error?.message || "no id"}`);
    }
    console.log(`✓ Starter Kit offer created (${data.id})`);
  }

  // ── 4. Stamp the product's bundle_variant_id + bundle_coupon_code ─
  const { data: stamped, error: stampErr } = await admin
    .from("products")
    .update({
      bundle_variant_id: starterKitVariantId,
      bundle_coupon_code: COUPON_CODE,
    })
    .eq("id", PRIMARY_PRODUCT_ID)
    .eq("workspace_id", WORKSPACE_ID)
    .select("id");
  if (stampErr) throw new Error(`product stamp failed: ${stampErr.message}`);
  if (!stamped || stamped.length !== 1) {
    throw new Error(
      `product compare-and-set matched ${stamped?.length ?? 0} rows (expected 1) — bailing`,
    );
  }
  console.log(`✓ products.bundle_variant_id + bundle_coupon_code stamped`);

  console.log("");
  console.log("Phase 4 wiring done. Verify:");
  console.log(`  - bundle PDP:      /store/<slug>/<handle>?variant=bundle&name=starterkit`);
  console.log(`  - reasons-lander:  /store/<slug>/<handle>?variant=reasons  (its offer CTA links to the bundle PDP)`);
  console.log(`  - Add to cart from either → the offer's frother + mug + e-guide attach as $0 lines,`);
  console.log(`    the $10 coupon lands, renewal ships only the paid Starter Kit variant.`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
