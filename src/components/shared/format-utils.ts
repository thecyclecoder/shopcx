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
