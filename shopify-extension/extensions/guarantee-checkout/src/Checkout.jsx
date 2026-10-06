import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect, useMemo } from "preact/hooks";

/**
 * Checkout trust card — the block at the top of checkout.
 *
 *   [product]  ★★★★★ 4.8 · 13,158 reviews
 *   [ image ]  "I lost 40+ pounds and kept it off…" — Barbara H.
 *              ✓ 30-Day Money-Back Guarantee · Cancel anytime
 *
 * It replaced a bare guarantee headline. On mobile the order summary (and the
 * reviews block inside it) is collapsed, so this card is the only social proof most
 * mobile shoppers see. It stays compact on purpose: everything above Shop Pay pushes
 * the highest-converting buttons down.
 *
 * Every part is sourced, and every part fails closed — a part with no data simply
 * is not drawn, and with no data at all the block renders nothing:
 *
 *   - IMAGE: the first cart line's product image. No setting to forget to update.
 *   - RATING + COUNT: the product-reviews aggregate for the cart's most-reviewed
 *     product. The count is `display_count`, which adds the off-platform (Yotpo-era)
 *     bump server-side — the same number the Shopify PDP shows. Never add a bump
 *     here; that double-counts.
 *   - QUOTE: short 5-star quotes (a body of 140 chars or less, else its Haiku
 *     summary), rotating every few seconds. WEIGHT-LOSS RAIL as in reviews-checkout:
 *     a quantified claim only from a VERIFIED buyer, and "Results vary." whenever
 *     one is on screen.
 *   - GUARANTEE: only while the live `refunds` policy offers one
 *     (/api/storefront/guarantee). A guarantee is a legal promise, so no fallback.
 *   - TRUST LINE: an optional merchant setting (e.g. "Cancel anytime"), shown next
 *     to the guarantee.
 *
 * No skeleton: a placeholder would shift checkout when data arrives or never does.
 */
export default function extension() {
  render(<TrustCard />, document.body);
}

const WEIGHT =
  /\b(?:lost|losing|lose|down|shed|dropped|dropping|drop)\s+(?:about\s+|around\s+|over\s+|almost\s+|nearly\s+)?(?:\d+\+?|(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a hundred)(?:[\s-]\w+)?)\s*(?:lb|lbs|pound|pounds)\b/i;

const SHORT_BODY = 140;
const MAX_QUOTES = 5;
const ROTATE_MS = 6000;

const quoteOf = (r) => {
  const body = (r.body || "").trim();
  if (body && body.length <= SHORT_BODY) return body;
  return (r.summary || "").trim();
};

const numericId = (gid) => String(gid || "").split("/").pop();

function TrustCard() {
  const lines = shopify.lines.value;
  const settings = shopify.settings.value;
  const apiEndpoint = settings.api_endpoint || "https://shopcx.ai";
  const workspace = settings.workspace || "superfoods";
  const trustLine = String(settings.trust_line || "").trim();
  const shop = shopify.shop.myshopifyDomain;

  const productIds = useMemo(() => {
    const seen = [];
    for (const line of lines || []) {
      const id = numericId(line?.merchandise?.product?.id);
      if (id && !seen.includes(id)) seen.push(id);
    }
    return seen;
  }, [lines]);

  const image = (lines || []).map((l) => l?.merchandise?.image?.url).find(Boolean) || null;

  const [guarantee, setGuarantee] = useState(null);
  const [rating, setRating] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiEndpoint}/api/storefront/guarantee?shop=${encodeURIComponent(shop)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && data.enabled && data.title) setGuarantee(data.title);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiEndpoint, shop]);

  useEffect(() => {
    let cancelled = false;
    if (!productIds.length) {
      setRating(null);
      setQuotes([]);
      return;
    }
    Promise.all(
      productIds.map((id) =>
        fetch(
          `${apiEndpoint}/api/storefront/${workspace}/product-reviews?shopify_product_id=${id}&limit=24`
        )
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return;
      // the headline rating belongs to the cart's most-reviewed product
      const best = results
        .filter((d) => d && d.aggregate && d.aggregate.rating && d.aggregate.display_count)
        .sort((a, b) => b.aggregate.display_count - a.aggregate.display_count)[0];
      setRating(best ? best.aggregate : null);

      const picked = [];
      const reviewers = new Set();
      for (const data of best ? [best, ...results.filter((d) => d !== best)] : results) {
        for (const r of (data && data.reviews) || []) {
          if (picked.length >= MAX_QUOTES) break;
          if (!r || (r.rating || 0) < 5) continue;
          const quote = quoteOf(r);
          if (!quote) continue;
          if (!r.verified && WEIGHT.test(quote)) continue;
          const who = (r.reviewer_name || "").trim().toLowerCase();
          if (who && reviewers.has(who)) continue;
          if (who) reviewers.add(who);
          picked.push({ id: r.id, quote, name: r.reviewer_name, verified: r.verified });
        }
      }
      setQuotes(picked);
      setTick(0);
    });
    return () => {
      cancelled = true;
    };
  }, [productIds.join(","), apiEndpoint, workspace]);

  useEffect(() => {
    if (quotes.length < 2) return;
    const timer = setInterval(() => setTick((t) => t + 1), ROTATE_MS);
    return () => clearInterval(timer);
  }, [quotes.length]);

  const quote = quotes.length ? quotes[tick % quotes.length] : null;
  const trust = [guarantee, trustLine].filter(Boolean).join(" · ");

  if (!rating && !quote && !guarantee) return null;

  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack direction="inline" gap="base" alignItems="center">
        {image ? (
          <s-box inlineSize="64px">
            <s-image src={image} alt="" aspectRatio="1" objectFit="cover" borderRadius="base" />
          </s-box>
        ) : null}
        <s-stack gap="small-200">
          {rating ? (
            <s-text type="strong">
              <s-text tone="warning">★★★★★</s-text> {Number(rating.rating).toFixed(1)} ·{" "}
              {Number(rating.display_count).toLocaleString("en-US")} reviews
            </s-text>
          ) : null}
          {quote ? (
            <s-text>
              “{quote.quote}”{" "}
              <s-text color="subdued">
                — {quote.name}
                {quote.verified ? ", verified buyer" : ""}
              </s-text>
            </s-text>
          ) : null}
          {quote && WEIGHT.test(quote.quote) ? (
            <s-text type="small" color="subdued">
              Results vary.
            </s-text>
          ) : null}
          {trust ? (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              {guarantee ? <s-icon type="check-circle" size="small" /> : null}
              <s-text type="small">{trust}</s-text>
            </s-stack>
          ) : null}
        </s-stack>
      </s-stack>
    </s-box>
  );
}
