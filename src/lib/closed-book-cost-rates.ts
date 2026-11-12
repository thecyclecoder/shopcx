/**
 * Closed-book cost rates — the single chokepoint that turns the real QuickBooks books into the
 * per-channel variable cost rates the ROAS margin calculator (and, later, the CEO scoreboard) consume.
 *
 * The calculator used to run on typed-in guesses (COGS 17%, Shipping 15%, Amazon fees 25%), which
 * misstate lifetime profit per customer. This library instead reads the trailing N CLOSED months of
 * qb_pnl_snapshots (the only trustworthy P&L — mid-month QBO is distorted; see
 * docs/brain/tables/qb_pnl_snapshots.md) plus the matching channel sales snapshots for denominators,
 * and returns a blended variable-cost rate per channel. One chokepoint → the calculator and the
 * scoreboard read the SAME numbers, with no hand-rolled queries scattered across callers.
 *
 * Rates are POOLED across the N months (Σ cost ÷ Σ sales) — the exposure-weighted blended rate, not a
 * mean-of-monthly-ratios, so a small month can't distort the average.
 *
 * Line extraction reuses the quickbooks.ts matchers over the stored `raw` report (findAmountByName /
 * sumAmountsByName) — NO QBO round-trip. See docs/brain/libraries/closed-book-cost-rates.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { findAmountByName, sumAmountsByName } from "@/lib/quickbooks";

type Admin = SupabaseClient;

/** Per-channel variable cost rates (fractions 0–1), blended over the trailing N closed months. */
export interface ClosedBookCostRates {
  /** The period_month strings the rates were averaged over, oldest→newest (e.g. ["2026-07-01",...]). */
  months: string[];
  /** Website (Shopify storefront + ShopCX-native, all Amplifier-fulfilled) variable cost rates. */
  website: {
    /** (Products COGS + Inventory Shrinkage) × website sales-share ÷ website sales. */
    cogsPct: number;
    /** Fulfillment - Amplifier total ÷ website sales (Amplifier ships website/internal only). */
    fulfillmentPct: number;
    /** Shopify + PayPal + Braintree platform transaction fees ÷ website sales. */
    txFeePct: number;
  };
  /** Amazon (FBA-fulfilled marketplace) variable cost rates. */
  amazon: {
    /** (Products COGS + Inventory Shrinkage) × Amazon sales-share ÷ Amazon sales. */
    cogsPct: number;
    /** Amazon FBA Fees ÷ Amazon sales. */
    fbaFeePct: number;
    /** The Amazon Seller line inside Platform Transaction Fees ÷ Amazon sales. */
    sellerFeePct: number;
  };
}

// P&L line matchers (name-based, like quickbooks.ts — survive a re-nesting, break on an account rename).
/** "51000 Products COGS". */
const PRODUCTS_COGS_MATCHER = /products\s+cogs/i;
/** "53100 Inventory Shrinkage" (only shrinkage — NOT the ending-inventory true-up). */
const INVENTORY_SHRINKAGE_MATCHER = /inventory\s+shrinkage/i;
/** "52200 Fulfillment - Amplifier" group total (52210/52220/52230) — Amplifier ships website/internal. */
const FULFILLMENT_AMPLIFIER_MATCHER = /fulfillment.*amplifier/i;
/** "52100 Amazon FBA Fees" (a variable COGS line, not OpEx). */
const AMAZON_FBA_FEES_MATCHER = /amazon\s+fba\s+fees/i;
/** The "Amazon Seller" line inside the 61508 Platform Transaction Fees group. */
const AMAZON_SELLER_FEE_MATCHER = /amazon\s+seller/i;
/** The website payment-processor lines inside 61508 Platform Transaction Fees (Shopify/PayPal/Braintree). */
const WEBSITE_TX_FEE_MATCHER = /\b(shopify|paypal|braintree)\b/i;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Last day of a `YYYY-MM-01` period as `YYYY-MM-DD` (UTC). */
function lastDayOfMonth(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)); // day 0 of the next month = last day of this one
  return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, "0")}-${String(last.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The newest CLOSED month we trust, as a `YYYY-MM-01` string. Normally the previous calendar month,
 * but QuickBooks' month-end entries (inventory/COGS) don't fully land until ~the 15th — so before the
 * 15th the previous month's books are premature and we step back one more month (the close gotcha on
 * docs/brain/tables/qb_pnl_snapshots.md).
 */
function newestTrustedMonth(asOf: Date): string {
  let y = asOf.getUTCFullYear();
  let m0 = asOf.getUTCMonth() - 1; // previous (last fully-elapsed) month
  if (asOf.getUTCDate() < 15) m0 -= 1; // pre-15th: last month not fully closed yet
  while (m0 < 0) { m0 += 12; y -= 1; }
  return `${y}-${String(m0 + 1).padStart(2, "0")}-01`;
}

/**
 * Per-channel variable cost rates blended over the trailing `months` CLOSED months of QuickBooks P&L.
 *
 * COGS (Products COGS + Inventory Shrinkage) is split across channels by each channel's share of gross
 * product sales; fulfillment and tx fees are charged to the website channel, FBA + seller fees to
 * Amazon. "Website sales" = Shopify + ShopCX-native (internal) gross; "Amazon sales" = Amazon gross —
 * all from the channel sales snapshots. Returns `null` when fewer than 1 trusted closed month exists.
 */
export async function getClosedBookCostRates(
  workspaceId: string,
  months = 3,
  admin: Admin = createAdminClient(),
  asOf: Date = new Date(),
): Promise<ClosedBookCostRates | null> {
  const cutoff = newestTrustedMonth(asOf);

  const { data: snaps } = await admin
    .from("qb_pnl_snapshots")
    .select("period_month, raw")
    .eq("workspace_id", workspaceId)
    .lte("period_month", cutoff)
    .order("period_month", { ascending: false })
    .limit(months);

  const rows = (snaps ?? []).slice().reverse(); // oldest→newest
  if (rows.length < 1) return null;

  const start = rows[0].period_month as string;
  const end = lastDayOfMonth(rows[rows.length - 1].period_month as string);

  // Channel sales denominators, pooled over the same span. Website = Shopify + ShopCX-native (internal).
  const shopifyGross = await sumColumn(admin, "qb_shopify_sales_snapshots", "revenue", workspaceId, start, end);
  const amazonGross = await sumColumn(admin, "qb_amazon_sales_snapshots", "revenue", workspaceId, start, end);
  const internalGrossCents = await sumColumn(admin, "qb_internal_sales_snapshots", "gross_cents", workspaceId, start, end);
  const websiteSales = shopifyGross + internalGrossCents / 100;
  const amazonSales = amazonGross;
  const grossProductSales = websiteSales + amazonSales;

  // Pooled P&L cost numerators over the N months, extracted from the stored raw report by name.
  let productsCogs = 0, inventoryShrinkage = 0, fulfillment = 0, amazonFba = 0, amazonSeller = 0, websiteTxFees = 0;
  for (const row of rows) {
    const raw = (row as { raw: unknown }).raw;
    productsCogs += findAmountByName(raw, PRODUCTS_COGS_MATCHER) ?? 0;
    inventoryShrinkage += findAmountByName(raw, INVENTORY_SHRINKAGE_MATCHER) ?? 0;
    fulfillment += findAmountByName(raw, FULFILLMENT_AMPLIFIER_MATCHER) ?? 0;
    amazonFba += findAmountByName(raw, AMAZON_FBA_FEES_MATCHER) ?? 0;
    amazonSeller += findAmountByName(raw, AMAZON_SELLER_FEE_MATCHER) ?? 0;
    websiteTxFees += sumAmountsByName(raw, WEBSITE_TX_FEE_MATCHER) ?? 0;
  }

  // COGS is split by each channel's share of gross product sales.
  const cogsTotal = productsCogs + inventoryShrinkage;
  const websiteShare = grossProductSales > 0 ? websiteSales / grossProductSales : 0;
  const amazonShare = grossProductSales > 0 ? amazonSales / grossProductSales : 0;
  const websiteCogs = cogsTotal * websiteShare;
  const amazonCogs = cogsTotal * amazonShare;

  const pct = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : 0);

  return {
    months: rows.map((r) => r.period_month as string),
    website: {
      cogsPct: pct(websiteCogs, websiteSales),
      fulfillmentPct: pct(fulfillment, websiteSales),
      txFeePct: pct(websiteTxFees, websiteSales),
    },
    amazon: {
      cogsPct: pct(amazonCogs, amazonSales),
      fbaFeePct: pct(amazonFba, amazonSales),
      sellerFeePct: pct(amazonSeller, amazonSales),
    },
  };
}

/** Sum one numeric column of a per-day sales snapshot table over a [start,end] sale_date range. */
async function sumColumn(
  admin: Admin,
  table: "qb_shopify_sales_snapshots" | "qb_amazon_sales_snapshots" | "qb_internal_sales_snapshots",
  column: "revenue" | "gross_cents",
  workspaceId: string,
  start: string,
  end: string,
): Promise<number> {
  const { data } = await admin
    .from(table)
    .select(column)
    .eq("workspace_id", workspaceId)
    .gte("sale_date", start)
    .lte("sale_date", end);
  return (data ?? []).reduce((sum: number, r: Record<string, unknown>) => sum + num(r[column]), 0);
}
