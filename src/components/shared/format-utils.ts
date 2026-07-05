/**
 * Shared formatting utilities used across dashboard detail pages.
 */

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Format a calendar-date field that is stored as UTC midnight — e.g. a
 * subscription's next_billing_date. Pin to UTC so it renders as the intended
 * calendar day regardless of the viewer's timezone, matching the customer
 * portal's fmtDate (shopify-extension/portal-src/js/core/utils.js) and the
 * billing cron (which compares next_billing_date as a UTC calendar date).
 *
 * A plain toLocaleDateString() renders 2026-07-29T00:00:00Z as "Jul 28" for a
 * US viewer — the off-by-one that made the dashboard disagree with the portal.
 *
 * Do NOT use this for real timestamps (created_at, *_at) — those are genuine
 * moments and should render in the viewer's local time via formatDate.
 */
export function formatOrderDate(dateStr: string | null, withYear = true): string {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" as const } : {}),
    timeZone: "UTC",
  });
}

export function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Format a subscription item's display name.
 * - If variant_title exists: "Product Name — Variant" (e.g. "Superfood Tabs — Strawberry Lemonade")
 * - If variant_title is missing: just title (handles legacy combined format like "Superfood Tabs - Mixed Berry")
 */
export function formatItemName(item: { title?: string | null; variant_title?: string | null }): string {
  const title = item.title || "Item";
  if (item.variant_title) return `${title} — ${item.variant_title}`;
  return title;
}
