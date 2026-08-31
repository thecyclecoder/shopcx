"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface ProfitLines {
  incomeCents: number;
  cogsCents: number;
  grossProfitCents: number;
  digitalAdvertisingCents: number;
  transactionFeesCents: number;
  fixedOpexCents: number;
  netOperatingIncomeCents: number;
  managementFeesCents: number;
  netIncomeCents: number;
  adjustedNetIncomeCents: number;
}

interface ProfitResponse {
  periodMonth: string;
  source: "quickbooks" | "estimate";
  isComplete: boolean;
  daysElapsed: number;
  daysInMonth: number;
  lines: ProfitLines;
  revenue: { renewalCents: number; newCheckoutCents: number; amazonCents: number; internalGrossCents: number } | null;
  calibration: {
    incomeRatio: number; cogsRatio: number; txnFeeRatio: number; adSpendRatio: number;
    fixedOpexCents: number; managementFeesCents: number; renewalCollectionRate: number; monthsUsed: string[];
  } | null;
  projection: {
    renewalRealizedCents: number; renewalForwardBookCents: number; renewalProjectedCents: number;
    newCheckoutToDateCents: number; amazonToDateCents: number; metaSpendToDateCents: number;
  } | null;
  flags: string[];
  available_months: string[];
  error?: string;
  message?: string;
}

function fmtK(cents: number): string {
  const d = cents / 100;
  const sign = d < 0 ? "-" : "";
  const a = Math.abs(d);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function monthLabel(periodMonth: string): string {
  return new Date(`${periodMonth}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
}

export default function ProfitDashboard() {
  const workspace = useWorkspace();
  const [data, setData] = useState<ProfitResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("this_month");

  useEffect(() => {
    setLoading(true);
    fetch(`/api/workspaces/${workspace.id}/analytics/profit?period=${period}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [workspace.id, period]);

  if (loading) return <div className="px-4 py-6"><p className="text-sm text-zinc-400">Loading…</p></div>;
  if (!data || data.error) {
    return (
      <div className="px-4 py-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Profit</h1>
        <p className="mt-3 text-sm text-amber-600">{data?.message || data?.error || "Failed to load."}</p>
      </div>
    );
  }

  const L = data.lines;
  const isEstimate = data.source === "estimate";

  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Profit</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {isEstimate
              ? `Estimate for ${monthLabel(data.periodMonth)} — ${data.daysElapsed} of ${data.daysInMonth} days complete. Cost ratios calibrated from closed QuickBooks months.`
              : `QuickBooks actuals for ${monthLabel(data.periodMonth)}.`}
          </p>
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <option value="this_month">This Month (estimate)</option>
          {data.available_months?.map((m) => (
            <option key={m} value={m}>
              {monthLabel(`${m}-01`)}
            </option>
          ))}
        </select>
      </div>

      {/* ── Headline ─────────────────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Headline
          label="Real profit"
          hint="Net profit before management fees"
          value={L.adjustedNetIncomeCents}
          big
          badge={isEstimate ? "Estimate" : "QuickBooks"}
          badgeTone={isEstimate ? "amber" : "emerald"}
        />
        <Headline
          label="Booked net profit"
          hint="As filed — steered ≤ $0 per fiscal year"
          value={L.netIncomeCents}
        />
        <Headline
          label="Revenue"
          hint={isEstimate ? "Projected full month" : "QuickBooks total income"}
          value={L.incomeCents}
          neutral
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* ── P&L ────────────────────────────────────────────────── */}
        <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">P&amp;L</h2>
          <div className="space-y-2 text-sm">
            <Row label="Income" value={fmtK(L.incomeCents)} color="text-emerald-600 font-semibold" />
            <Row label="COGS" value={`-${fmtK(L.cogsCents)}`} color="text-red-500" />
            <Divider />
            <Row label="Gross profit" value={fmtK(L.grossProfitCents)} color="text-emerald-600 font-medium" />
            <Divider />
            <Row label="Digital advertising" value={`-${fmtK(L.digitalAdvertisingCents)}`} color="text-red-500" />
            <Row label="Transaction fees" value={`-${fmtK(L.transactionFeesCents)}`} color="text-red-500" />
            <Row label="Fixed OpEx" value={`-${fmtK(L.fixedOpexCents)}`} color="text-red-500" />
            <Divider />
            <Row label="Net operating income" value={fmtK(L.netOperatingIncomeCents)} color="text-emerald-600 font-medium" />
            <div className="rounded-md bg-emerald-50/60 px-2 py-2 dark:bg-emerald-950/20">
              <div className="flex justify-between">
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">Real profit</span>
                <span className={`text-lg font-bold tabular-nums ${L.adjustedNetIncomeCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {fmtK(L.adjustedNetIncomeCents)}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-zinc-500">Before management fees — the real economic number.</p>
            </div>
            <Row label="Management fees" value={`-${fmtK(L.managementFeesCents)}`} color="text-zinc-400" />
            <Divider />
            <div className="flex justify-between">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Booked net profit</span>
              <span className={`tabular-nums font-semibold ${L.netIncomeCents >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                {fmtK(L.netIncomeCents)}
              </span>
            </div>
          </div>
        </section>

        {/* ── How the estimate was built ─────────────────────────── */}
        <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {isEstimate ? "How this estimate is built" : "Source"}
          </h2>

          {!isEstimate && (
            <p className="text-sm text-zinc-500">
              Every line is read straight from the QuickBooks month-end P&amp;L snapshot — no modelling, no assumptions.
            </p>
          )}

          {isEstimate && data.revenue && data.projection && data.calibration && (
            <div className="space-y-4 text-sm">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">Revenue projection</p>
                <div className="space-y-1.5">
                  <Row
                    label="Renewals"
                    value={fmtK(data.revenue.renewalCents)}
                    color="text-zinc-700 dark:text-zinc-300"
                  />
                  <p className="ml-2 text-[11px] text-zinc-400">
                    {fmtK(data.projection.renewalRealizedCents)} collected + {fmtK(data.projection.renewalForwardBookCents)} still
                    scheduled × {(data.calibration.renewalCollectionRate * 100).toFixed(0)}% collection rate
                  </p>
                  <Row label="New checkouts" value={fmtK(data.revenue.newCheckoutCents)} color="text-zinc-700 dark:text-zinc-300" />
                  <p className="ml-2 text-[11px] text-zinc-400">
                    {fmtK(data.projection.newCheckoutToDateCents)} over {data.daysElapsed} days, run-rated to {data.daysInMonth}
                  </p>
                  <Row label="Amazon" value={fmtK(data.revenue.amazonCents)} color="text-zinc-700 dark:text-zinc-300" />
                  <p className="ml-2 text-[11px] text-zinc-400">
                    {fmtK(data.projection.amazonToDateCents)} to date, run-rated
                  </p>
                  <Divider />
                  <Row label="Gross (our books)" value={fmtK(data.revenue.internalGrossCents)} color="font-medium" />
                  <Row
                    label={`× ${(data.calibration.incomeRatio * 100).toFixed(1)}% → QuickBooks income`}
                    value={fmtK(L.incomeCents)}
                    color="font-medium text-emerald-600"
                  />
                  <p className="ml-2 text-[11px] text-zinc-400">
                    Absorbs refunds, discounts and chargebacks — they're contra-revenue accounts in QuickBooks.
                  </p>
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
                  Cost factors — from {data.calibration.monthsUsed.length} closed month
                  {data.calibration.monthsUsed.length === 1 ? "" : "s"}
                  {data.calibration.monthsUsed.length > 0 && ` (${data.calibration.monthsUsed.map((m) => m.slice(0, 7)).join(", ")})`}
                </p>
                <div className="space-y-1.5">
                  <Row label="COGS" value={`${(data.calibration.cogsRatio * 100).toFixed(1)}% of income`} />
                  <Row label="Transaction fees" value={`${(data.calibration.txnFeeRatio * 100).toFixed(1)}% of income`} />
                  <Row label="Ad spend multiplier" value={`${data.calibration.adSpendRatio.toFixed(2)}× Meta spend`} />
                  <p className="ml-2 text-[11px] text-zinc-400">
                    Scales Meta-only spend up to all channels (Google, Amazon, TikTok).
                  </p>
                  <Row label="Fixed OpEx" value={`${fmtK(data.calibration.fixedOpexCents)}/mo`} />
                  <Row label="Management fees" value={`${fmtK(data.calibration.managementFeesCents)}/mo`} />
                </div>
              </div>
            </div>
          )}

          {data.flags?.length > 0 && (
            <div className="mt-4 space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
              {data.flags.map((f, i) => (
                <p key={i} className="text-[11px] text-amber-700 dark:text-amber-400">{f}</p>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Headline({
  label, hint, value, big, neutral, badge, badgeTone,
}: {
  label: string; hint: string; value: number; big?: boolean; neutral?: boolean;
  badge?: string; badgeTone?: "amber" | "emerald";
}) {
  const tone = neutral
    ? "text-zinc-900 dark:text-zinc-100"
    : value >= 0 ? "text-emerald-600" : "text-red-600";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-500">{label}</span>
        {badge && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              badgeTone === "amber"
                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
            }`}
          >
            {badge}
          </span>
        )}
      </div>
      <p className={`mt-1 tabular-nums font-bold ${big ? "text-3xl" : "text-2xl"} ${tone}`}>{fmtK(value)}</p>
      <p className="mt-0.5 text-[11px] text-zinc-400">{hint}</p>
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className={`tabular-nums ${color || "text-zinc-700 dark:text-zinc-300"}`}>{value}</span>
    </div>
  );
}

function Divider() {
  return <div className="border-t border-zinc-100 pt-1 dark:border-zinc-800" />;
}
