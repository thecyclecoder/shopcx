import {
  reactExtension,
  useAuthenticatedAccountCustomer,
  useApplyDiscountCodeChange,
  useShop,
  useSettings,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Divider,
  SkeletonText,
} from "@shopify/ui-extensions-react/checkout";
import { useState, useEffect } from "react";

export default reactExtension("purchase.checkout.block.render", () => (
  <LoyaltyRewards />
));

function LoyaltyRewards() {
  const customer = useAuthenticatedAccountCustomer();
  const applyDiscountCode = useApplyDiscountCodeChange();
  const shop = useShop();
  const settings = useSettings();

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
    return (
      <BlockStack spacing="tight">
        <SkeletonText inlineSize="large" />
        <SkeletonText inlineSize="small" />
      </BlockStack>
    );
  }

  if (!customer?.id || balance === null || balance <= 0) {
    return null;
  }

  return (
    <BlockStack spacing="base">
      <Text size="medium" emphasis="bold">
        Loyalty Rewards
      </Text>

      <InlineStack spacing="tight" blockAlignment="center">
        <Text size="base">
          You have <Text emphasis="bold">{balance.toLocaleString()}</Text> reward points
        </Text>
        {dollarValue > 0 && (
          <Text size="base" appearance="subdued">
            (worth ${dollarValue})
          </Text>
        )}
      </InlineStack>

      {result && (
        <Banner status="success">
          Applied {result.code} — ${result.value} off!
        </Banner>
      )}

      {error && (
        <Banner status="critical">
          {error}
        </Banner>
      )}

      {!result && (
        <>
          <Divider />
          <BlockStack spacing="tight">
            {tiers.map((tier) => (
              <InlineStack
                key={tier.tier_index}
                spacing="base"
                blockAlignment="center"
                inlineAlignment="spaceBetween"
              >
                <BlockStack spacing="none">
                  <Text size="base" emphasis={tier.affordable ? "bold" : undefined}>
                    {tier.label}
                  </Text>
                  <Text size="small" appearance="subdued">
                    {tier.points_cost.toLocaleString()} points
                  </Text>
                </BlockStack>
                {tier.affordable ? (
                  <Button
                    kind="secondary"
                    loading={redeeming}
                    onPress={() => handleRedeem(tier)}
                  >
                    Redeem
                  </Button>
                ) : (
                  <Text size="small" appearance="subdued">
                    Need {tier.points_needed.toLocaleString()} more
                  </Text>
                )}
              </InlineStack>
            ))}
          </BlockStack>
        </>
      )}
    </BlockStack>
  );
}
