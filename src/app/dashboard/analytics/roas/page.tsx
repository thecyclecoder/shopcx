"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface DayData {
  date: string;
  shopify_checkout_revenue: number;
  amazon_checkout_revenue: number;
  meta_spend: number;
}

interface ROASData {
  daily: DayData[];
  summary: {
    roas: number;
    total_revenue_cents: number;
    total_spend_cents: number;
    shopify_checkout_revenue: number;
    shopify_new_sub_count: number;
    shopify_one_time_count: number;
    amazon_checkout_revenue: number;
    amazon_one_time_count: number;
    amazon_sns_checkout_count: number;
    shopify_recurring_count: number;
    total_all_orders: number;
    shopify_sub_rate: number;
    amazon_sub_rate: number;
    shopify_ltv_cents: number;
    amazon_ltv_cents: number;
    blended_ltv_cents: number;
    shopify_aov_cents: number;
    amazon_aov_cents: number;
    shopify_avg_churn_pct: number;
    amazon_avg_churn_pct: number;
  };
}

function fmt(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtShort(cents: number): string {
  if (Math.abs(cents) >= 10000000) return "$" + (cents / 10000000).toFixed(1) + "M";
  if (Math.abs(cents) >= 100000) return "$" + (cents / 100000).toFixed(1) + "K";
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums truncate ${color || "text-zinc-900 dark:text-zinc-100"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-zinc-400 truncate">{sub}</p>}
    </div>
  );
}

type Preset = "today" | "yesterday" | "this_month" | "last_month" | "custom";

function getPresetDates(preset: Preset): { start: string; end: string } {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  switch (preset) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      const yd = y.toISOString().slice(0, 10);
      return { start: yd, end: yd };
    }
    case "this_month": {
      const first = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      return { start: first, end: today };
    }
    case "last_month": {
      const firstLast = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
      const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
      return { start: firstLast, end: lastDay };
    }
    default:
      return { start: today, end: today };
  }
}

export default function ROASDashboard() {
  const workspace = useWorkspace();
  const [data, setData] = useState<ROASData | null>(null);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<Preset>("this_month");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  useEffect(() => {
    if (preset !== "custom") {
      const { start, end } = getPresetDates(preset);
      setStartDate(start);
      setEndDate(end);
    }
  }, [preset]);

  useEffect(() => {
    if (!startDate || !endDate) return;
    setLoading(true);
    fetch(`/api/workspaces/${workspace.id}/analytics/roas?start=${startDate}&end=${endDate}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [workspace.id, startDate, endDate]);

  const s = data?.summary;
  const multiDay = data && data.daily.length > 1;

  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">ROAS</h1>
          <p className="mt-1 text-sm text-zinc-500">Checkout revenue / ad spend (excludes recurring)</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          >
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="custom">Date Range</option>
          </select>
          {preset === "custom" && (
            <>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
              <span className="text-sm text-zinc-400">to</span>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
            </>
          )}
        </div>
      </div>

      {loading || !s ? (
        <p className="text-sm text-zinc-400">Loading...</p>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard
              label="ROAS"
              value={s.roas > 0 ? `${s.roas.toFixed(2)}x` : "—"}
              sub={s.total_spend_cents > 0 ? `${fmt(s.total_revenue_cents)} / ${fmt(s.total_spend_cents)}` : "No spend data"}
              color={s.roas >= 3 ? "text-emerald-600 dark:text-emerald-400" : s.roas >= 2 ? "text-amber-600" : s.roas > 0 ? "text-red-600" : "text-zinc-400"}
            />
            <StatCard
              label="Revenue"
              value={fmtShort(s.total_revenue_cents)}
              sub="Checkout (excl. recurring)"
              color="text-emerald-600 dark:text-emerald-400"
            />
            <StatCard
              label="Website Rev"
              value={fmtShort(s.shopify_checkout_revenue)}
              sub={`${s.shopify_new_sub_count + s.shopify_one_time_count} orders`}
              color="text-emerald-600 dark:text-emerald-400"
            />
            <StatCard
              label="Amazon Rev"
              value={fmtShort(s.amazon_checkout_revenue)}
              sub={`${s.amazon_one_time_count + s.amazon_sns_checkout_count} orders`}
              color="text-amber-600 dark:text-amber-400"
            />
            <StatCard
              label="Spend"
              value={fmtShort(s.total_spend_cents)}
              sub="Meta Ads"
              color="text-red-500"
            />
            <StatCard
              label="Website Sub Rate"
              value={s.shopify_sub_rate > 0 ? `${s.shopify_sub_rate.toFixed(0)}%` : "—"}
              sub="New subs / checkout"
              color="text-violet-600 dark:text-violet-400"
            />
            <StatCard
              label="AMZ Sub Rate"
              value={s.amazon_sub_rate > 0 ? `${s.amazon_sub_rate.toFixed(0)}%` : "—"}
              sub="SnS signups / checkout"
              color="text-amber-600 dark:text-amber-400"
            />
            <StatCard
              label="AMZ Rate"
              value={s.total_revenue_cents > 0 ? `${Math.round((s.amazon_checkout_revenue / s.total_revenue_cents) * 100)}%` : "—"}
              sub="AMZ / total checkout"
              color="text-amber-600 dark:text-amber-400"
            />
          </div>

          {/* LTV Cards */}
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard
              label="Blended LTV"
              value={s.blended_ltv_cents > 0 ? fmt(s.blended_ltv_cents) : "—"}
              sub="Predicted lifetime value per customer"
              color="text-emerald-600 dark:text-emerald-400"
            />
            <StatCard
              label="Website LTV"
              value={s.shopify_ltv_cents > 0 ? fmt(s.shopify_ltv_cents) : "—"}
              sub={`AOV ${fmt(s.shopify_aov_cents)} · ${s.shopify_sub_rate}% sub · ${s.shopify_avg_churn_pct}% churn`}
              color="text-emerald-600 dark:text-emerald-400"
            />
            <StatCard
              label="Amazon LTV"
              value={s.amazon_ltv_cents > 0 ? fmt(s.amazon_ltv_cents) : "—"}
              sub={`AOV ${fmt(s.amazon_aov_cents)} · ${s.amazon_sub_rate}% sub · ${s.amazon_avg_churn_pct}% churn`}
              color="text-amber-600 dark:text-amber-400"
            />
            <StatCard
              label="LTV:CAC"
              value={s.blended_ltv_cents > 0 && s.total_spend_cents > 0 && (s.shopify_new_sub_count + s.shopify_one_time_count + s.amazon_one_time_count + s.amazon_sns_checkout_count) > 0
                ? `${(s.blended_ltv_cents / (s.total_spend_cents / (s.shopify_new_sub_count + s.shopify_one_time_count + s.amazon_one_time_count + s.amazon_sns_checkout_count))).toFixed(1)}x`
                : "—"}
              sub="LTV / cost per acquisition"
              color={(() => {
                const orders = s.shopify_new_sub_count + s.shopify_one_time_count + s.amazon_one_time_count + s.amazon_sns_checkout_count;
                if (!orders || !s.total_spend_cents || !s.blended_ltv_cents) return "text-zinc-400";
                const ratio = s.blended_ltv_cents / (s.total_spend_cents / orders);
                return ratio >= 3 ? "text-emerald-600 dark:text-emerald-400" : ratio >= 2 ? "text-amber-600" : "text-red-600";
              })()}
            />
          </div>

          {/* Margin Calculator */}
          <MarginCalculator summary={s} />

          {/* ROAS Trendline — only for multi-day ranges */}
          {multiDay && (
            <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Daily ROAS Trend</h2>
              <ROASChart daily={data.daily} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ROASChart({ daily }: { daily: DayData[] }) {
  const W = 800;
  const H = 200;
  const PAD = { top: 20, right: 20, bottom: 30, left: 50 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Calculate daily ROAS
  const roasData = daily.map(d => {
    const rev = d.shopify_checkout_revenue + d.amazon_checkout_revenue;
    const spend = d.meta_spend;
    return { date: d.date, roas: spend > 0 ? rev / spend : 0, hasSpend: spend > 0 };
  }).filter(d => d.hasSpend);

  if (roasData.length < 2) {
    return <p className="text-sm text-zinc-400">Need at least 2 days with spend for trendline</p>;
  }

  const maxRoas = Math.max(...roasData.map(d => d.roas), 1);
  const yMax = Math.ceil(maxRoas);

  const points = roasData.map((d, i) => {
    const x = PAD.left + (i / (roasData.length - 1)) * plotW;
    const y = PAD.top + plotH - (d.roas / yMax) * plotH;
    return { x, y, data: d };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  // Average
  const avgRoas = roasData.reduce((s, d) => s + d.roas, 0) / roasData.length;
  const avgY = PAD.top + plotH - (avgRoas / yMax) * plotH;

  // Y ticks
  const yTicks = [];
  const step = Math.max(0.5, Math.floor(yMax / 4 * 2) / 2);
  for (let i = 0; i <= yMax; i += step) yTicks.push(Math.round(i * 10) / 10);

  const formatDate = (iso: string) => {
    const d = new Date(iso + "T12:00:00");
    return (d.getMonth() + 1) + "/" + d.getDate();
  };

  // Show every Nth label to avoid crowding
  const labelEvery = Math.max(1, Math.floor(roasData.length / 10));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 250 }}>
      {yTicks.map(tick => {
        const y = PAD.top + plotH - (tick / yMax) * plotH;
        return (
          <g key={tick}>
            <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="currentColor" className="text-zinc-100 dark:text-zinc-800" strokeWidth={1} />
            <text x={PAD.left - 8} y={y + 4} textAnchor="end" className="fill-zinc-400" fontSize={10}>{tick}x</text>
          </g>
        );
      })}

      {/* Average line */}
      <line x1={PAD.left} y1={avgY} x2={W - PAD.right} y2={avgY} strokeDasharray="6 4" className="stroke-amber-400" strokeWidth={1.5} />
      <text x={W - PAD.right + 4} y={avgY + 4} className="fill-amber-500" fontSize={9} fontWeight={600}>
        avg {avgRoas.toFixed(2)}x
      </text>

      {/* Line */}
      <path d={linePath} fill="none" className="stroke-indigo-500" strokeWidth={2.5} strokeLinejoin="round" />

      {/* Points */}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={3} className="fill-indigo-500" />
          {i % labelEvery === 0 && (
            <text x={p.x} y={H - 5} textAnchor="middle" className="fill-zinc-400" fontSize={9}>
              {formatDate(p.data.date)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

function MarginCalculator({ summary: s }: { summary: ROASData["summary"] }) {
  const [cogsPct, setCogsPct] = useState(15);
  const [shippingPct, setShippingPct] = useState(14);
  const [gaFixed, setGaFixed] = useState(74361); // Monthly fixed G&A ($81,871 expenses - $7,510 sublease income)
  const [discountPct, setDiscountPct] = useState(9);
  const [amzFeePct, setAmzFeePct] = useState(25);

  const totalOrders = s.shopify_new_sub_count + s.shopify_one_time_count + s.amazon_one_time_count + s.amazon_sns_checkout_count;
  if (!totalOrders) return null;

  const variablePct = cogsPct + shippingPct + discountPct; // scales with revenue
  const gaFixedCents = gaFixed * 100; // monthly fixed overhead
  const cac = totalOrders > 0 && s.total_spend_cents > 0 ? s.total_spend_cents / totalOrders : 0;

  // Blended metrics for spend scaling
  const blendedAov = s.total_revenue_cents / totalOrders;
  const blendedSubRate = (s.shopify_new_sub_count + s.amazon_sns_checkout_count) / totalOrders;
  const blendedChurn = (s.shopify_avg_churn_pct > 0 ? s.shopify_avg_churn_pct : s.amazon_avg_churn_pct) / 100;
  const lifetimeOrders = blendedChurn > 0 ? (1 - blendedSubRate) + (blendedSubRate / blendedChurn) : 1;
  const variableCostPct = variablePct / 100;
  // G&A spread across ALL orders (recurring + checkout + Amazon) — not just checkout
  const allOrders = s.total_all_orders || totalOrders;
  const gaPerOrder = allOrders > 0 ? gaFixedCents / allOrders : 0;
  const costPerOrderPct = variableCostPct; // variable only for lifetime calc

  function calcChannel(label: string, revenue: number, orders: number, subCount: number, churnPct: number, color: string, extraFeePct?: number) {
    if (!orders) return null;
    const aov = revenue / orders;
    const subRate = orders > 0 ? subCount / orders : 0;
    const churn = churnPct / 100;
    const channelVarPct = variableCostPct + (extraFeePct || 0) / 100;
    const varCostPerOrder = aov * channelVarPct;
    const allCostPerOrder = varCostPerOrder + gaPerOrder; // variable + allocated G&A
    const channelTotalPct = variablePct + (extraFeePct || 0);
    const firstProfit = aov - cac - allCostPerOrder;
    const firstMargin = aov > 0 ? (firstProfit / aov) * 100 : 0;
    const ltOrders = churn > 0 ? (1 - subRate) + (subRate / churn) : 1;
    const lifetimeRev = aov * ltOrders;
    const lifetimeVarCost = varCostPerOrder * ltOrders; // variable scales with orders
    const lifetimeProfit = lifetimeRev - cac - lifetimeVarCost - gaPerOrder; // G&A charged once
    const trueROAS = cac > 0 ? lifetimeProfit / cac : 0;
    const maxCac = lifetimeRev - lifetimeVarCost - gaPerOrder;

    return (
      <div className="rounded-lg border border-zinc-100 p-4 dark:border-zinc-800">
        <h3 className={`mb-3 text-xs font-medium uppercase tracking-wider ${color}`}>{label}</h3>
        <div className="space-y-1.5 text-sm">
          <Row label="AOV" value={fmt(aov)} />
          <Row label="Sub rate" value={`${(subRate * 100).toFixed(0)}%`} />
          <Row label="Ad cost (CAC)" value={`-${fmt(cac)}`} color="text-red-500" />
          <Row label={`Variable costs (${channelTotalPct}%)`} value={`-${fmt(varCostPerOrder)}`} color="text-red-500" />
          {extraFeePct ? <Row label={`  incl. platform fees (${extraFeePct}%)`} value={`-${fmt(aov * extraFeePct / 100)}`} color="text-red-400" /> : null}
          <Row label="G&A (fixed)" value={`-${fmt(gaPerOrder)}`} color="text-red-400" />
          <div className="border-t border-zinc-100 pt-1.5 dark:border-zinc-800">
            <Row label="First order profit" value={`${fmt(firstProfit)} (${firstMargin.toFixed(0)}%)`}
              color={firstProfit >= 0 ? "text-emerald-600 font-semibold" : "text-red-600 font-semibold"} />
          </div>
          <div className="border-t border-zinc-100 pt-1.5 dark:border-zinc-800">
            <Row label="Avg lifetime orders" value={ltOrders.toFixed(1)} bold />
            <Row label="Lifetime revenue" value={fmt(lifetimeRev)} color="text-emerald-600" />
            <Row label={`Variable costs (${ltOrders.toFixed(1)} orders)`} value={`-${fmt(lifetimeVarCost)}`} color="text-red-500" />
            <Row label="G&A (fixed, once)" value={`-${fmt(gaPerOrder)}`} color="text-red-400" />
            <Row label="Lifetime profit" value={fmt(lifetimeProfit)}
              color={lifetimeProfit >= 0 ? "text-emerald-600 font-semibold" : "text-red-600 font-semibold"} />
            <Row label="True ROAS" value={trueROAS > 0 ? `${trueROAS.toFixed(1)}x` : "—"}
              color={trueROAS >= 3 ? "text-emerald-600 font-semibold" : trueROAS >= 2 ? "text-amber-600 font-semibold" : "text-red-600 font-semibold"} />
            <Row label="Max CAC (breakeven)" value={fmt(maxCac)} color="text-amber-600" />
          </div>
        </div>
      </div>
    );
  }

  // ROAS decay model: based on historical data, ROAS decreases with higher spend
  // Model: ROAS = maxRoas - decayRate * monthlySpend (in dollars)
  // From regression: each $1K/mo more spend reduces ROAS by ~0.008x
  const roasDecayPerDollar = 0.000008; // 0.008 per $1K = 0.000008 per $1
  const theoreticalMaxRoas = 2.43; // ROAS at $0 spend

  const scenarios = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5].map(mult => {
    const spendCents = s.total_spend_cents * mult;
    const spendDollars = spendCents / 100;
    // Predict ROAS at this spend level
    const predictedRoas = Math.max(0.3, theoreticalMaxRoas - roasDecayPerDollar * spendDollars);
    const revCents = spendCents * predictedRoas;
    const orders = blendedAov > 0 ? Math.round(revCents / blendedAov) : 0;
    const varCosts = revCents * variableCostPct; // only variable costs scale
    // First order profit: revenue - variable costs - G&A (fixed) - ad spend
    const firstOrderProfit = revCents - varCosts - gaFixedCents - spendCents;
    // Lifetime: variable costs scale with orders, G&A is fixed, ad cost is one-time
    const cacPerCustomer = orders > 0 ? spendCents / orders : 0;
    const ltRevPerCustomer = blendedAov * lifetimeOrders;
    const ltVarCostPerCustomer = blendedAov * variableCostPct * lifetimeOrders;
    const ltProfitPerCustomer = ltRevPerCustomer - ltVarCostPerCustomer - cacPerCustomer;
    const ltProfitTotal = ltProfitPerCustomer * orders - gaFixedCents; // G&A once for the business
    return { mult, spend: spendCents, orders, rev: revCents, firstOrderProfit, ltProfit: ltProfitTotal, roas: predictedRoas };
  });

  return (
    <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Margin Calculator</h2>

      <div className="mb-4 flex flex-wrap gap-4">
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1">COGS %</label>
          <input type="number" value={cogsPct} onChange={(e) => setCogsPct(Number(e.target.value))}
            className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1">Shipping %</label>
          <input type="number" value={shippingPct} onChange={(e) => setShippingPct(Number(e.target.value))}
            className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1">G&A $/mo (fixed)</label>
          <input type="number" value={gaFixed} onChange={(e) => setGaFixed(Number(e.target.value))}
            className="w-28 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1">Discounts %</label>
          <input type="number" value={discountPct} onChange={(e) => setDiscountPct(Number(e.target.value))}
            className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1">AMZ Fees %</label>
          <input type="number" value={amzFeePct} onChange={(e) => setAmzFeePct(Number(e.target.value))}
            className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
        </div>
        <div className="flex items-end">
          <span className="text-xs text-zinc-400">Variable: {variablePct}% · G&A: ${gaFixed.toLocaleString()}/mo · AMZ fees: +{amzFeePct}% · CAC: {fmt(cac)}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-6">
        {calcChannel("Website", s.shopify_checkout_revenue, s.shopify_new_sub_count + s.shopify_one_time_count, s.shopify_new_sub_count, s.shopify_avg_churn_pct, "text-emerald-500")}
        {calcChannel("Amazon", s.amazon_checkout_revenue, s.amazon_one_time_count + s.amazon_sns_checkout_count, s.amazon_sns_checkout_count, s.amazon_avg_churn_pct, "text-amber-500", amzFeePct)}
        {calcChannel("Blended", s.total_revenue_cents, totalOrders, s.shopify_new_sub_count + s.amazon_sns_checkout_count,
          s.shopify_avg_churn_pct > 0 ? s.shopify_avg_churn_pct : s.amazon_avg_churn_pct,
          "text-zinc-400")}
      </div>

      {/* Spend Scaling — what happens if you spend more */}
      <div className="rounded-lg border border-zinc-100 p-4 dark:border-zinc-800">
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">Spend Scaling (assuming linear acquisition)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                <th className="px-3 py-1">Ad Spend</th>
                <th className="px-3 py-1 text-right">ROAS</th>
                <th className="px-3 py-1 text-right">Orders</th>
                <th className="px-3 py-1 text-right">Revenue</th>
                <th className="px-3 py-1 text-right">First Order Profit</th>
                <th className="px-3 py-1 text-right">Lifetime Profit</th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map(sc => {
                const isCurrent = sc.mult === 1;
                return (
                  <tr key={sc.mult} className={`border-b border-zinc-50 dark:border-zinc-800/50 ${isCurrent ? "bg-indigo-50/50 dark:bg-indigo-950/20" : ""}`}>
                    <td className="px-3 py-1.5 tabular-nums">
                      {fmtShort(sc.spend)}
                      {isCurrent && <span className="ml-1 text-[10px] text-indigo-500">current</span>}
                      {!isCurrent && <span className="ml-1 text-[10px] text-zinc-400">{sc.mult}x</span>}
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${sc.roas >= 3 ? "text-emerald-600" : sc.roas >= 2 ? "text-amber-600" : "text-red-600"}`}>
                      {sc.roas.toFixed(1)}x
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{sc.orders.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{fmtShort(sc.rev)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${sc.firstOrderProfit >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {fmtShort(sc.firstOrderProfit)}
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${sc.ltProfit >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {fmtShort(sc.ltProfit)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] text-zinc-400">ROAS decay modeled from Jan 2025–Apr 2026 historical data. Each $1K/mo increase in spend reduces ROAS by ~0.008x. Lifetime profit accounts for subscription LTV.</p>
      </div>
    </div>
  );
}

function Row({ label, value, color, bold }: { label: string; value: string; color?: string; bold?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className={`tabular-nums ${color || (bold ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-700 dark:text-zinc-300")}`}>{value}</span>
    </div>
  );
}
