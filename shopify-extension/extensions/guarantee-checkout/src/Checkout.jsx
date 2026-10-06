import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";

/**
 * Money-Back Guarantee block for checkout.
 *
 * RENDERS NOTHING UNTIL OUR DATABASE CONFIRMS IT. Whether the guarantee shows is
 * decided server-side by the live `refunds` policy row — the same row the help
 * centre and the AI agent answer from. If the API is unreachable, or that policy is
 * inactive or no longer offers a guarantee, the endpoint returns { enabled: false }
 * and this renders nothing.
 *
 * A headline and nothing else, on purpose: a bare "30-Day Money-Back Guarantee"
 * cannot overstate the offer, and the full terms stay one click away where they
 * already live.
 *
 * That is deliberate rather than defensive. A guarantee is a legal promise, so the
 * failure mode for "we cannot reach the source of truth" has to be silence, not a
 * hardcoded fallback asserting a commitment nobody can currently verify. It also
 * means editing the policy updates checkout with no deploy.
 *
 * No loading skeleton either: a placeholder would reserve space for a promise that
 * may never arrive and shift the checkout when it does not.
 *
 * API 2025-10+: checkout UI extensions are Preact + Polaris web components (`s-*`),
 * reading checkout state from the `shopify` global. The React runtime
 * (@shopify/ui-extensions-react) stops at 2025-07, so a React build of this block
 * renders nothing on 2025-10. Colour and type come from the Checkout Branding API
 * at the profile level, not from here.
 */
export default function extension() {
  render(<MoneyBackGuarantee />, document.body);
}

function MoneyBackGuarantee() {
  const apiEndpoint = shopify.settings.value.api_endpoint || "https://shopcx.ai";
  const shop = shopify.shop.myshopifyDomain;

  const [guarantee, setGuarantee] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiEndpoint}/api/storefront/guarantee?shop=${encodeURIComponent(shop)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data && data.enabled && data.title) setGuarantee(data);
      })
      .catch(() => {
        // stay silent — see the note above on failing closed
      });
    return () => {
      cancelled = true;
    };
  }, [apiEndpoint, shop]);

  if (!guarantee) return null;

  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-icon type="check-circle" size="large" />
        <s-text type="strong">{guarantee.title}</s-text>
      </s-stack>
    </s-box>
  );
}
