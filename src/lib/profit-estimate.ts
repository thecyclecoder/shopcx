/**
 * Profit for the Analytics → Profit page.
 *
 * Two modes, because QuickBooks only closes whole months:
 *
 *  - **Closed month** → read `qb_pnl_snapshots` and return the ACTUALS. No
 *    modelling at all. The headline is `adjusted_net_income`
 *    (= `net_income + management_fees`) — the founder's "real profit": the
 *    management fee is an intercompany PR→TX transfer-pricing charge, not a
 *    real economic cost, so it's added back. See
 *    docs/brain/tables/qb_pnl_snapshots.md § The two profit lines.
 *
 *  - **Current (in-progress) month** → estimate. QBO mid-month is distorted by
 *    pending month-end entries, so we never read it. Instead every cost factor
 *    is CALIBRATED from the last N closed QBO months, and revenue is projected
 *    per-stream:
 *      · renewals      — anniversary-dated, so realized-to-date + the rest
 *                        projected off the same days last month (projectRenewalRest)
 *      · new checkouts — run-rate from complete days so far
 *      · amazon        — run-rate from complete days so far
 *
 * This replaces the previous page, which hardcoded COGS 17% / shipping 15% /
 * discounts 12% / Shopify-tx 3% / Amazon-fee 25% / G&A $54,542 and counted only
 * Meta ad spend. Those constants drifted badly: for July 2026 that model
 * reported $46,065 against a QuickBooks adjusted net income of $65,458, and the
 * "fixed" G&A line has ranged $53K-$110K over the trailing 15 months.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** How many closed QBO months feed the calibration averages. */
export const CALIBRATION_MONTHS = 3;

/** Fallbacks used only when no closed QBO month exists at all (fresh workspace). */
export const FALLBACK_CALIBRATION: ProfitCalibration = {
  incomeRatio: 0.91,
  cogsRatio: 0.31,
  txnFeeRatio: 0.06,
  adSpendRatio: 1.07,
  fixedOpexCents: 5_800_000,
  managementFeesCents: 0,
  otherNetCents: 0,
  renewalCollectionRate: 0.65,
  monthsUsed: [],
};

export interface ProfitCalibration {
  /** QBO `total_income` ÷ our internal gross revenue. Absorbs refunds / discounts / chargebacks (they're contra-revenue accounts in QBO) so we never guess a discount %. */
  incomeRatio: number;
  /** QBO `total_cogs` ÷ QBO `total_income`. Product + shipping + fulfilment, as actually booked. */
  cogsRatio: number;
  /** QBO `transaction_fees` ÷ QBO `total_income`. Shopify / Amazon / PayPal / Braintree / Walmart. */
  txnFeeRatio: number;
  /** QBO `digital_advertising` ÷ our Meta spend. Scales Meta-only spend up to all channels (Google / Amazon / TikTok). */
  adSpendRatio: number;
  /** Trailing mean of QBO `fixed_opex`, in cents. The honest cost-to-operate line. */
  fixedOpexCents: number;
  /** Trailing mean of QBO `management_fees`, in cents — the addback. */
  managementFeesCents: number;
  /** Trailing mean of (`adjusted_net_income` − `net_operating_income`), in cents. Small non-management other income/expense. */
  otherNetCents: number;
  /** Realized ÷ expected on the renewal book (dunning recovery counted as realized). */
  renewalCollectionRate: number;
  /** Which closed months produced these factors. */
  monthsUsed: string[];
}

export interface ProfitLines {
  incomeCents: number;
  cogsCents: number;
  grossProfitCents: number;
  digitalAdvertisingCents: number;
  transactionFeesCents: number;
  fixedOpexCents: number;
  netOperatingIncomeCents: number;
  managementFeesCents: number;
  /** One-off "Prior Year Adjustment" true-up (positive expense). Added back with the management fee; always 0 in an estimate. */
  priorYearAdjustmentsCents: number;
  /** Booked net profit, as QuickBooks reports it. Steered ≤ $0 per fiscal year for US tax. */
  netIncomeCents: number;
  /** `netIncome + managementFees + priorYearAdjustments` — real economic profit. THE headline. */
  adjustedNetIncomeCents: number;
}

export interface RevenueBreakdown {
  renewalCents: number;
  newCheckoutCents: number;
  amazonCents: number;
  internalGrossCents: number;
}

export interface ProfitResult {
  periodMonth: string;
  source: "quickbooks" | "estimate";
  isComplete: boolean;
  daysElapsed: number;
  daysInMonth: number;
  lines: ProfitLines;
  revenue: RevenueBreakdown | null;
  calibration: ProfitCalibration | null;
  /** Per-stream projection detail, so the UI can show what's actual vs projected. */
  projection: {
    renewalRealizedCents: number;
    /** Pending rows still on the billing book. Informational only — it holds ~2/3 of what really bills. */
    renewalForwardBookCents: number;
    /** Renewals projected for the remaining days (see projectRenewalRest). */
    renewalRestCents: number;
    /** Last month's renewals on the same days already elapsed, and on its remaining days. */
    renewalPrevSameDaysCents: number;
    renewalPrevRestCents: number;
    renewalProjectedCents: number;
    newCheckoutToDateCents: number;
    amazonToDateCents: number;
    metaSpendToDateCents: number;
  } | null;
  flags: string[];
}

// ── date helpers (Central time — matches the snapshot crons) ────────────────

/** `YYYY-MM-DD` for "today" in Central time. */
export function centralToday(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

/** First day of the month containing `day`. */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Last day of the month containing `day`. */
export function monthEnd(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Days in the month containing `day`. */
export function daysInMonth(day: string): number {
  return Number(monthEnd(day).slice(8, 10));
}

/** The day before `day`. */
export function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

/** The day after `day`. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

// ── pure model ─────────────────────────────────────────────────────────────

/**
 * Turn projected revenue + calibration factors into a full P&L. PURE — no DB,
 * no clock — so the math is unit-pinnable against fixture inputs.
 *
 * `netIncome` is derived by SUBTRACTING the management fee from operating
 * income, then `adjustedNetIncome` adds it straight back. That looks circular
 * but it isn't: the two lines are what the CEO scoreboard watches in opposite
 * directions (booked ≤ $0 per fiscal year; adjusted grown), so both must exist
 * even in an estimate.
 */
export function computeProfitLines(
  internalGrossCents: number,
  metaSpendCents: number,
  cal: ProfitCalibration,
): ProfitLines {
  const incomeCents = Math.round(internalGrossCents * cal.incomeRatio);
  const cogsCents = Math.round(incomeCents * cal.cogsRatio);
  const grossProfitCents = incomeCents - cogsCents;
  const digitalAdvertisingCents = Math.round(metaSpendCents * cal.adSpendRatio);
  const transactionFeesCents = Math.round(incomeCents * cal.txnFeeRatio);
  const fixedOpexCents = Math.round(cal.fixedOpexCents);
  const netOperatingIncomeCents =
    grossProfitCents - digitalAdvertisingCents - transactionFeesCents - fixedOpexCents;
  const managementFeesCents = Math.round(cal.managementFeesCents);
  const adjustedNetIncomeCents = netOperatingIncomeCents + Math.round(cal.otherNetCents);
  const netIncomeCents = adjustedNetIncomeCents - managementFeesCents;
  return {
    incomeCents,
    cogsCents,
    grossProfitCents,
    digitalAdvertisingCents,
    transactionFeesCents,
    fixedOpexCents,
    netOperatingIncomeCents,
    managementFeesCents,
    priorYearAdjustmentsCents: 0,
    netIncomeCents,
    adjustedNetIncomeCents,
  };
}

/**
 * Project the renewal revenue still to come this month. PURE.
 *
 * Renewals recur on each sub's anniversary date, so the same days last month
 * are the best guide to the rest of this one. Two estimates, averaged:
 *   · last month's remaining days, scaled to this month's remaining day count
 *     and by this month's pace (this month-to-date ÷ last month same days)
 *   · this month's own daily run rate over the remaining days
 *
 * Backtested over 14 months × day 10/18/25 cuts (42 cases): 7.7% mean absolute
 * error on the remaining renewals. Last-month-pace alone was 8.5%, run rate
 * alone 9.6%. The previous method (pending billing-book rows × collection
 * rate) double-discounted: in Oct 2026 the book held ~2/3 of what really bills,
 * then the 65% rate cut it again, projecting $31.7K for Oct 19-31 against
 * ~$62K that billed in the same days of September.
 */
export function projectRenewalRest(
  realizedCents: number,
  completeDays: number,
  totalDays: number,
  prevSameDaysCents: number,
  prevRestCents: number,
  prevTotalDays: number,
): number {
  const remaining = totalDays - completeDays;
  if (remaining <= 0 || completeDays <= 0) return 0;
  const runRate = (realizedCents / completeDays) * remaining;
  const prevRemaining = prevTotalDays - completeDays;
  if (prevSameDaysCents <= 0 || prevRemaining <= 0) return Math.round(runRate);
  const lastMonth = prevRestCents * (remaining / prevRemaining) * (realizedCents / prevSameDaysCents);
  return Math.round((lastMonth + runRate) / 2);
}

/**
 * Project a full-month total from a partial-month run rate. PURE.
 *
 * `completeDays` deliberately excludes today — a partial day would drag the
 * daily rate down and understate the month.
 */
export function projectFromRunRate(
  toDateCents: number,
  completeDays: number,
  totalDays: number,
): number {
  if (completeDays <= 0) return 0;
  const remaining = totalDays - completeDays;
  const perDay = toDateCents / completeDays;
  return Math.round(toDateCents + perDay * remaining);
}

/** Mean of the non-null numbers, or `null` when there are none. */
function mean(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export interface CalibrationInput {
  periodMonth: string;
  totalIncome: number | null;
  totalCogs: number | null;
  transactionFees: number | null;
  digitalAdvertising: number | null;
  fixedOpex: number | null;
  managementFees: number | null;
  netOperatingIncome: number | null;
  adjustedNetIncome: number | null;
  /** Our own gross revenue for the same month (dollars) — Shopify + Amazon snapshots. */
  internalGross: number;
  /** Our own Meta spend for the same month (dollars). */
  metaSpend: number;
}

/**
 * Average the per-month ratios into one calibration. PURE.
 *
 * Ratios are averaged per-month rather than computed from summed totals so a
 * single outsized month can't dominate the factor.
 */
export function deriveCalibration(
  months: CalibrationInput[],
  renewalCollectionRate: number,
): ProfitCalibration {
  if (!months.length) return { ...FALLBACK_CALIBRATION, renewalCollectionRate };
  const ratio = (f: (m: CalibrationInput) => number | null) => mean(months.map(f));

  return {
    incomeRatio:
      ratio((m) => (m.totalIncome != null && m.internalGross > 0 ? m.totalIncome / m.internalGross : null)) ??
      FALLBACK_CALIBRATION.incomeRatio,
    cogsRatio:
      ratio((m) => (m.totalCogs != null && m.totalIncome ? m.totalCogs / m.totalIncome : null)) ??
      FALLBACK_CALIBRATION.cogsRatio,
    txnFeeRatio:
      ratio((m) => (m.transactionFees != null && m.totalIncome ? m.transactionFees / m.totalIncome : null)) ??
      FALLBACK_CALIBRATION.txnFeeRatio,
    adSpendRatio:
      ratio((m) => (m.digitalAdvertising != null && m.metaSpend > 0 ? m.digitalAdvertising / m.metaSpend : null)) ??
      FALLBACK_CALIBRATION.adSpendRatio,
    fixedOpexCents: Math.round(((ratio((m) => m.fixedOpex) ?? FALLBACK_CALIBRATION.fixedOpexCents / 100) * 100)),
    managementFeesCents: Math.round((ratio((m) => m.managementFees) ?? 0) * 100),
    otherNetCents: Math.round(
      (ratio((m) =>
        m.adjustedNetIncome != null && m.netOperatingIncome != null
          ? m.adjustedNetIncome - m.netOperatingIncome
          : null,
      ) ?? 0) * 100,
    ),
    renewalCollectionRate,
    monthsUsed: months.map((m) => m.periodMonth),
  };
}

// ── DB readers ─────────────────────────────────────────────────────────────

/** Sum numeric columns off a `snapshot_date`-keyed daily table, paging past the 1000-row cap. */
async function sumDaily(
  admin: Admin,
  table: string,
  cols: string[],
  workspaceId: string,
  from: string,
  to: string,
): Promise<number> {
  let total = 0;
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin
      .from(table)
      .select(cols.join(","))
      .eq("workspace_id", workspaceId)
      .gte("snapshot_date", from)
      .lte("snapshot_date", to)
      .range(offset, offset + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const row of (data ?? []) as unknown as Record<string, number>[]) {
      for (const c of cols) total += Number(row[c] ?? 0);
    }
    if (!data || data.length < 1000) break;
  }
  return total;
}

interface ForecastRow {
  expected_revenue_cents: number | null;
  actual_revenue_cents: number | null;
  status: string;
  forecast_type: string | null;
}

/** Paged read of the billing book over an `expected_date` window. */
async function readForecasts(
  admin: Admin,
  workspaceId: string,
  from: string,
  to: string,
): Promise<ForecastRow[]> {
  const out: ForecastRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin
      .from("billing_forecasts")
      .select("expected_revenue_cents,actual_revenue_cents,status,forecast_type")
      .eq("workspace_id", workspaceId)
      .gte("expected_date", from)
      .lte("expected_date", to)
      .range(offset, offset + 999);
    if (error) throw new Error(`billing_forecasts: ${error.message}`);
    out.push(...((data ?? []) as unknown as ForecastRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * A `dunning` row is a RETRY of an already-counted renewal — including it in
 * "expected" double-counts the same subscription many times over. A `paused`
 * row is not expected to bill at all. Both are excluded from the expected
 * book; dunning *recoveries* still count as realized revenue.
 */
function isRenewalBookRow(r: ForecastRow): boolean {
  return r.forecast_type !== "dunning" && r.forecast_type !== "paused";
}

/** Realized ÷ expected on the renewal book over a window, dunning recovery included in the numerator. */
export async function readRenewalCollectionRate(
  admin: Admin,
  workspaceId: string,
  from: string,
  to: string,
): Promise<number | null> {
  const rows = await readForecasts(admin, workspaceId, from, to);
  let expected = 0;
  let realized = 0;
  for (const r of rows) {
    if (isRenewalBookRow(r)) expected += Number(r.expected_revenue_cents ?? 0);
    realized += Number(r.actual_revenue_cents ?? 0);
  }
  if (expected <= 0) return null;
  return realized / expected;
}

/** The last `n` fully-elapsed months, oldest→newest, relative to `today`. */
export function lastClosedMonths(n: number, today: string): string[] {
  const out: string[] = [];
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  for (let i = n; i >= 1; i--) {
    out.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 10));
  }
  return out;
}

interface PnlSnapshot {
  period_month: string;
  total_income: number | null;
  total_cogs: number | null;
  gross_profit: number | null;
  total_expenses: number | null;
  net_operating_income: number | null;
  net_income: number | null;
  management_fees: number | null;
  prior_year_adjustments: number | null;
  adjusted_net_income: number | null;
  digital_advertising: number | null;
  transaction_fees: number | null;
  fixed_opex: number | null;
}

const PNL_COLS =
  "period_month,total_income,total_cogs,gross_profit,total_expenses,net_operating_income,net_income,management_fees,prior_year_adjustments,adjusted_net_income,digital_advertising,transaction_fees,fixed_opex";

const d2c = (v: number | null | undefined) => Math.round(Number(v ?? 0) * 100);

/** Read one closed month's QuickBooks actuals. Returns null when un-snapshotted. */
export async function getClosedMonthProfit(
  admin: Admin,
  workspaceId: string,
  periodMonth: string,
): Promise<ProfitResult | null> {
  const { data, error } = await admin
    .from("qb_pnl_snapshots")
    .select(PNL_COLS)
    .eq("workspace_id", workspaceId)
    .eq("period_month", periodMonth)
    .maybeSingle();
  if (error) throw new Error(`qb_pnl_snapshots: ${error.message}`);
  if (!data) return null;
  const qb = data as unknown as PnlSnapshot;

  const flags: string[] = [];
  if (qb.management_fees == null) {
    flags.push("No management-fee line this month — the addback equals booked net income.");
  }
  if (qb.prior_year_adjustments) {
    flags.push(
      `One-off prior-year adjustment of $${Math.round(Number(qb.prior_year_adjustments)).toLocaleString()} added back — it is not this month's economics.`,
    );
  }

  return {
    periodMonth,
    source: "quickbooks",
    isComplete: true,
    daysElapsed: daysInMonth(periodMonth),
    daysInMonth: daysInMonth(periodMonth),
    lines: {
      incomeCents: d2c(qb.total_income),
      cogsCents: d2c(qb.total_cogs),
      grossProfitCents: d2c(qb.gross_profit),
      digitalAdvertisingCents: d2c(qb.digital_advertising),
      transactionFeesCents: d2c(qb.transaction_fees),
      fixedOpexCents: d2c(qb.fixed_opex),
      netOperatingIncomeCents: d2c(qb.net_operating_income),
      managementFeesCents: d2c(qb.management_fees),
      priorYearAdjustmentsCents: d2c(qb.prior_year_adjustments),
      netIncomeCents: d2c(qb.net_income),
      adjustedNetIncomeCents: d2c(qb.adjusted_net_income),
    },
    revenue: null,
    calibration: null,
    projection: null,
    flags,
  };
}

/**
 * Estimate the in-progress month.
 *
 * Never reads QBO for the current month — mid-month QBO is distorted by pending
 * month-end entries (the founder rule recorded on
 * docs/brain/tables/qb_pnl_snapshots.md). Instead it calibrates every cost
 * factor off the last closed months and projects revenue per stream.
 */
export async function estimateCurrentMonthProfit(
  admin: Admin,
  workspaceId: string,
  today: string,
): Promise<ProfitResult> {
  const start = monthStart(today);
  const end = monthEnd(today);
  const total = daysInMonth(today);
  const lastCompleteDay = previousDay(today);
  const completeDays = Number(lastCompleteDay.slice(8, 10));
  const flags: string[] = [];

  // ── calibration from the last closed QBO months ──
  const closedMonths = lastClosedMonths(CALIBRATION_MONTHS, today);
  const { data: snapRows, error: snapErr } = await admin
    .from("qb_pnl_snapshots")
    .select(PNL_COLS)
    .eq("workspace_id", workspaceId)
    .in("period_month", closedMonths);
  if (snapErr) throw new Error(`qb_pnl_snapshots: ${snapErr.message}`);
  const snaps = (snapRows ?? []) as unknown as PnlSnapshot[];

  const calInputs: CalibrationInput[] = [];
  for (const s of snaps) {
    const mStart = String(s.period_month).slice(0, 10);
    const mEnd = monthEnd(mStart);
    const internalGross =
      (await sumDaily(admin, "daily_order_snapshots",
        ["recurring_revenue_cents", "new_subscription_revenue_cents", "one_time_revenue_cents"],
        workspaceId, mStart, mEnd)) +
      (await sumDaily(admin, "daily_amazon_order_snapshots", ["gross_revenue_cents"], workspaceId, mStart, mEnd));
    const metaSpend = await sumDaily(admin, "daily_meta_ad_spend", ["spend_cents"], workspaceId, mStart, mEnd);
    calInputs.push({
      periodMonth: mStart,
      totalIncome: s.total_income == null ? null : Number(s.total_income),
      totalCogs: s.total_cogs == null ? null : Number(s.total_cogs),
      transactionFees: s.transaction_fees == null ? null : Number(s.transaction_fees),
      digitalAdvertising: s.digital_advertising == null ? null : Number(s.digital_advertising),
      fixedOpex: s.fixed_opex == null ? null : Number(s.fixed_opex),
      managementFees: s.management_fees == null ? null : Number(s.management_fees),
      netOperatingIncome: s.net_operating_income == null ? null : Number(s.net_operating_income),
      adjustedNetIncome: s.adjusted_net_income == null ? null : Number(s.adjusted_net_income),
      internalGross: internalGross / 100,
      metaSpend: metaSpend / 100,
    });
  }
  if (!calInputs.length) {
    flags.push("No closed QuickBooks month available — falling back to default cost ratios. Run the P&L snapshot backfill.");
  } else if (calInputs.length < CALIBRATION_MONTHS) {
    flags.push(`Calibrated on ${calInputs.length} closed month(s) instead of ${CALIBRATION_MONTHS}.`);
  }

  // ── renewal collection rate over the same closed window ──
  const rateFrom = calInputs.length ? calInputs[0].periodMonth : monthStart(lastCompleteDay);
  const rateTo = calInputs.length ? monthEnd(calInputs[calInputs.length - 1].periodMonth) : lastCompleteDay;
  const observedRate = await readRenewalCollectionRate(admin, workspaceId, rateFrom, rateTo);
  const calibration = deriveCalibration(
    calInputs,
    observedRate ?? FALLBACK_CALIBRATION.renewalCollectionRate,
  );

  // ── revenue projection, per stream ──
  const renewalRealized = await sumDaily(admin, "daily_order_snapshots", ["recurring_revenue_cents"], workspaceId, start, lastCompleteDay);
  const newCheckoutToDate = await sumDaily(admin, "daily_order_snapshots",
    ["new_subscription_revenue_cents", "one_time_revenue_cents"], workspaceId, start, lastCompleteDay);
  const amazonToDate = await sumDaily(admin, "daily_amazon_order_snapshots", ["gross_revenue_cents"], workspaceId, start, lastCompleteDay);
  const metaSpendToDate = await sumDaily(admin, "daily_meta_ad_spend", ["spend_cents"], workspaceId, start, lastCompleteDay);

  // The billing book is kept as a cross-check only — it under-holds real renewals.
  const forwardRows = await readForecasts(admin, workspaceId, today, end);
  let forwardBook = 0;
  for (const r of forwardRows) {
    if (r.status === "pending" && isRenewalBookRow(r)) forwardBook += Number(r.expected_revenue_cents ?? 0);
  }

  // Renewals: realized so far + the rest projected off the same days last month.
  const prevStart = monthStart(previousDay(start));
  const prevEnd = monthEnd(prevStart);
  const prevTotal = daysInMonth(prevStart);
  const prevCut = `${prevStart.slice(0, 8)}${String(Math.min(completeDays, prevTotal)).padStart(2, "0")}`;
  const prevSameDays = await sumDaily(admin, "daily_order_snapshots", ["recurring_revenue_cents"], workspaceId, prevStart, prevCut);
  const prevRest = completeDays < prevTotal
    ? await sumDaily(admin, "daily_order_snapshots", ["recurring_revenue_cents"], workspaceId, nextDay(prevCut), prevEnd)
    : 0;
  const renewalRest = projectRenewalRest(renewalRealized, completeDays, total, prevSameDays, prevRest, prevTotal);
  const renewalCents = renewalRealized + renewalRest;
  if (prevSameDays <= 0 && completeDays < total) {
    flags.push("No renewal history for last month — the rest of the month's renewals are run-rated.");
  }
  const newCheckoutCents = projectFromRunRate(newCheckoutToDate, completeDays, total);
  const amazonCents = projectFromRunRate(amazonToDate, completeDays, total);
  const metaSpendCents = projectFromRunRate(metaSpendToDate, completeDays, total);
  const internalGrossCents = renewalCents + newCheckoutCents + amazonCents;

  return {
    periodMonth: start,
    source: "estimate",
    isComplete: false,
    daysElapsed: completeDays,
    daysInMonth: total,
    lines: computeProfitLines(internalGrossCents, metaSpendCents, calibration),
    revenue: { renewalCents, newCheckoutCents, amazonCents, internalGrossCents },
    calibration,
    projection: {
      renewalRealizedCents: renewalRealized,
      renewalForwardBookCents: forwardBook,
      renewalRestCents: renewalRest,
      renewalPrevSameDaysCents: prevSameDays,
      renewalPrevRestCents: prevRest,
      renewalProjectedCents: renewalCents,
      newCheckoutToDateCents: newCheckoutToDate,
      amazonToDateCents: amazonToDate,
      metaSpendToDateCents: metaSpendToDate,
    },
    flags,
  };
}
