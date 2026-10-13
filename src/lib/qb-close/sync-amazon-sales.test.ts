/**
 * Pins `parseShippedUnits` — the shipped-vs-ordered rule that is the whole reason this module
 * exists separately from `amazon/sync-orders.ts`.
 *
 * The wedge: ShopCX's analytics parser counts Shipped + Shipping + PENDING (a demand question);
 * the close may only count units that actually left a warehouse (an inventory question). For
 * July 2026 those differ by 35% — 803 ordered vs 597 shipped — so wiring the analytics table into
 * the close would have overstated Amazon burn and COGS by a third.
 *
 * Run: npx tsx --test src/lib/qb-close/sync-amazon-sales.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AMAZON_REPORT_MAX_DAYS,
  assertNonEmptyAmazonCloseReport,
  parseShippedUnits,
  splitReportWindow,
  validateAmazonCloseReportHeaders,
} from "./sync-amazon-sales";

const HEADERS = ["amazon-order-id", "purchase-date", "order-status", "sku", "asin", "product-name", "quantity", "item-price", "promotion-ids"];
const row = (o: Partial<Record<string, string>>) =>
  HEADERS.map((h) => o[h] ?? "").join("\t");
const tsv = (...rows: string[]) => [HEADERS.join("\t"), ...rows].join("\n");

const base = { "purchase-date": "2026-07-15T10:00:00+00:00", sku: "SC-X", asin: "B01", quantity: "2", "item-price": "50.00" };

test("counts Shipped and Shipping, EXCLUDES Pending and Cancelled", () => {
  const { byKey, excluded } = parseShippedUnits(
    tsv(
      row({ ...base, "order-status": "Shipped" }),
      row({ ...base, "order-status": "Shipping" }),
      row({ ...base, "order-status": "Pending" }),
      row({ ...base, "order-status": "Cancelled" }),
    ),
  );
  const agg = byKey.get("B01|2026-07-15")!;
  assert.equal(agg.units, 4, "only the 2 shipped rows (2+2) should count");
  assert.equal(excluded, 4, "pending + cancelled units are reported, not silently dropped");
});

test("status matching is case-insensitive", () => {
  const { byKey } = parseShippedUnits(tsv(row({ ...base, "order-status": "SHIPPED" }), row({ ...base, "order-status": "shipping" })));
  assert.equal(byKey.get("B01|2026-07-15")!.units, 4);
});

test("groups by (asin, sale_date) and buckets by promotion", () => {
  const { byKey } = parseShippedUnits(
    tsv(
      row({ ...base, "order-status": "Shipped", "promotion-ids": "FBA Subscribe & Save Discount" }),
      row({ ...base, "order-status": "Shipped", "promotion-ids": "Subscribe and Save Promotion V2" }),
      row({ ...base, "order-status": "Shipped", "promotion-ids": "" }),
      row({ ...base, "order-status": "Shipped", asin: "B02" }),
      row({ ...base, "order-status": "Shipped", "purchase-date": "2026-07-16T09:00:00+00:00" }),
    ),
  );
  const a = byKey.get("B01|2026-07-15")!;
  assert.equal(a.units, 6);
  assert.equal(a.recurringUnits, 2);
  assert.equal(a.snsUnits, 2);
  assert.equal(a.oneTimeUnits, 2);
  assert.equal(a.recurringUnits + a.snsUnits + a.oneTimeUnits, a.units, "buckets must sum to total");
  assert.ok(byKey.has("B02|2026-07-15"), "a different ASIN is its own group");
  assert.ok(byKey.has("B01|2026-07-16"), "a different day is its own group");
});

test("matches Amazon's '&' spelling of the S&S promotion", () => {
  // Amazon writes "&" in the report data; the "and" spelling appears in docs. Both must bucket
  // as recurring or subscription revenue silently lands in one_time.
  for (const promo of ["FBA Subscribe & Save Discount", "FBA Subscribe and Save Discount"]) {
    const { byKey } = parseShippedUnits(tsv(row({ ...base, "order-status": "Shipped", "promotion-ids": promo })));
    assert.equal(byKey.get("B01|2026-07-15")!.recurringUnits, 2, promo);
  }
});

test("skips zero-quantity, blank-asin and blank-date rows without throwing", () => {
  const { byKey } = parseShippedUnits(
    tsv(
      row({ ...base, "order-status": "Shipped", quantity: "0" }),
      row({ ...base, "order-status": "Shipped", asin: "" }),
      row({ ...base, "order-status": "Shipped", "purchase-date": "" }),
      row({ ...base, "order-status": "Shipped" }),
    ),
  );
  assert.equal(byKey.size, 1);
  assert.equal(byKey.get("B01|2026-07-15")!.units, 2);
});

test("an empty or header-only report yields nothing rather than throwing", () => {
  assert.equal(parseShippedUnits("").byKey.size, 0);
  assert.equal(parseShippedUnits(HEADERS.join("\t")).byKey.size, 0);
});

test("validateAmazonCloseReportHeaders throws clearly when a required header is missing", () => {
  const missing = HEADERS.filter((h) => h !== "order-status");
  assert.throws(() => validateAmazonCloseReportHeaders(missing), /order-status/);
  // Independent of the exported helper: the parser must refuse a malformed TSV so a column
  // shift cannot write garbage into qb_amazon_sales_snapshots.
  const malformed = [missing.join("\t"), missing.map((h) => (h === "quantity" ? "2" : "x")).join("\t")].join("\n");
  assert.throws(() => parseShippedUnits(malformed), /order-status/);
});

test("validateAmazonCloseReportHeaders accepts a valid header set (product-name optional)", () => {
  // product-name is written when present but is not required — older marketplace exports omit it.
  const withoutProductName = HEADERS.filter((h) => h !== "product-name");
  assert.doesNotThrow(() => validateAmazonCloseReportHeaders(withoutProductName));
  assert.doesNotThrow(() => validateAmazonCloseReportHeaders(HEADERS));
});

/**
 * The thinnest possible SupabaseClient stub — only the chain `assertNonEmptyAmazonCloseReport`
 * walks. Returning the fed rows on the terminal `.limit(1)` is enough to exercise the two
 * branches that matter (prior data vs cold start).
 */
function fakeAdminWith(rows: Array<{ id: string }>): SupabaseClient {
  const resolver = Promise.resolve({ data: rows, error: null });
  const builder: Record<string, unknown> = {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    lte: () => builder,
    limit: () => resolver,
  };
  return builder as unknown as SupabaseClient;
}

test("assertNonEmptyAmazonCloseReport is a no-op when the merged parse has rows", async () => {
  // Non-zero parse → should NOT touch the DB; a stub that would reject on query proves it.
  const neverQuery = { from: () => { throw new Error("should not query when parse is non-empty"); } } as unknown as SupabaseClient;
  await assertNonEmptyAmazonCloseReport(neverQuery, "ws-1", "2026-09-01", "2026-10-04", 5);
});

test("assertNonEmptyAmazonCloseReport is a no-op on a cold window (no prior data)", async () => {
  // A brand-new workspace or first-ever sync against this window is legitimately empty.
  const admin = fakeAdminWith([]);
  await assertNonEmptyAmazonCloseReport(admin, "ws-1", "2026-09-01", "2026-10-04", 0);
});

test("assertNonEmptyAmazonCloseReport throws when parsed is empty but prior rows exist in window", async () => {
  const admin = fakeAdminWith([{ id: "snapshot-1" }]);
  await assert.rejects(
    () => assertNonEmptyAmazonCloseReport(admin, "ws-1", "2026-09-01", "2026-10-04", 0),
    /parsed 0 shipped rows.*existing/i,
  );
});

test("assertNonEmptyAmazonCloseReport surfaces a Supabase probe error rather than silently passing", async () => {
  const probeError: SupabaseClient = (() => {
    const resolver = Promise.resolve({ data: null, error: { message: "boom" } });
    const builder: Record<string, unknown> = {
      from: () => builder, select: () => builder, eq: () => builder, gte: () => builder, lte: () => builder, limit: () => resolver,
    };
    return builder as unknown as SupabaseClient;
  })();
  await assert.rejects(
    () => assertNonEmptyAmazonCloseReport(probeError, "ws-1", "2026-09-01", "2026-10-04", 0),
    /probe failed.*boom/i,
  );
});

// SP-API returns "Date range exceeded. Report can be requested only upto 30 days" for longer
// windows, and the close's 35-day lookback hit it on every cron run.
test("splitReportWindow keeps a <=30-day window as one chunk", () => {
  assert.deepEqual(splitReportWindow("2026-09-01", "2026-09-30"), [{ start: "2026-09-01", end: "2026-09-30" }]);
  assert.deepEqual(splitReportWindow("2026-09-05", "2026-09-05"), [{ start: "2026-09-05", end: "2026-09-05" }]);
});

test("splitReportWindow splits the 35-day close lookback into contiguous, non-overlapping chunks", () => {
  const chunks = splitReportWindow("2026-09-02", "2026-10-07");
  assert.deepEqual(chunks, [
    { start: "2026-09-02", end: "2026-10-01" },
    { start: "2026-10-02", end: "2026-10-07" },
  ]);
  const days = (c: { start: string; end: string }) =>
    (Date.parse(`${c.end}T00:00:00Z`) - Date.parse(`${c.start}T00:00:00Z`)) / 86_400_000 + 1;
  for (const c of chunks) assert.ok(days(c) <= AMAZON_REPORT_MAX_DAYS);
});

test("splitReportWindow handles multi-chunk windows across month and year ends", () => {
  const chunks = splitReportWindow("2026-11-20", "2027-02-10");
  for (let i = 1; i < chunks.length; i++) {
    const next = new Date(`${chunks[i - 1].end}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    assert.equal(chunks[i].start, next.toISOString().slice(0, 10));
  }
  assert.equal(chunks[0].start, "2026-11-20");
  assert.equal(chunks.at(-1)!.end, "2027-02-10");
});
