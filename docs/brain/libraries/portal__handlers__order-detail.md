# portal__handlers__order-detail

Portal order-detail handler (`src/lib/portal/handlers/order-detail.ts`) — reads a single order via the commerce SDK's `getOrder` and returns the full detail view for the order-detail page (`src/app/portal/[slug]/orders/[id]/page.tsx`).

## Authorization

The returned order MUST belong to the logged-in customer's link group. A stranger's order UUID returns 404 (never 403) — avoiding existence leaks.

## Response

Wraps the commerce SDK order with:
- **Line-item images** — enriched from the product/variant map, with fallback chains for missing product data.
- **Metadata fields** — tax, shipping protection, applied discount codes, financial status, fulfillment status.
- **Delivery tracking** ([[portal-order-detail-tracking-widget]] Phase 2) — server-side delivery resolver keyed per order on `shopify_order_id`:
  - **INTERNAL** (shopify_order_id NULL) with tracking: on first visit, calls EasyPost Tracker and caches milestone events in `orders.easypost_tracking` + `easypost_checked_at` (throttled once per UTC day, no repeat cost). On delivered, sets `delivered_at` and stops future lookups. On EasyPost error, returns no tracking widget (fail-open).
  - **SHOPIFY** (shopify_order_id present): reads synced fulfillments (`shipmentStatus` + `trackingInfo`); if not yet delivered, does a free Shopify GraphQL fulfillment refresh and updates stored fulfillments. When delivered, sets `delivered_at`. No EasyPost call on this branch.

## Integration

The in-house portal renders the response via `src/app/portal/[slug]/orders/[id]/page.tsx`. The page includes:
- **Phase 1** ([[portal-order-detail-page-widget-and-friendly-copy]]) — order detail surface (line items, totals, address).
- **Phase 3** ([[portal-order-detail-tracking-widget]]) — tracking widget renders EasyPost milestone timeline (INTERNAL) or shipment status + carrier link (SHOPIFY); shows "Delivered" state when confirmed. Only visible on SHIPPED orders.

The Shopify extension does not render a detail page today (reads orders via `subscriptionDetail` route).

## Related

[[portal-order-detail-tracking-widget]] · [[portal-order-detail-page-widget-and-friendly-copy]] · [[../tables/orders]] · [[../integrations/commerce-sdk]] · [[../integrations/easypost]]
