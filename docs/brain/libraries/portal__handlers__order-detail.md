# portal__handlers__order-detail

Portal order-detail handler (`src/lib/portal/handlers/order-detail.ts`) — reads a single order via the commerce SDK's `getOrder` and returns the full detail view for the order-detail page (`src/app/portal/[slug]/orders/[id]/page.tsx`).

## Authorization

The returned order MUST belong to the logged-in customer's link group. A stranger's order UUID returns 404 (never 403) — avoiding existence leaks.

## Response

Wraps the commerce SDK order with:
- **Line-item images** — enriched from the product/variant map, with fallback chains for missing product data.
- **Metadata fields** — tax, shipping protection, applied discount codes, financial status, fulfillment status, tracking.

See [[../tables/orders]] for the row schema.

## Integration

The in-house portal renders the response via `src/app/portal/[slug]/orders/[id]/page.tsx` (Phase 1 of [[portal-order-detail-page-widget-and-friendly-copy]]). The Shopify extension does not render a detail page today (reads orders via `subscriptionDetail` route).

## Related

[[portal-order-detail-page-widget-and-friendly-copy]] · [[../tables/orders]] · [[../integrations/commerce-sdk]]
