import {
  reactExtension,
  useCartLines,
  useSettings,
  BlockStack,
  InlineLayout,
  Text,
  View,
} from "@shopify/ui-extensions-react/checkout";
import { useState, useEffect, useMemo } from "react";

/**
 * Customer reviews for WHAT IS ACTUALLY IN THE CART.
 *
 * Replaces the third-party checkout app's review block. The difference that
 * matters is the source: this reads product_reviews through our own API, the same
 * table the PDP, the cart drawer and the AI agent read, so there is one corpus and
 * no second copy pasted into someone else's dashboard to go stale.
 *
 * useCartLines() gives each line's merchandise.product.id as a Shopify GID; the
 * numeric tail is what our endpoint keys on. One request per distinct product,
 * which is one or two in practice.
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
 */
export default reactExtension("purchase.checkout.block.render", () => <CheckoutReviews />);

const WEIGHT =
  /\b(?:lost|losing|lose|down|shed)\s+(?:about\s+|around\s+|over\s+|almost\s+|nearly\s+)?\d+\s*(?:lb|lbs|pound|pounds)\b/i;

const numericId = (gid) => String(gid || "").split("/").pop();

function CheckoutReviews() {
  const lines = useCartLines();
  const settings = useSettings();
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
          `${apiEndpoint}/api/storefront/${workspace}/product-reviews?shopify_product_id=${id}&limit=6`
        )
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return;
      const picked = [];
      for (const data of results) {
        const candidates = (data && data.reviews) || [];
        const ok = candidates.find((r) => {
          if (!r || !r.body || (r.rating || 0) < 5) return false;
          // the rail: an unverified reviewer may not carry a quantified weight claim
          if (!r.verified && WEIGHT.test(r.body)) return false;
          return true;
        });
        if (ok) picked.push(ok);
      }
      setReviews(picked);
    });

    return () => {
      cancelled = true;
    };
  }, [productIds.join(","), apiEndpoint, workspace]);

  if (!reviews.length) return null;

  const resultsVary = reviews.some((r) => WEIGHT.test(r.body || ""));

  return (
    <BlockStack spacing="base">
      <Text size="medium" emphasis="bold">
        What customers say
      </Text>

      {reviews.map((r) => (
        <View key={r.id} border="base" cornerRadius="base" padding="base">
          <BlockStack spacing="extraTight">
            <Text size="small" appearance="warning">
              {"★".repeat(Math.max(0, Math.min(5, r.rating || 0)))}
            </Text>
            <Text size="small">{r.body}</Text>
            <InlineLayout columns={["fill", "auto"]} spacing="tight">
              <Text size="extraSmall" appearance="subdued">
                {r.reviewer_name}
              </Text>
              {r.verified ? (
                <Text size="extraSmall" appearance="subdued">
                  Verified buyer
                </Text>
              ) : null}
            </InlineLayout>
          </BlockStack>
        </View>
      ))}

      {resultsVary ? (
        <Text size="extraSmall" appearance="subdued">
          Results vary.
        </Text>
      ) : null}
    </BlockStack>
  );
}
