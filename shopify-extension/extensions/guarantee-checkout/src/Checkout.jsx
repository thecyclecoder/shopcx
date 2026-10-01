import {
  reactExtension,
  useShop,
  useSettings,
  InlineLayout,
  Text,
  Icon,
  View,
} from "@shopify/ui-extensions-react/checkout";
import { useState, useEffect } from "react";

/**
 * Money-Back Guarantee block for checkout.
 *
 * RENDERS NOTHING UNTIL OUR DATABASE CONFIRMS IT. Whether the guarantee shows is
 * decided server-side by the live `refunds` policy row — the same row the help
 * centre and the AI agent answer from. If the API is unreachable, or that policy is
 * inactive or no longer offers a guarantee, the endpoint returns { enabled: false }
 * and this returns null.
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
 * Checkout UI extensions run in a sandboxed Web Worker with no DOM, so this is
 * composed from Shopify's components. Colour and type come from the Checkout
 * Branding API at the profile level, not from here.
 */
export default reactExtension("purchase.checkout.block.render", () => (
  <MoneyBackGuarantee />
));

function MoneyBackGuarantee() {
  const shop = useShop();
  const settings = useSettings();
  const apiEndpoint = settings.api_endpoint || "https://shopcx.ai";

  const [guarantee, setGuarantee] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(
      `${apiEndpoint}/api/storefront/guarantee?shop=${encodeURIComponent(shop.myshopifyDomain)}`
    )
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
  }, [apiEndpoint, shop.myshopifyDomain]);

  if (!guarantee) return null;

  return (
    <View border="base" cornerRadius="base" padding="base">
      <InlineLayout columns={["auto", "fill"]} spacing="base" blockAlignment="center">
        <Icon source="shieldCheck" size="large" />
        <Text size="medium" emphasis="bold">
          {guarantee.title}
        </Text>
      </InlineLayout>
    </View>
  );
}
