/**
 * Authors the orders-classification-sdk spec into public.specs via the specs-table SDK
 * (never a docs/brain/specs/*.md). Owner=growth, parented to the Media-buyer (Bianca)
 * mandate. Founder-directed 2026-07-15 — emerged from the purchaser-overlap measurement,
 * which had to hand-roll bucketOrder + first-vs-repeat + the UTM join. This makes it a
 * reusable chokepoint so nobody guesses first-vs-renewal again.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { upsertSpec } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "orders-classification-sdk";

const PARENT =
  '[[../functions/growth]] — "Media buyer (Bianca, under Max)" mandate: Bianca reads new-customer CPA vs LTV-breakeven to crown/kill/scale. Those decisions are only as good as the orders read underneath them — first-time vs repeat customer, checkout vs subscription renewal, across all three order sources. Today every caller hand-rolls that classification (the purchaser-overlap measurement had to), so a wrong predicate silently mis-buckets acquisition. This chokepoint SDK makes the read correct-by-construction. See [[../libraries/order-bucketing]] and [[../libraries/acquisition-roas]].';

async function main() {
  const res = await upsertSpec(
    WS,
    {
      slug: SLUG,
      title: "Orders classification SDK (source × checkout/renewal × first-vs-repeat × cart-type)",
      summary:
        "**Brain refs:** [[../libraries/order-bucketing]] (canonical classifier — REUSE, never re-implement) · [[../libraries/commerce__order]] (read chokepoint) · [[../libraries/customer-stats]] · [[../libraries/acquisition-roas]] · [[../tables/orders]]\n\nA thin, reusable read chokepoint that classifies any `orders` row on four orthogonal facets — **source** (shopify|internal|amazon), **origin** (checkout|renewal), **cartType** (subscription|one_time, checkout-only), **customerRecency** (first_time|repeat, checkout-only) — and a `queryOrders(ws, filters)` helper with first-class time-range filters. It COMPOSES the already-proven pieces (`bucketOrder`, `commerce/order.ts`, `customer-stats`); it does not re-derive renewal/subscription logic. Emerged because the purchaser-overlap measurement had to hand-roll all of this.",
      owner: "growth",
      parent: PARENT,
      parent_kind: "mandate",
      parent_ref: "growth#media-buyer-bianca-under-max",
      blocked_by: [],
      priority: null,
      deferred: false,
      intended_status: "planned",
      intended_status_set_by: "ceo:dylan",
      auto_build: true,
      milestone_id: null,
      related_spec: "growth-acquisition-roas-spine",
      why:
        "Every place that needs 'first-time vs renewal vs repeat-customer' currently hand-rolls it against raw orders columns (source_name/subscription_id/tags/order_type) — a wrong predicate silently mis-buckets acquisition (a renewal read as a new customer, or a subscriber's 2nd checkout mis-flagged). The canonical classifier bucketOrder already exists but there is no query wrapper that also splits first-time-vs-repeat customer or filters by a time range, so callers reinvent it (the purchaser-overlap measurement just did). One chokepoint SDK makes the read correct-by-construction across all three order sources.",
      what:
        "Adds src/lib/orders-classification.ts exporting (1) classifyOrder(order, {sourceMapping}) → {source, origin, cartType?, customerRecency?} that REUSES bucketOrder for origin/cartType and adds source discrimination + the first-vs-repeat customer axis, and (2) queryOrders(ws, {source?, origin?, cartType?, customerRecency?, since?, until?, lastDays?}) that composes commerce/order.ts reads + classifyOrder + customer-stats, paginating past the 1000-row cap. Ships with a brain page pointing at order-bucketing.md as the source of truth, and the purchaser-overlap measurement is refactored to consume it. Pure library (no cron/agent/tool) — no kill-switch/heartbeat trio required.",
    },
    [
      {
        position: 1,
        title: "Phase 1 — classifyOrder facets (reuse bucketOrder; add source + recency axes)",
        status: "planned",
        body:
          "Pure classifier over a single orders row. origin + cartType delegate to bucketOrder (the SoT); this phase adds source discrimination (shopify|internal|amazon) and the customerRecency slot (filled in Phase 2). Fixture-pinned so a bucketOrder drift or a source-tell change fails the build.",
        why:
          "The classification must be a single pure function everyone shares, and it must NOT re-derive renewal/subscription logic — that lives in bucketOrder and drift there would silently corrupt ROAS. It also needs the two facets bucketOrder doesn't cover: which of the 3 sources an order came from, and (for checkout orders) first-time vs repeat customer.",
        what:
          "Add classifyOrder(order, {sourceMapping}) returning {source:'shopify'|'internal'|'amazon', origin:'checkout'|'renewal', cartType?:'subscription'|'one_time', customerRecency?:'first_time'|'repeat'}. origin+cartType are delegated to bucketOrder (recurring/replacement → renewal; new_sub → subscription; one_time → one_time). source is discriminated from the documented tells (shopify_order_id / braintree_* / amplifier_* + source_name). customerRecency is left undefined here (needs a DB read — Phase 2 fills it) and defined ONLY for checkout origin. Pin with a vitest fixture table covering all three sources × renewal/checkout × sub/one_time.",
        verification:
          "vitest: `npx vitest run src/lib/orders-classification.test.ts` — asserts classifyOrder maps a curated fixture row-set to the expected {source,origin,cartType} for all 3 sources incl. internal_subscription_renewal → renewal and a bare storefront order → checkout/one_time. Plus a grep guard test asserting orders-classification.ts imports bucketOrder from ./order-bucketing and contains no inline `source_name.includes(\"subscription\")` re-derivation.",
      },
      {
        position: 2,
        title: "Phase 2 — queryOrders(ws, filters) with first-class time range + first-vs-repeat + pagination",
        status: "planned",
        body:
          "The query surface. Composes commerce/order.ts + classifyOrder + a batched prior-order count for customerRecency (renewals included). Time range (since/until/lastDays) and all four facets are AND-composable filters; pagination is handled internally so no caller re-hits the 1000-row cap.",
        why:
          "Callers want to ask for exactly a slice ('internal first-time-customer one-time checkouts, last 30d') without touching raw columns or the 1000-row cap. The first-time-vs-repeat axis must use the accepted convention — ANY prior order (renewals included) makes a customer repeat — matching customers.total_orders/first_order_at and the welcome-email path.",
        what:
          "Add queryOrders(ws, {source?, origin?, cartType?, customerRecency?, since?, until?, lastDays?}) → OrderRow[]. Composes commerce/order.ts reads (paginating past 1000), applies classifyOrder, and resolves customerRecency via a batched prior-order count (customer-stats / earliest-order-per-customer, renewals INCLUDED). Time range is first-class: since/until (ISO) or lastDays (rolling). Filters compose (AND). No raw .from bucket predicates leak to callers.",
        verification:
          "vitest: `npx vitest run src/lib/orders-classification.test.ts` — against a seeded/mocked set: queryOrders({origin:'renewal'}) returns only recurring rows; {customerRecency:'first_time'} excludes any customer with a prior order (renewal counted); {lastDays:N} and {since,until} bound results correctly; a >1000-row fixture proves pagination isn't truncated.",
      },
      {
        position: 3,
        title: "Phase 3 — brain page + refactor the overlap measurement onto the SDK",
        status: "planned",
        body:
          "Completeness + proof. Ships the brain page (SoT pointer to order-bucketing) and moves a real caller — the purchaser-overlap measurement — onto queryOrders/classifyOrder so the SDK is proven by use, not just written. The UTM→campaign attribution join stays in the caller (out of scope).",
        why:
          "A library without a brain page is incomplete, and the classification's source of truth must be unambiguous so future callers reuse (not re-derive). Proving the SDK by moving a real caller onto it guards against an API that looks right but doesn't compose.",
        what:
          "Add docs/brain/libraries/orders-classification.md (facets, queryOrders signature, the first-vs-repeat convention, and an explicit 'bucketOrder in [[order-bucketing]] is the SoT for origin/cartType' pointer) and link it from the libraries README. Refactor scripts/_measure-test-purchaser-overlap.ts to obtain its checkout/renewal + first-vs-repeat classification from queryOrders/classifyOrder instead of inline bucketOrder + hand-rolled earliest-order logic (the UTM→campaign attribution join stays in the script; it is out of this SDK's scope).",
        verification:
          "`npx tsx scripts/_check-brain-links.ts` (or the repo's brain-link checker) passes with the new page linked; a grep test asserts scripts/_measure-test-purchaser-overlap.ts imports from @/lib/orders-classification and no longer calls bucketOrder directly; `npx tsc --noEmit` clean.",
      },
    ],
  );
  console.log("spec authored:", res.spec_id, "phases:", JSON.stringify(res.phase_ids));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
