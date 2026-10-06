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
 * NON-CONTIGUOUS ADDRESSES. Alaska, Hawaii and Puerto Rico take far longer, so once
 * the shopper has entered one of them the block swaps to that region's window and
 * a line saying why. Measured on delivered orders, 12 months to 2026-10-06
 * (order → delivered_at, calendar days):
 *
 *   region      n      median  p80    window shown
 *   mainland    29,781  7.0     9.2    today + 6..9  (default, settings)
 *   Puerto Rico 119     9.8     15.0   today + 10..15
 *   Hawaii      124     14.0    19.7   today + 14..20
 *   Alaska      94      15.6    25.3   today + 16..25
 *
 * Those three ship almost entirely USPS Ground Advantage (directly or via OSM), so
 * only the USPS mark shows for them. The address comes from shopify.shippingAddress,
 * which needs protected-customer-data access; without it, or before an address is
 * entered, the value is undefined and the block shows the mainland default.
 *
 * Static: no network calls, no skeleton, nothing that can fail at render beyond
 * the two logo images (served from our own /checkout/*.png).
 */
export default function extension() {
  render(<ShippingTrust />, document.body);
}

const DAY = 864e5;

// An unset setting arrives as null or "", and Number(null) / Number("") is 0,
// which collapsed the window to "today – today". Only a real positive integer
// overrides the measured default.
const toDays = (v, fallback) => {
  if (v === null || v === undefined || String(v).trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : fallback;
};

/** today + days, a Sunday nudged to Monday (no Sunday delivery promise) */
const arrival = (days) => {
  const d = new Date(Date.now() + days * DAY);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d;
};

/**
 * Regions that ship slower than the mainland, keyed off the entered address.
 * Shopify gives Puerto Rico as country "PR"; some addresses carry it as a US
 * province instead, so both are matched.
 */
const REMOTE = {
  AK: { name: "Alaska", min: 16, max: 25 },
  HI: { name: "Hawaii", min: 14, max: 20 },
  PR: { name: "Puerto Rico", min: 10, max: 15 },
};

const remoteRegion = (address) => {
  if (!address) return null;
  const country = String(address.countryCode || "").toUpperCase();
  const province = String(address.provinceCode || "").toUpperCase();
  if (country === "PR") return REMOTE.PR;
  if (country === "US" && REMOTE[province]) return REMOTE[province];
  return null;
};

const fmt = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function ShippingTrust() {
  const settings = shopify.settings.value;
  const apiEndpoint = String(settings.api_endpoint || "https://shopcx.ai").replace(/\/$/, "");
  // undefined until an address is entered, or without protected-customer-data access
  const region = remoteRegion(shopify.shippingAddress?.value);
  const minDays = region ? region.min : toDays(settings.arrival_min_days, 6);
  const maxDays = region ? region.max : Math.max(minDays, toDays(settings.arrival_max_days, 9));

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
          {region ? null : (
            <s-box inlineSize="80px">
              <s-image src={`${apiEndpoint}/checkout/dhl.png`} alt="DHL" aspectRatio="6.67" />
            </s-box>
          )}
          <s-text type="small" color="subdued">
            Tracked from our warehouse to your door
          </s-text>
        </s-stack>
        {region ? (
          <s-text type="small" color="subdued">
            Orders to {region.name} ship USPS and take a little longer than the mainland.
          </s-text>
        ) : null}
      </s-stack>
    </s-box>
  );
}
