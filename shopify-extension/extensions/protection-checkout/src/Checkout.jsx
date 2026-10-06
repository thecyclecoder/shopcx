import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * Shipping Protection toggle — one checkbox, ON by default, placed under the
 * shipping address:
 *
 *   [✓] Shipping Protection  ~~$9.95~~ $4.95
 *       Protect yourself against damage or loss. 100% replacement guarantee.
 *
 * The $9.95 is a visual anchor drawn here only; nothing in Shopify carries a
 * compare-at price. What the shopper is charged is the variant's own price.
 *
 * THE CART IS THE STATE. Every render reconciles the cart toward one desired
 * line, so a reload, a back-navigation or a cart edit can never leave it wrong:
 *
 *   - Exactly ONE protection line, quantity 1. Extra lines or quantity are trimmed.
 *     Lines of the retired protection products (UpCart, ShopWill) count as
 *     protection and are replaced, so a cart-drawer add can't double it.
 *   - SUBSCRIPTION-AWARE. If any other line is on a selling plan, protection is the
 *     subscription variant on THAT selling plan, so it joins the same subscription
 *     and renews with it. Otherwise it is the one-time variant. A cart that gains or
 *     loses its subscription swaps the version.
 *   - Both versions bill $4.95: the one-time variant is $4.95, the subscription
 *     variant is $6.60 and the Appstle plan takes 25% off it.
 *   - Nothing but protection in the cart → no protection.
 *   - ON BY DEFAULT, auto-added on first render when missing. Unchecking writes the
 *     checkout attribute `_shipping_protection=declined`, so the opt-out survives
 *     reloads instead of the block re-adding it; re-checking writes `accepted`.
 *
 * If this checkout cannot change lines (draft-order checkouts, some express
 * flows), the block renders nothing and touches nothing.
 */
export default function extension() {
  render(<ShippingProtection />, document.body);
}

const PRICE = "$4.95";
const ANCHOR = "$9.95";
const ATTR = "_shipping_protection";

// Shipping Protection (handle addons-first-101y98) is the live product. The
// other two are retired protection products a cart drawer may still add.
const PROTECTION_PRODUCTS = new Set([
  "gid://shopify/Product/8356945952941",
  "gid://shopify/Product/7510145040557", // UpCart, retired
  "gid://shopify/Product/7634377900205", // ShopWill, retired
]);

const DEFAULT_ONE_TIME = "";
const DEFAULT_SUBSCRIPTION = "45036181651629";

const variantGid = (v, fallback) => {
  const id = String(v || fallback || "").trim().split("/").pop();
  return /^\d+$/.test(id) ? `gid://shopify/ProductVariant/${id}` : null;
};

const isProtection = (line) => PROTECTION_PRODUCTS.has(line?.merchandise?.product?.id);
const planOf = (line) => line?.merchandise?.sellingPlan?.id || null;

function ShippingProtection() {
  const settings = shopify.settings.value;
  const lines = shopify.lines.value || [];
  const attributes = shopify.attributes.value || [];
  // the opt-out lives in a checkout attribute, so attribute writes are required too
  const canChange =
    shopify.instructions.value?.lines?.canAddCartLine &&
    shopify.instructions.value?.lines?.canRemoveCartLine &&
    shopify.instructions.value?.attributes?.canUpdateAttributes;

  const oneTime = variantGid(settings.one_time_variant_id, DEFAULT_ONE_TIME);
  const subscription = variantGid(settings.subscription_variant_id, DEFAULT_SUBSCRIPTION);

  const declined = attributes.some((a) => a.key === ATTR && a.value === "declined");
  const others = lines.filter((l) => !isProtection(l));
  const protection = lines.filter(isProtection);
  const subPlan = others.map(planOf).find(Boolean) || null;

  // the one line the cart should hold, or null for none
  const desired =
    declined || !others.length
      ? null
      : subPlan
        ? subscription && { merchandiseId: subscription, sellingPlanId: subPlan }
        : oneTime && { merchandiseId: oneTime, sellingPlanId: null };

  const busy = useRef(false);

  useEffect(() => {
    if (!canChange || busy.current) return;

    /** @type {import("@shopify/ui-extensions/checkout").CartLineChange[]} */
    const changes = [];
    const keep = desired
      ? protection.find(
          (l) => l.merchandise.id === desired.merchandiseId && planOf(l) === desired.sellingPlanId,
        )
      : null;

    for (const l of protection) {
      if (l !== keep) changes.push({ type: /** @type {const} */ ("removeCartLine"), id: l.id, quantity: l.quantity });
    }
    if (keep && keep.quantity !== 1) changes.push({ type: /** @type {const} */ ("updateCartLine"), id: keep.id, quantity: 1 });
    if (desired && !keep) {
      changes.push({
        type: /** @type {const} */ ("addCartLine"),
        merchandiseId: desired.merchandiseId,
        quantity: 1,
        ...(desired.sellingPlanId ? { sellingPlanId: desired.sellingPlanId } : {}),
      });
    }
    if (!changes.length) return;

    // one change at a time; the lines signal re-renders us and we converge
    busy.current = true;
    (async () => {
      try {
        for (const change of changes) {
          const result = await shopify.applyCartLinesChange(change);
          if (result?.type === "error") break;
        }
      } finally {
        busy.current = false;
      }
    })();
  }, [
    canChange,
    desired?.merchandiseId,
    desired?.sellingPlanId,
    protection.map((l) => `${l.id}:${l.merchandise.id}:${planOf(l)}:${l.quantity}`).join(","),
  ]);

  if (!canChange || !others.length || !(subPlan ? subscription : oneTime)) return null;

  const checked = !declined;

  const onChange = (event) => {
    const on = Boolean(event?.currentTarget?.checked);
    shopify.applyAttributeChange({ type: "updateAttribute", key: ATTR, value: on ? "accepted" : "declined" });
  };

  return (
    <s-stack direction="inline" gap="small-200" alignItems="start">
      <s-checkbox checked={checked} onChange={onChange} accessibilityLabel="Add Shipping Protection" />
      <s-stack gap="none">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text type="strong">Shipping Protection</s-text>
          <s-text color="subdued">
            <s-text type="redundant">{ANCHOR}</s-text>
          </s-text>
          <s-text type="strong">{PRICE}</s-text>
        </s-stack>
        <s-text type="small" color="subdued">
          Protect yourself against damage or loss. 100% replacement guarantee.
        </s-text>
      </s-stack>
    </s-stack>
  );
}
