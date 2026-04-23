"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface ProfitData {
  period: string;
  days_in_month: number;
  days_so_far: number;
  is_complete: boolean;
  actual: {
    shopify_revenue: number;
    shopify_recurring: number;
    shopify_new_sub: number;
    shopify_one_time: number;
    amazon_revenue: number;
    amazon_recurring: number;
    amazon_one_time: number;
    amazon_sns: number;
    total_revenue: number;
    total_orders: number;
    meta_spend: number;
  };
  projected: {
    total_revenue: number;
    total_orders: number;
    meta_spend: number;
    amazon_revenue: number;
  };
}

function fmt(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtK(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000000) return "$" + (dollars / 1000000).toFixed(1) + "M";
  if (Math.abs(dollars) >= 1000) return "$" + (dollars / 1000).toFixed(1) + "K";
  return "$" + dollars.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export default function ProfitDashboard() {
  const workspace = useWorkspace();
  const [data, setData] = useState<ProfitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("this_month");

  // Cost assumptions (same as margin calculator)
  const [cogsPct] = useState(17);
  const [shippingPct] = useState(15);
  const [discountPct] = useState(12);
  const [shopifyTxPct] = useState(3);
  const [amzFeePct] = useState(25);
  const [gaFixed] = useState(54542);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/workspaces/${workspace.id}/analytics/profit?period=${period}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [workspace.id, period]);

  if (loading || !data) {
    return <div className="px-4 py-6"><p className="text-sm text-zinc-400">Loading...</p></div>;
  }

  const a = data.actual;
  const p = data.projected;
  const gaFixedCents = gaFixed * 100;

  // Helper to build P&L lines
  function buildPL(label: string, revenue: number, amzRevenue: number, adSpend: number, isProjection: boolean) {
    const shopifyRev = revenue - amzRevenue;

    // Revenue - Discounts = Income
    const discounts = revenue * (discountPct / 100);
    const income = revenue - discounts;

    // Variable costs (COGS + Shipping on income, not gross revenue)
    const cogsCost = income * (cogsPct / 100);
    const shippingCost = income * (shippingPct / 100);
    const shopifyTxCost = shopifyRev * (shopifyTxPct / 100);
    const amzFees = amzRevenue * (amzFeePct / 100);
    const totalVarCost = cogsCost + shippingCost + shopifyTxCost + amzFees;
    const grossProfit = income - totalVarCost;

    const profitBeforeAds = grossProfit - gaFixedCents;
    const netProfit = profitBeforeAds - adSpend;
    const netMargin = income > 0 ? (netProfit / income) * 100 : 0;

    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {label}
          {isProjection && !data!.is_complete && (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              Projected ({data!.days_so_far}/{data!.days_in_month} days)
            </span>
          )}
        </h3>
        <div className="space-y-2 text-sm">
          <Row label="Revenue (gross)" value={fmtK(revenue)} color="text-emerald-600 font-semibold" />
          <Row label="  Shopify" value={fmtK(shopifyRev)} color="text-emerald-500" sub />
          <Row label="  Amazon" value={fmtK(amzRevenue)} color="text-amber-500" sub />
          <Row label={`Discounts / refunds / chargebacks (${discountPct}%)`} value={`-${fmtK(discounts)}`} color="text-red-400" />
          <Row label="Income (net revenue)" value={fmtK(income)} color="text-emerald-600 font-medium" />

          <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800" />
          <Row label={`COGS (${cogsPct}%)`} value={`-${fmtK(cogsCost)}`} color="text-red-500" />
          <Row label={`Shipping (${shippingPct}%)`} value={`-${fmtK(shippingCost)}`} color="text-red-500" />
          <Row label={`Shopify tx fees (${shopifyTxPct}%)`} value={`-${fmtK(shopifyTxCost)}`} color="text-red-500" />
          <Row label={`Amazon fees (${amzFeePct}%)`} value={`-${fmtK(amzFees)}`} color="text-red-500" />
          <Row label="Gross profit" value={fmtK(grossProfit)} color={grossProfit >= 0 ? "text-emerald-600 font-medium" : "text-red-600 font-medium"} />

          <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800" />
          <Row label="G&A (fixed)" value={`-${fmtK(gaFixedCents)}`} color="text-red-400" />
          <Row label="Profit before ads" value={fmtK(profitBeforeAds)} color={profitBeforeAds >= 0 ? "text-emerald-600 font-medium" : "text-red-600 font-medium"} />

          <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800" />
          <Row label="Ad spend (Meta)" value={`-${fmtK(adSpend)}`} color="text-red-500" />

          <div className="border-t-2 border-zinc-200 pt-2 dark:border-zinc-700" />
          <div className="flex justify-between">
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">Net Profit</span>
            <span className={`text-lg tabular-nums font-bold ${netProfit >= 0 ? "text-emerald-600" : "text-red-600"}`}>
              {fmtK(netProfit)}
              <span className="ml-1 text-xs font-normal text-zinc-400">({netMargin.toFixed(1)}%)</span>
            </span>
          </div>
        </div>
      </div>
    );
  }

  const monthLabel = period === "last_month" ? "Last Month" : "This Month";

  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Profit Estimate</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Estimated P&L using actual sales data + cost assumptions
          </p>
        </div>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          <option value="this_month">This Month</option>
          <option value="last_month">Last Month</option>
        </select>
      </div>

      <div className={`grid grid-cols-1 gap-6 ${!data.is_complete ? "sm:grid-cols-2" : ""}`}>
        {/* Actual to-date */}
        {buildPL(
          data.is_complete ? `${monthLabel} (Final)` : `${monthLabel} (To Date — ${data.days_so_far} days)`,
          a.total_revenue,
          a.amazon_revenue,
          a.meta_spend,
          false,
        )}

        {/* Projected full month — only for incomplete months */}
        {!data.is_complete && buildPL(
          `${monthLabel} (Projected Full Month)`,
          p.total_revenue,
          p.amazon_revenue,
          p.meta_spend,
          true,
        )}
      </div>

      {/* Assumptions */}
      <div className="mt-4 rounded-lg border border-zinc-100 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-800/30">
        <p className="text-[11px] text-zinc-400">
          Assumptions: COGS {cogsPct}% · Shipping {shippingPct}% · Discounts {discountPct}% · Shopify tx {shopifyTxPct}% · Amazon fees {amzFeePct}% · G&A ${gaFixed.toLocaleString()}/mo (fixed).
          {!data.is_complete && ` Projection extrapolates ${data.days_so_far}-day pace to full ${data.days_in_month}-day month.`}
        </p>
      </div>
    </div>
  );
}

function Row({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: boolean }) {
  return (
    <div className={`flex justify-between ${sub ? "ml-2" : ""}`}>
      <span className={sub ? "text-zinc-400 text-xs" : "text-zinc-500"}>{label}</span>
      <span className={`tabular-nums ${color || "text-zinc-700 dark:text-zinc-300"}`}>{value}</span>
    </div>
  );
}
