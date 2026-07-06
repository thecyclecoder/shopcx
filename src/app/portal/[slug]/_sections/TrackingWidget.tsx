"use client";

/**
 * Tracking widget on the portal order detail page.
 *
 * (docs/brain/specs/portal-order-detail-tracking-widget.md, Phase 3.)
 *
 * Two visual branches keyed on `delivery.kind` (set by the Phase 2
 * resolver in src/lib/portal/helpers/delivery-resolver.ts):
 *
 *   INTERNAL — render a dated milestone timeline from
 *   `easypost_tracking.events` (status label, message, datetime, city/state).
 *   Also renders tracking number + carrier + a "Track package" link so
 *   the customer can still open the raw carrier page.
 *
 *   SHOPIFY — render the current shipment status
 *   (in-transit / out-for-delivery / delivered) + tracking number +
 *   carrier + a link to the carrier's tracking page (trackingInfo.url).
 *   NO EasyPost milestones. The Phase 2 resolver never populates
 *   easypost_tracking on the Shopify branch.
 *
 *   NONE — the order isn't shipped yet (no tracking number / no
 *   fulfillments). Render nothing per the spec.
 *
 * When `delivered_at` is set, the widget shows a clear Delivered banner
 * (either branch). Copy is customer-facing — no developer language
 * ("in transit", not "IN_TRANSIT"; "out for delivery", not "out_for_delivery").
 */

interface EasypostEvent {
  status?: string;
  message?: string;
  datetime?: string;
  city?: string;
  state?: string;
  zip?: string;
}

interface EasypostTracking {
  status?: string;
  estimatedDelivery?: string | null;
  events?: EasypostEvent[];
}

interface Fulfillment {
  trackingInfo?: Array<{ number?: string | null; url?: string | null; company?: string | null }>;
  status?: string | null;
  shipmentStatus?: string | null;
  createdAt?: string | null;
}

export interface TrackingWidgetDelivery {
  kind: "internal" | "shopify" | "none";
  delivered_at: string | null;
  easypost_tracking: unknown;
  fulfillments: unknown;
}

interface Props {
  delivery: TrackingWidgetDelivery;
  trackingNumber: string | null;
  carrier: string | null;
}

function humanStatus(raw: string | null | undefined): string {
  if (!raw) return "In transit";
  const norm = raw.toLowerCase().replace(/_/g, " ");
  switch (norm) {
    case "delivered": return "Delivered";
    case "out for delivery": return "Out for delivery";
    case "in transit": return "In transit";
    case "confirmed": case "pre transit": case "label printed":
      return "Preparing to ship";
    case "failure": case "return to sender":
      return "Delivery issue";
    default:
      // Sentence-case the fallback so unknown carrier codes don't leak
      // developer language into the customer view.
      return norm.charAt(0).toUpperCase() + norm.slice(1);
  }
}

function humanDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function trackingUrlFallback(carrier: string | null, tracking: string): string | null {
  if (!tracking) return null;
  const c = (carrier || "").toLowerCase();
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`;
  if (c.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tracking)}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?tracknumbers=${encodeURIComponent(tracking)}`;
  if (c.includes("dhl")) return `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(tracking)}`;
  return `https://www.google.com/search?q=${encodeURIComponent(tracking)}+tracking`;
}

export function TrackingWidget({ delivery, trackingNumber, carrier }: Props) {
  // Spec: only render the widget for SHIPPED orders. A not-yet-shipped
  // order shows no tracking widget.
  if (delivery.kind === "none") return null;

  const isDelivered = !!delivery.delivered_at;
  const deliveredOn = humanDate(delivery.delivered_at);

  if (delivery.kind === "internal") {
    const tracking = (delivery.easypost_tracking ?? {}) as EasypostTracking;
    const events = Array.isArray(tracking.events) ? tracking.events : [];
    const latestStatus = events[0]?.status || tracking.status || null;
    const headerStatus = isDelivered ? "Delivered" : humanStatus(latestStatus);
    const carrierUrl = trackingNumber ? trackingUrlFallback(carrier, trackingNumber) : null;

    return (
      <article
        className={`overflow-hidden rounded-2xl border ${isDelivered ? "border-emerald-200 bg-emerald-50" : "border-sky-200 bg-sky-50"}`}
      >
        <header className={`border-b p-5 ${isDelivered ? "border-emerald-100" : "border-sky-100"}`}>
          <div className={`text-xs font-semibold uppercase tracking-wider ${isDelivered ? "text-emerald-700" : "text-sky-700"}`}>
            {isDelivered ? "Delivered" : "Delivery tracking"}
          </div>
          <div className={`mt-1 text-lg font-semibold ${isDelivered ? "text-emerald-900" : "text-sky-900"}`}>
            {headerStatus}
            {isDelivered && deliveredOn && (
              <span className="ml-2 text-sm font-normal text-emerald-800">on {deliveredOn}</span>
            )}
          </div>
          {trackingNumber && (
            <div className={`mt-2 text-xs ${isDelivered ? "text-emerald-800" : "text-sky-800"}`}>
              {carrier ? `${carrier} · ` : ""}
              <span className="font-mono">{trackingNumber}</span>
              {carrierUrl && (
                <>
                  {" · "}
                  <a
                    href={carrierUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold underline-offset-2 hover:underline"
                  >
                    Track on carrier site
                  </a>
                </>
              )}
            </div>
          )}
        </header>
        {events.length > 0 && (
          <ol className={`divide-y ${isDelivered ? "divide-emerald-100" : "divide-sky-100"}`}>
            {events.map((e, i) => {
              const when = humanDate(e.datetime);
              const where = [e.city, e.state].filter(Boolean).join(", ");
              return (
                <li key={i} className="p-4 sm:px-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className={`text-sm font-semibold ${isDelivered ? "text-emerald-900" : "text-sky-900"}`}>
                      {humanStatus(e.status)}
                    </div>
                    {when && (
                      <div className={`text-xs ${isDelivered ? "text-emerald-700" : "text-sky-700"}`}>
                        {when}
                      </div>
                    )}
                  </div>
                  {e.message && (
                    <div className={`mt-0.5 text-sm ${isDelivered ? "text-emerald-800" : "text-sky-800"}`}>
                      {e.message}
                    </div>
                  )}
                  {where && (
                    <div className={`mt-0.5 text-xs ${isDelivered ? "text-emerald-700" : "text-sky-700"}`}>
                      {where}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </article>
    );
  }

  // SHOPIFY branch — no milestones. Show the current shipment status +
  // tracking number + carrier + a link to the carrier's tracking page.
  const fulfillments = Array.isArray(delivery.fulfillments)
    ? (delivery.fulfillments as Fulfillment[])
    : [];
  // Pick the fulfillment with the most advanced status. If none, fall
  // back to the first (widget should still render for a shipped order
  // even if the shipmentStatus hasn't populated yet).
  const rank: Record<string, number> = {
    confirmed: 1,
    in_transit: 2,
    "out for delivery": 3,
    out_for_delivery: 3,
    delivered: 4,
  };
  let leading: Fulfillment | null = null;
  for (const f of fulfillments) {
    const s = (f.shipmentStatus || "").toLowerCase();
    if (!leading) leading = f;
    else if ((rank[s] || 0) > (rank[(leading.shipmentStatus || "").toLowerCase()] || 0)) leading = f;
  }
  if (!leading && fulfillments.length === 0) return null;

  const info = leading?.trackingInfo?.[0] || null;
  const num = trackingNumber || info?.number || null;
  const car = carrier || info?.company || null;
  const carrierUrl = info?.url || (num ? trackingUrlFallback(car, num) : null);
  const shipStatus = isDelivered ? "delivered" : (leading?.shipmentStatus || "").toLowerCase();
  const headerStatus = isDelivered ? "Delivered" : humanStatus(shipStatus || null);

  return (
    <article
      className={`overflow-hidden rounded-2xl border ${isDelivered ? "border-emerald-200 bg-emerald-50" : "border-sky-200 bg-sky-50"}`}
    >
      <header className={`border-b p-5 ${isDelivered ? "border-emerald-100" : "border-sky-100"}`}>
        <div className={`text-xs font-semibold uppercase tracking-wider ${isDelivered ? "text-emerald-700" : "text-sky-700"}`}>
          {isDelivered ? "Delivered" : "Shipment"}
        </div>
        <div className={`mt-1 text-lg font-semibold ${isDelivered ? "text-emerald-900" : "text-sky-900"}`}>
          {headerStatus}
          {isDelivered && deliveredOn && (
            <span className="ml-2 text-sm font-normal text-emerald-800">on {deliveredOn}</span>
          )}
        </div>
        {num && (
          <div className={`mt-2 text-xs ${isDelivered ? "text-emerald-800" : "text-sky-800"}`}>
            {car ? `${car} · ` : ""}
            <span className="font-mono">{num}</span>
          </div>
        )}
        {carrierUrl && (
          <a
            href={carrierUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`mt-2 inline-block text-sm font-semibold underline-offset-2 hover:underline ${isDelivered ? "text-emerald-800" : "text-sky-800"}`}
          >
            Track on carrier site →
          </a>
        )}
      </header>
    </article>
  );
}
