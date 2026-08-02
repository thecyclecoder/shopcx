import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    W,
    "swap-variant-preserves-the-line-price",
    {
      title: "A variant swap must never change what the customer pays",
      why:
        "On 2026-07-30 a crisis swap reset the line price of 286 subscriptions to catalog. Eight " +
        "renewals billed at the reset price before it was caught, $245.40 had to be refunded, and " +
        "one customer had to be emailed twice to correct a wrong remediation. Nobody wrote a bad " +
        "line of code: subSwapVariant simply does not carry the price across, and an Appstle " +
        "variant replacement creates a NEW line at catalog price. The same swap runs again for the " +
        "Strawberry Lemonade restock in November 2026 and would re-break the same customers. " +
        "docs/brain/lifecycles/crisis-campaign.md already states the rule this violates — 'crisis " +
        "swaps shouldn't be a pricing event for the customer' — so the rule exists and only the " +
        "rail is missing.",
      what:
        "subSwapVariant captures the outgoing line's realized per-unit price and re-applies it to " +
        "the incoming line, on both the Appstle and internal rails, then asserts the price did not " +
        "move and fails loudly if it did. A swap can lower a price (a cheaper variant) but can " +
        "never raise it.",
      summary:
        "src/lib/subscription-items.ts:833 subSwapVariant (fronted by src/lib/commerce/subscription.ts:549 " +
        "subscriptionSwapVariant) calls callReplaceVariants and returns, never reading the old line's " +
        "price. Appstle bills the new line at catalog; the internal rail's internalSubSwapVariant builds " +
        "a fresh item without price_override_cents / price_cents, which docs/brain/libraries/pricing.md " +
        "calls the 'live catalog opt-in'. Both rails therefore drop the grandfather lock. Fix is to " +
        "read the outgoing line's realized unit price, translate it to the target rail's lock, and " +
        "verify the post-swap realized price is unchanged.",
      owner: "platform",
      parent:
        '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: a sanctioned SDK ' +
        "chokepoint that silently changes what a customer is billed is a reliability defect in the " +
        "commerce rail, and it has already cost real money twice.",
      blocked_by: [],
      human_review:
        "After ship, swap one test subscription on each rail (Appstle + internal) between two " +
        "variants and confirm on /dashboard/subscriptions that the displayed per-unit price is " +
        "identical before and after.",
      phases: [
        {
          title: "Phase 1 — Preserve the price on the Appstle rail",
          why:
            "This is the rail that broke. 273 Appstle subscriptions were reset, and the price is " +
            "recoverable only because renewal order history happened to record what they used to pay.",
          what:
            "subSwapVariant reads the outgoing line's price before replacing it and re-applies it to " +
            "the new line, so the customer's charge is unchanged by the swap.",
          body:
            "In `src/lib/subscription-items.ts` `subSwapVariant` (line 833), before `callReplaceVariants`:\n" +
            "1. GET the contract and find the outgoing line for `resolvedOld`. Capture its realized " +
            "per-unit price (`currentPrice.amount`) and its `pricingPolicy.basePrice` when present.\n" +
            "2. After a successful replace, resolve the NEW line's id and call the existing " +
            "`subUpdateLineItemPrice` with the base that reproduces the captured realized price. " +
            "`subUpdateLineItemPrice` takes MSRP and the contract lands at `base * (1 - sns)` " +
            "(docs/brain/recipes/change-line-item-price.md), so the base is " +
            "`round(realized / (1 - sns))` with `sns` from `resolveLineSnsPct` " +
            "(src/lib/appstle-pricing.ts:82). Passing the realized price directly double-discounts " +
            "it — that exact mistake set 5 subscriptions 25% low during the 2026-07-30 cleanup.\n" +
            "3. NEVER raise. If the captured realized price is ABOVE the new variant's catalog " +
            "realized price, leave the cheaper new price in place.\n" +
            "4. If the old line's price cannot be read, do NOT silently proceed — return " +
            "`{ success: false }` naming the contract. A swap that cannot guarantee the price is a " +
            "swap that must not happen unattended.\n\n" +
            "Callers pass no new arguments; preservation is the default behaviour of the SDK.",
          verification: [
            "- `npx tsc --noEmit` clean on the branch.",
            "- `subSwapVariant` reads the outgoing line price before replacing it.",
            "- The sns-aware base conversion is present, not a bare realized-price write.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "subSwapVariant captures the outgoing line price before the replace",
              kind: "auto", exec_kind: "grep",
              params: { pattern: "capturedUnitCents", path: "src/lib/subscription-items.ts", expect: "present" },
            },
            {
              position: 3,
              description: "the re-apply converts realized to base via the sns factor, not a raw write",
              kind: "auto", exec_kind: "grep",
              params: { pattern: "resolveLineSnsPct", path: "src/lib/subscription-items.ts", expect: "present" },
            },
          ],
        },
        {
          title: "Phase 2 — Preserve the price on the internal rail",
          why:
            "All 21 internal subscriptions in the crisis set lost their grandfather lock too, and " +
            "were invisible to the first cleanup because internal items carry no price_cents at all. " +
            "The internal engine also applies a quantity break, so the Appstle formula is wrong here.",
          what:
            "internalSubSwapVariant carries the outgoing line's lock onto the new item, using the " +
            "pricing engine to confirm the resulting per-unit price is unchanged.",
          body:
            "In `src/lib/internal-subscription.ts` `internalSubSwapVariant`, carry the outgoing item's " +
            "`price_override_cents` / `price_cents` onto the new item instead of building a bare item.\n\n" +
            "The internal engine applies BOTH the quantity break and S&S on top of " +
            "`price_override_cents` (src/lib/internal-subscription.ts:443), so `realized / (1 - sns)` " +
            "UNDERSHOOTS on a break-priced line — during the cleanup, carrie.allen@medtronic.com " +
            "(qty 4) needed base $59.01 to price at $38.95 where the flat formula gave $51.93. " +
            "Do not re-derive the arithmetic. Use `resolveSubscriptionPricing` " +
            "(src/lib/pricing.ts:141), which is pure with respect to the sub object passed in, to " +
            "price a candidate item list and solve the base that lands on the captured per-unit " +
            "price. `scripts/crisis-price-restore-internal.ts` is a working reference for this " +
            "solve-and-verify loop.\n\n" +
            "Where the outgoing item used a verbatim `price_cents` lock, carry that across directly — " +
            "no conversion is needed.",
          verification: [
            "- `npx tsc --noEmit` clean.",
            "- The internal swap solves the base against the pricing engine rather than a flat sns formula.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "the internal swap prices candidates through the engine",
              kind: "auto", exec_kind: "grep",
              params: { pattern: "resolveSubscriptionPricing", path: "src/lib/internal-subscription.ts", expect: "present" },
            },
          ],
        },
        {
          title: "Phase 3 — Assert it, so a silent regression is impossible",
          why:
            "The reason this went unnoticed for a day is that nothing compared the price before and " +
            "after. callReplaceVariants already returns success on any 2xx without reading the body, " +
            "so 'the swap reported success' has repeatedly not meant the swap did what was intended.",
          what:
            "Every swap re-reads the realized per-unit price afterwards and fails loudly when it " +
            "moved upward, rather than returning a success the caller cannot distinguish.",
          body:
            "After a swap on either rail, re-read the realized per-unit price for the new line — live " +
            "contract on Appstle, `resolveSubscriptionPricing` on internal — and compare against the " +
            "captured value.\n\n" +
            "If the new realized price is HIGHER than captured (tolerance 2 cents), return " +
            "`{ success: false }` naming the contract, the expected price and the observed price. A " +
            "lower price is fine and passes.\n\n" +
            "Add a unit test covering: (a) equal price passes, (b) a higher post-swap price fails, " +
            "(c) a lower post-swap price passes. Wire it into the existing test script so the " +
            "`unit_test` check can run it.\n\n" +
            "Per CLAUDE.md, update `docs/brain/libraries/subscription-items.md`, " +
            "`docs/brain/libraries/commerce__subscription.md` and " +
            "`docs/brain/lifecycles/crisis-campaign.md` § Pricing preservation to state that price " +
            "preservation is enforced by the SDK rather than left to callers.",
          verification: [
            "- `npx tsc --noEmit` clean.",
            "- A post-swap price assertion exists.",
            "- The unit test suite passes.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "a post-swap price assertion exists",
              kind: "auto", exec_kind: "grep",
              params: { pattern: "swap changed the price", path: "src/lib/subscription-items.ts", expect: "present" },
            },
            {
              position: 3,
              description: "the brain records that the SDK enforces preservation",
              kind: "auto", exec_kind: "grep",
              params: { pattern: "preserv", path: "docs/brain/libraries/subscription-items.md", expect: "present" },
            },
          ],
        },
      ],
    },
    "planned",
    {
      intendedStatusSetBy: "ceo",
      parentKind: "mandate",
      parentRef: "platform#infra-devops-reliability",
    },
  );
  console.log(ok ? "authored" : "author write failed");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
