import "@shopify/ui-extensions/preact";
import { render } from "preact";

/**
 * Shipping trust nudge — sits by the shipping options and answers the two fears
 * at that step, "will it take forever?" and "is it actually coming?", in two lines:
 *
 *   🚚 Estimated arrival Mon, Oct 12 – Thu, Oct 15
 *   [USPS] [DHL]  Tracked from our warehouse to your door
 *
 * Every claim is measured, not marketing (orders, last 90 days to 2026-10-06, 5,938
 * orders):
 *   - ARRIVAL: order → delivered took 6.5 days at the median, 8.4 at p80, 10.6 at
 *     p95 (calendar days). The window is today + 6 to today + 9 by default, a
 *     Sunday end moved to Monday. It is an estimate and says so; a hard "arrives
 *     by" date would be missed for roughly one order in ten. Both ends are
 *     merchant settings so they can follow the data.
 *   - CARRIERS: ~72% of fulfillments go out on OSM Priority Select / USPS Ground
 *     Advantage (USPS delivers), ~20% DHL eCommerce, UPS ~0. So the marks are USPS
 *     and DHL. Never add a carrier we don't ship with.
 *   - TRACKED: every one of the 5,804 shipped orders in that window has an
 *     amplifier_tracking_number.
 *
 * Static: no network calls, no skeleton, nothing that can fail at render beyond
 * the two logo images (served from our own /checkout/*.png).
 */
export default function extension() {
  render(<ShippingTrust />, document.body);
}

const DAY = 864e5;

const toDays = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
};

/** today + days, a Sunday nudged to Monday (no Sunday delivery promise) */
const arrival = (days) => {
  const d = new Date(Date.now() + days * DAY);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d;
};

const fmt = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function ShippingTrust() {
  const settings = shopify.settings.value;
  const apiEndpoint = String(settings.api_endpoint || "https://shopcx.ai").replace(/\/$/, "");
  const minDays = toDays(settings.arrival_min_days, 6);
  const maxDays = Math.max(minDays, toDays(settings.arrival_max_days, 9));

  return (
    <s-box background="subdued" borderRadius="large" padding="base">
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-icon type="truck" size="small" />
          <s-text type="strong">
            Estimated arrival {fmt(arrival(minDays))} – {fmt(arrival(maxDays))}
          </s-text>
        </s-stack>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-box inlineSize="20px">
            <s-image src={`${apiEndpoint}/checkout/usps.png`} alt="USPS" aspectRatio="1.61" />
          </s-box>
          <s-box inlineSize="80px">
            <s-image src={`${apiEndpoint}/checkout/dhl.png`} alt="DHL" aspectRatio="6.67" />
          </s-box>
          <s-text type="small" color="subdued">
            Tracked from our warehouse to your door
          </s-text>
        </s-stack>
      </s-stack>
    </s-box>
  );
}
