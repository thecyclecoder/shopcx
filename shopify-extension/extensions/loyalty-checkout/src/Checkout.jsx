import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";

/**
 * Loyalty points + redeem-to-discount block for checkout.
 *
 * API 2025-10+: Preact + Polaris web components, state from the `shopify` global.
 * The customer comes from shopify.buyerIdentity (needs protected customer data
 * access), and a redeemed code is applied with shopify.applyDiscountCodeChange.
 */
export default function extension() {
  render(<LoyaltyRewards />, document.body);
}

function LoyaltyRewards() {
  const customer = shopify.buyerIdentity?.customer?.value;
  const applyDiscountCode = (change) => shopify.applyDiscountCodeChange(change);
  const shop = shopify.shop;
  const settings = shopify.settings.value;

  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState(null);
  const [tiers, setTiers] = useState([]);
  const [dollarValue, setDollarValue] = useState(0);
  const [workspaceId, setWorkspaceId] = useState(null);
  const [redeeming, setRedeeming] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const apiEndpoint = settings.api_endpoint || "https://shopcx.ai";

  // Fetch balance on load
  useEffect(() => {
    if (!customer?.id) {
      setLoading(false);
      return;
    }

    const shopifyCustomerId = customer.id.replace("gid://shopify/Customer/", "");

    fetch(
      `${apiEndpoint}/api/loyalty/balance?shopify_customer_id=${shopifyCustomerId}&shop=${shop.myshopifyDomain}`
    )
      .then((res) => res.json())
      .then((data) => {
        if (data.enabled && data.points_balance > 0) {
          setBalance(data.points_balance);
          setTiers(data.tiers || []);
          setDollarValue(data.dollar_value || 0);
          setWorkspaceId(data.workspace_id);
        }
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [customer?.id, shop.myshopifyDomain, apiEndpoint]);

  const handleRedeem = async (tier) => {
    if (redeeming || !workspaceId || !customer?.id) return;

    setRedeeming(true);
    setError(null);
    setResult(null);

    const shopifyCustomerId = customer.id.replace("gid://shopify/Customer/", "");

    try {
      const res = await fetch(`${apiEndpoint}/api/loyalty/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          shopify_customer_id: shopifyCustomerId,
          tier_index: tier.tier_index,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Redemption failed");
        setRedeeming(false);
        return;
      }

      // Apply discount code to checkout
      const discountResult = await applyDiscountCode({
        type: "addDiscountCode",
        code: data.code,
      });

      if (discountResult.type === "error") {
        setError("Could not apply discount code");
        setRedeeming(false);
        return;
      }

      // Update local state
      setBalance(data.new_balance);
      setTiers((prev) =>
        prev.map((t) => ({
          ...t,
          affordable: data.new_balance >= t.points_cost,
          points_needed: Math.max(0, t.points_cost - data.new_balance),
        }))
      );
      setResult({
        code: data.code,
        value: data.discount_value,
      });
    } catch {
      setError("Something went wrong. Please try again.");
    }

    setRedeeming(false);
  };

  // Don't render if no customer, loading, or no balance
  if (loading) {
    return <s-skeleton-paragraph />;
  }

  if (!customer?.id || balance === null || balance <= 0) {
    return null;
  }

  return (
    <s-stack gap="base">
      <s-heading>Loyalty Rewards</s-heading>

      <s-stack direction="inline" gap="small" alignItems="center">
        <s-text>
          You have <s-text type="strong">{balance.toLocaleString()}</s-text> reward points
        </s-text>
        {dollarValue > 0 && <s-text color="subdued">(worth ${dollarValue})</s-text>}
      </s-stack>

      {result && (
        <s-banner tone="success">
          Applied {result.code}: ${result.value} off!
        </s-banner>
      )}

      {error && <s-banner tone="critical">{error}</s-banner>}

      {!result && (
        <>
          <s-divider />
          <s-stack gap="small">
            {tiers.map((tier) => (
              <s-stack
                key={tier.tier_index}
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
              >
                <s-stack gap="none">
                  <s-text type={tier.affordable ? "strong" : undefined}>{tier.label}</s-text>
                  <s-text type="small" color="subdued">
                    {tier.points_cost.toLocaleString()} points
                  </s-text>
                </s-stack>
                {tier.affordable ? (
                  <s-button
                    variant="secondary"
                    loading={redeeming}
                    onClick={() => handleRedeem(tier)}
                  >
                    Redeem
                  </s-button>
                ) : (
                  <s-text type="small" color="subdued">
                    Need {tier.points_needed.toLocaleString()} more
                  </s-text>
                )}
              </s-stack>
            ))}
          </s-stack>
        </>
      )}
    </s-stack>
  );
}
