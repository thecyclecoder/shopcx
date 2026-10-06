import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect, useMemo } from "preact/hooks";

/**
 * Customer reviews for WHAT IS ACTUALLY IN THE CART.
 *
 * Replaces the third-party checkout app's review block. The difference that
 * matters is the source: this reads product_reviews through our own API, the same
 * table the PDP, the cart drawer and the AI agent read, so there is one corpus and
 * no second copy pasted into someone else's dashboard to go stale.
 *
 * shopify.lines gives each line's merchandise.product.id as a Shopify GID; the
 * numeric tail is what our endpoint keys on. One request per distinct product,
 * which is one or two in practice.
 *
 * SHORT AND SWEET: up to three 5-star quotes across the cart, round-robin over
 * products. A body of 140 characters or less shows as written; a longer one shows
 * its `summary` (the Haiku one-liner, max 15 words) instead, so the sidebar stays
 * compact. A long review with no summary is skipped.
 *
 * WEIGHT-LOSS RAIL, same rule as the PDP's review chapter:
 *   - a quantified claim ("lost 30 pounds") renders only from a VERIFIED buyer
 *   - "Results vary." travels with any weight claim that does render
 * The `verified` flag comes from the API for exactly this reason. A review that
 * fails the rail is skipped, and if that leaves a product with nothing, the
 * product simply contributes no card.
 *
 * RENDERS NOTHING UNTIL THE DATA ARRIVES. No skeleton: a placeholder in checkout
 * reserves space for social proof that may never come and shifts the page when it
 * does not. If the fetch fails the block is silently absent, which is the correct
 * failure for decoration sitting next to a payment button.
 *
 * API 2025-10+: Preact + Polaris web components, state from the `shopify` global.
 * Reading `shopify.lines.value` during render subscribes this component to cart
 * changes (via @preact/signals, which the ui-extensions preact entry wires up).
 */
export default function extension() {
  render(<CheckoutReviews />, document.body);
}

// digits or a spelled-out number: the Haiku summaries write "dropped fifteen pounds"
const WEIGHT =
  /\b(?:lost|losing|lose|down|shed|dropped|dropping|drop)\s+(?:about\s+|around\s+|over\s+|almost\s+|nearly\s+)?(?:\d+\+?|(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a hundred)(?:[\s-]\w+)?)\s*(?:lb|lbs|pound|pounds)\b/i;

// Three short quotes across the whole cart, not one long body per product.
const MAX_REVIEWS = 3;
// A body this short is already a quote; anything longer shows its summary.
const SHORT_BODY = 140;

/** The line a card shows: the real words when short, else the Haiku summary. */
const quoteOf = (r) => {
  const body = (r.body || "").trim();
  if (body && body.length <= SHORT_BODY) return body;
  return (r.summary || "").trim();
};

const numericId = (gid) => String(gid || "").split("/").pop();

function CheckoutReviews() {
  const lines = shopify.lines.value;
  const settings = shopify.settings.value;
  const apiEndpoint = settings.api_endpoint || "https://shopcx.ai";
  const workspace = settings.workspace || "superfoods";

  // distinct products, order preserved — the cart usually holds one or two
  const productIds = useMemo(() => {
    const seen = [];
    for (const line of lines || []) {
      const id = numericId(line?.merchandise?.product?.id);
      if (id && !seen.includes(id)) seen.push(id);
    }
    return seen;
  }, [lines]);

  const [reviews, setReviews] = useState([]);

  useEffect(() => {
    let cancelled = false;
    if (!productIds.length) {
      setReviews([]);
      return;
    }

    Promise.all(
      productIds.map((id) =>
        fetch(
          `${apiEndpoint}/api/storefront/${workspace}/product-reviews?shopify_product_id=${id}&limit=12`
        )
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return;
      // per product: 5-star reviews with a short line that passes the rail
      const pools = results.map((data) =>
        ((data && data.reviews) || [])
          .filter((r) => r && (r.rating || 0) >= 5)
          .map((r) => ({ ...r, quote: quoteOf(r) }))
          // the rail applies to the words we show: an unverified reviewer may not
          // carry a quantified weight claim
          .filter((r) => r.quote && (r.verified || !WEIGHT.test(r.quote)))
      );

      // round-robin so a two-product cart shows both products before a third card
      const picked = [];
      const seen = new Set();
      for (let i = 0; picked.length < MAX_REVIEWS; i++) {
        let added = false;
        for (const pool of pools) {
          const r = pool[i];
          if (!r || picked.length >= MAX_REVIEWS) continue;
          added = true;
          if (seen.has(r.id)) continue; // pooled link groups can share a review
          seen.add(r.id);
          picked.push(r);
        }
        if (!added) break;
      }
      setReviews(picked);
    });

    return () => {
      cancelled = true;
    };
  }, [productIds.join(","), apiEndpoint, workspace]);

  if (!reviews.length) return null;

  const resultsVary = reviews.some((r) => WEIGHT.test(r.quote));

  return (
    <s-stack gap="base">
      <s-heading>What customers say</s-heading>

      {reviews.map((r) => (
        <s-box key={r.id} border="base" borderRadius="base" padding="base">
          <s-stack gap="small-200">
            <s-text tone="warning">
              {"★".repeat(Math.max(0, Math.min(5, r.rating || 0)))}
            </s-text>
            <s-paragraph>{r.quote}</s-paragraph>
            <s-stack direction="inline" gap="small" justifyContent="space-between">
              <s-text type="small" color="subdued">
                {r.reviewer_name}
              </s-text>
              {r.verified ? (
                <s-text type="small" color="subdued">
                  Verified buyer
                </s-text>
              ) : null}
            </s-stack>
          </s-stack>
        </s-box>
      ))}

      {resultsVary ? (
        <s-text type="small" color="subdued">
          Results vary.
        </s-text>
      ) : null}
    </s-stack>
  );
}
