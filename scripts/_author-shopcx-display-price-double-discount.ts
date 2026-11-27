/**
 * Throwaway author script (found 2026-11-27 from a customer reply to the renewal reminder). Idempotent on slug.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
import { getSpec } from "../src/lib/specs-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "shopcx-display-price-double-discount";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    SLUG,
    {
      title: "Displayed totals for ShopCX-billed subs take Subscribe & Save off twice",
      why:
        "A customer replied to her renewal reminder asking why the email said $29.28 while the page listed $52.46; her real charge is about $45.17 (same as her last three orders). On ShopCX/Appstle-shape subs the stored line price is already after Subscribe & Save, and the display calculator applies the subscription's discount entries again. " +
        "64 of 70 reminded subs showed a total more than $1 below their last paid order (median gap ~$35, up to $163). The same wrong total shows in the Portal and the next-order journey. Billing is not affected; only displayed numbers are.",
      what:
        "For subscriptions whose line prices are baked (non-internal), the displayed total only subtracts discounts that are NOT already reflected in the line price (for example a one-off loyalty coupon), and duplicate discount entries are counted once. The reminder amount, the next-order journey total and the Portal total then match what Shopify will charge (before tax).",
      summary:
        "Fix computeDisplayCoupon / priceSubscription non-internal branch in src/lib/commerce/price.ts; callers (src/lib/pre-renewal-reminders.ts reminderChargePreview, src/lib/next-order-journey-builder.ts, Portal enrich-pricing) inherit the fix.",
      owner: "retention",
      parent: '[[../functions/retention]] — "Subscription continuity & billing integrity" mandate: customers must see the price they will be charged.',
      blocked_by: [],
      human_review: "Spot-check 5 ShopCX subs in the Portal: displayed total (+ tax) equals the last paid renewal order.",
      phases: [
        {
          title: "Phase 1 — Stop re-applying baked discounts on non-internal subs",
          why: "One shared calculator feeds the reminder, journey and Portal, so fixing it once fixes every surface.",
          what: "Non-internal subs: discounts already baked into price_cents (Subscribe & Save, quantity/volume breaks, any subscription-level automatic discount) are not subtracted again; only discounts Shopify applies on top of line prices (coupon codes, loyalty, fixed-amount credits) are; duplicate applied_discounts entries are de-duplicated.",
          body: [
            "In src/lib/commerce/price.ts the non-internal branch sums `items[].price_cents` (already post-S&S, see src/lib/commerce/shopcx-line-ops.ts writes) then calls computeDisplayCoupon over ALL `applied_discounts`, re-applying S&S/volume discounts. Probe real `subscriptions.applied_discounts` shapes on ShopCX-engine subs (probe-db skill) to classify which entries are baked vs on-top — use the Shopify contract's discount allocation semantics (contract line `currentPrice` already includes subscription-plan pricing policies; contract `discounts` with targetType LINE_ITEM/manual codes apply on top). Ground truth: a sub with list $69.95, stored line $52.46, a $15 loyalty coupon and $4.95 shipping must total $42.41 pre-tax (customer's real charge $45.17 incl. tax).",
            "Add `isBakedIntoLinePrice(discount)` and de-dupe entries by id/code before applying. Keep the internal branch unchanged.",
            "Add src/lib/commerce/price.double-discount.test.ts with that ground-truth case + a duplicated-entry case, registered as package.json script `test:price-double-discount`. Run existing price tests (price.freeship.test.ts).",
            "Audit script (read-only, scripts/_audit-shopcx-display-vs-last-order.ts) comparing displayed total vs last paid renewal order for active ShopCX subs; report the distribution in the PR body.",
            "Update docs/brain/libraries/commerce__price.md (or the existing commerce price page) with the baked-vs-on-top rule.",
          ].join("\n"),
          verification: ["- tsc clean.", "- isBakedIntoLinePrice present in price.ts.", "- test:pre-renewal-reminders passes."].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "baked-discount rule exists", kind: "auto", exec_kind: "grep", params: { pattern: "isBakedIntoLinePrice", path: "src/lib/commerce/price.ts", expect: "present" } },
            { position: 3, description: "regression test added", kind: "auto", exec_kind: "grep", params: { pattern: "6995", path: "src/lib/commerce/price.double-discount.test.ts", expect: "present" } },
            { position: 4, description: "test:pre-renewal-reminders passes", kind: "auto", exec_kind: "unit_test", params: { script: "test:pre-renewal-reminders" } },
          ],
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "retention#billing-integrity" },
  );
  console.log(ok ? "authored" : "author write failed");
  const s = await getSpec(WORKSPACE_ID, SLUG);
  console.log(JSON.stringify({ slug: s?.slug, status: (s as { status?: string } | null)?.status }, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
