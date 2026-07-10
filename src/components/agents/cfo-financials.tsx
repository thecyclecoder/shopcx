"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// CFO (Grace) P&L visual — SMALL MULTIPLES: one mini line-chart per metric, each with its OWN
// y-scale, so movement is visible even though Revenue dwarfs everything else. 11 metrics grouped into
// three sections — Top Line Stats (Revenue / Net Profit / NP+Addbacks), Drivers (Fixed OpEx / Digital
// Ads / Transaction Fees / Mgmt Fees), Contributors (Refunds / Chargebacks / Discounts & Coupons /
// Inventory Adjustments) — over the last 24 closed months from qb_pnl_snapshots. Palette = dataviz
// categorical slots 1–8 (validated). Hover is synced across all panels (one month highlights everywhere).

interface PnlRow {
  month: string; // YYYY-MM-01
  revenue: number | null;
  netProfit: number | null;
  mgmtFees: number | null;
  netProfitWithAddbacks: number | null;
  fixedOpex: number | null;
  digitalAds: number | null;
  transactionFees: number | null;
  refunds: number | null;
  chargebacks: number | null;
  discountsCoupons: number | null;
  inventoryAdjustments: number | null;
}

type SeriesKey = "revenue" | "netProfit" | "mgmtFees" | "netProfitWithAddbacks" | "fixedOpex"
  | "digitalAds" | "transactionFees" | "refunds" | "chargebacks" | "discountsCoupons" | "inventoryAdjustments";
type Section = "Top Line Stats" | "Drivers" | "Contributors";
interface Metric { key: SeriesKey; label: string; varName: string; zeroBaseline: boolean; section: Section; note?: string }
const METRICS: Metric[] = [
  // Top Line Stats — the outcomes.
  { key: "revenue", label: "Revenue", varName: "--s1", zeroBaseline: false, section: "Top Line Stats", note: "Total income" },
  { key: "netProfit", label: "Net Profit", varName: "--s2", zeroBaseline: true, section: "Top Line Stats", note: "Booked — steer ≤ $0 / fiscal year" },
  { key: "netProfitWithAddbacks", label: "NP + Addbacks", varName: "--s4", zeroBaseline: true, section: "Top Line Stats", note: "True economic profit (mgmt fees back in)" },
  // Drivers — the big spend levers.
  { key: "fixedOpex", label: "Fixed OpEx", varName: "--s5", zeroBaseline: false, section: "Drivers", note: "Total expenses − ads − txn fees" },
  { key: "digitalAds", label: "Digital Ads", varName: "--s6", zeroBaseline: false, section: "Drivers", note: "Variable — FB / Google / Amazon (bridged pre-2025)" },
  { key: "transactionFees", label: "Transaction Fees", varName: "--s8", zeroBaseline: false, section: "Drivers", note: "Variable — Amazon / Shopify / PayPal / Braintree" },
  { key: "mgmtFees", label: "Mgmt Fees", varName: "--s3", zeroBaseline: false, section: "Drivers", note: "Intercompany addback" },
  // Contributors — the profit bites.
  { key: "refunds", label: "Refunds", varName: "--s7", zeroBaseline: false, section: "Contributors", note: "Contra-revenue" },
  { key: "chargebacks", label: "Chargebacks", varName: "--s6", zeroBaseline: false, section: "Contributors", note: "Contra-revenue — disputed payments" },
  { key: "discountsCoupons", label: "Discounts & Coupons", varName: "--s8", zeroBaseline: false, section: "Contributors", note: "Contra-revenue" },
  { key: "inventoryAdjustments", label: "Inventory Adjustments", varName: "--s5", zeroBaseline: true, section: "Contributors", note: "Shrinkage + ending-inventory true-up" },
];
const SECTIONS: { title: Section; blurb: string }[] = [
  { title: "Top Line Stats", blurb: "The outcomes" },
  { title: "Drivers", blurb: "The big spend levers" },
  { title: "Contributors", blurb: "What bites at profit" },
];

const money = (v: number) => {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(a >= 100000 ? 0 : 1)}k`;
  return `${sign}$${a.toFixed(0)}`;
};
const monthLabel = (m: string) => {
  const [y, mo] = m.split("-");
  const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(mo)]} '${y.slice(2)}`;
};
const val = (r: PnlRow, k: SeriesKey) => (k === "mgmtFees" ? (r[k] ?? 0) : r[k]); // null mgmt fee = $0 that month

const yearOf = (m: string) => Number(m.slice(0, 4));
const quarterOf = (m: string) => Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1;
const quarterKey = (m: string) => `${yearOf(m)}-Q${quarterOf(m)}`;
const rangeSpan = (rows: PnlRow[]) => (rows.length ? `${monthLabel(rows[0].month)} – ${monthLabel(rows[rows.length - 1].month)}` : "");

type Range = { type: "all" | "thisYear" | "lastYear" | "last6" } | { type: "quarter"; key: string };
type DefaultRange = "all" | "thisYear" | "lastYear" | "last6";

export function CfoFinancials({
  endpoint = "/api/director/cfo/pnl",
  defaultRange = "all",
}: { endpoint?: string; defaultRange?: DefaultRange } = {}) {
  const [rows, setRows] = useState<PnlRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"charts" | "table">("charts");
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [range, setRange] = useState<Range>({ type: defaultRange });
  const active = hover ?? pinned; // hover scans; a click pins so the readout stays

  useEffect(() => {
    fetch(endpoint)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setRows(d.rows)))
      .catch(() => setError("Failed to load P&L"));
  }, [endpoint]);

  // "this year" = the most recent year present in the data (deterministic, never empty).
  const { curYear, quarters } = useMemo(() => {
    if (!rows || rows.length === 0) return { curYear: 0, quarters: [] as { key: string; label: string }[] };
    const cy = Math.max(...rows.map((r) => yearOf(r.month)));
    const seen = new Set<string>();
    const qs: { key: string; label: string }[] = [];
    for (const r of [...rows].reverse()) { const k = quarterKey(r.month); if (!seen.has(k)) { seen.add(k); qs.push({ key: k, label: `Q${quarterOf(r.month)} ${yearOf(r.month)}` }); } }
    return { curYear: cy, quarters: qs };
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    if (range.type === "quarter") return rows.filter((r) => quarterKey(r.month) === range.key);
    if (range.type === "thisYear") return rows.filter((r) => yearOf(r.month) === curYear);
    if (range.type === "lastYear") return rows.filter((r) => yearOf(r.month) === curYear - 1);
    if (range.type === "last6") return rows.slice(-6);
    return rows;
  }, [rows, range, curYear]);

  // Smart default: when the caller asks for "this year" but the current year has
  // fewer than 6 closed months, fall back to the trailing-6-month view (YTD is too
  // thin early in a year). Runs once, on first data load; never fights a manual pick.
  const didInitDefault = useRef(false);
  useEffect(() => {
    if (!rows || rows.length === 0 || didInitDefault.current) return;
    didInitDefault.current = true;
    if (defaultRange === "thisYear") {
      const cy = Math.max(...rows.map((r) => yearOf(r.month)));
      if (rows.filter((r) => yearOf(r.month) === cy).length < 6) setRange({ type: "last6" });
    }
  }, [rows, defaultRange]);

  useEffect(() => { setHover(null); setPinned(null); }, [range]);

  if (error) return <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">{error}</div>;
  if (!rows) return <div className="text-sm text-zinc-400">Loading financials…</div>;
  if (rows.length === 0) return <div className="rounded-lg border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500 dark:border-zinc-800">No P&L snapshots yet. Connect QuickBooks + run the backfill.</div>;

  const isQuarter = range.type === "quarter";
  const btn = (active: boolean) => `px-2.5 py-1 ${active ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800"}`;

  return (
    <div className="cfo-pnl">
      <style>{`
        .cfo-pnl { --s1:#2a78d6; --s2:#1baf7a; --s3:#eda100; --s4:#008300; --s5:#5a45c0; --s6:#d13b3b; --s7:#c14b86; --s8:#cc5a24; --grid:#eceae4; --axis:#c9c7c0; --zero:#9b9a94; }
        .dark .cfo-pnl, :root[data-theme="dark"] .cfo-pnl { --s1:#3987e5; --s2:#199e70; --s3:#c98500; --s4:#12a012; --s5:#7d70dd; --s6:#dd4f4f; --s7:#d95f98; --s8:#df6626; --grid:#2b2b28; --axis:#3a3a37; --zero:#6f6e68; }
      `}</style>

      {/* filter row (dataviz: filters in one row above the charts) */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-zinc-200 text-[11px] dark:border-zinc-800">
          <button onClick={() => setRange({ type: "all" })} className={btn(range.type === "all")}>{rows.length} mo</button>
          <button onClick={() => setRange({ type: "last6" })} className={btn(range.type === "last6")}>Last 6 mo</button>
          <button onClick={() => setRange({ type: "thisYear" })} className={btn(range.type === "thisYear")}>This year</button>
          <button onClick={() => setRange({ type: "lastYear" })} className={btn(range.type === "lastYear")}>Last year</button>
        </div>
        <select
          value={isQuarter ? range.key : ""}
          onChange={(e) => e.target.value ? setRange({ type: "quarter", key: e.target.value }) : setRange({ type: "all" })}
          className={`rounded-md border px-2 py-1 text-[11px] ${isQuarter ? "border-zinc-400 text-zinc-900 dark:border-zinc-500 dark:text-zinc-100" : "border-zinc-200 text-zinc-500 dark:border-zinc-800"} bg-white dark:bg-zinc-900`}
        >
          <option value="">Quarter…</option>
          {quarters.map((q) => <option key={q.key} value={q.key}>{q.label}</option>)}
        </select>
        <span className="text-[11px] text-zinc-400">{rangeSpan(filtered)}</span>
        <span className="text-[11px] text-zinc-400">{active !== null && filtered[active] ? `· ${monthLabel(filtered[active].month)}${pinned !== null ? " (pinned)" : ""}` : "· hover or click a month"}</span>
        <div className="ml-auto flex overflow-hidden rounded-md border border-zinc-200 text-[11px] dark:border-zinc-800">
          {(["charts", "table"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={btn(view === v)}>{v === "charts" ? "Charts" : "Table"}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500 dark:border-zinc-800">No months in this range.</div>
      ) : view === "charts" ? (
        <div className="space-y-6">
          {SECTIONS.map((sec) => (
            <section key={sec.title}>
              <div className="mb-2.5 flex items-baseline gap-2 border-b border-zinc-200 pb-1.5 dark:border-zinc-800">
                <h3 className="text-[13px] font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">{sec.title}</h3>
                <span className="text-[11px] text-zinc-400">{sec.blurb}</span>
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {METRICS.filter((m) => m.section === sec.title).map((m) => (
                  <MiniChart key={m.key} metric={m} rows={filtered} active={active} pinned={pinned}
                    onHover={setHover} onPin={(i) => setPinned((p) => (p === i ? null : i))} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-right text-[12px]">
            <thead>
              <tr className="border-b border-zinc-200 text-zinc-400 dark:border-zinc-800">
                <th className="py-1.5 pr-3 text-left font-medium">Month</th>
                {METRICS.map((m) => <th key={m.key} className="px-3 py-1.5 font-medium">{m.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.month} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-1.5 pr-3 text-left text-zinc-600 dark:text-zinc-300">{monthLabel(r.month)}</td>
                  {METRICS.map((m) => { const v = val(r, m.key); return <td key={m.key} className="px-3 py-1.5 font-mono text-zinc-700 dark:text-zinc-300">{v === null || v === undefined ? "—" : money(v)}</td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MiniChart({ metric, rows, active, pinned, onHover, onPin }: { metric: Metric; rows: PnlRow[]; active: number | null; pinned: number | null; onHover: (i: number | null) => void; onPin: (i: number) => void }) {
  const W = 380, H = 150, padT = 8, padR = 12, padB = 18, padL = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const { domain, ticks } = useMemo(() => {
    const vals = rows.map((r) => val(r, metric.key)).filter((v): v is number => v !== null && v !== undefined);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (metric.zeroBaseline) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    const pad = (hi - lo || 1) * 0.1;
    lo = lo - (lo < 0 || !metric.zeroBaseline ? pad : 0);
    hi = hi + pad;
    const round = 25000;
    lo = Math.floor(lo / round) * round;
    hi = Math.ceil(hi / round) * round;
    const t: number[] = [hi, lo];
    if (metric.zeroBaseline && lo < 0 && hi > 0) t.push(0);
    return { domain: [lo, hi] as [number, number], ticks: t };
  }, [rows, metric]);

  const xs = (i: number) => padL + (rows.length === 1 ? plotW / 2 : (i * plotW) / (rows.length - 1));
  const ys = (v: number) => padT + plotH * (1 - (v - domain[0]) / (domain[1] - domain[0]));

  const path = rows.map((r, i) => { const v = val(r, metric.key) ?? 0; return `${i ? "L" : "M"}${xs(i).toFixed(1)} ${ys(v).toFixed(1)}`; }).join(" ");
  const areaPath = `${path} L${xs(rows.length - 1).toFixed(1)} ${ys(domain[0]).toFixed(1)} L${xs(0).toFixed(1)} ${ys(domain[0]).toFixed(1)} Z`;

  const total = rows.reduce((a, r) => a + (val(r, metric.key) ?? 0), 0); // period aggregate — the headline
  const activeVal = active !== null && rows[active] ? val(rows[active], metric.key) : null;

  const idxFromEvent = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    return Math.max(0, Math.min(rows.length - 1, Math.round(((mx - padL) / plotW) * (rows.length - 1))));
  };
  const gid = `grad-${metric.key}`;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-2 flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: `var(${metric.varName})` }} />{metric.label}
          </span>
          {metric.note && <span className="mt-0.5 block text-[10px] text-zinc-400">{metric.note}</span>}
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-mono text-[16px] font-semibold text-zinc-900 dark:text-zinc-100">{money(total)}</span>
          <span className="block text-[10px] text-zinc-400">
            {activeVal !== null ? `${monthLabel(rows[active!].month)}: ${money(activeVal)}` : `total · ${rows.length} mo`}
          </span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full cursor-pointer" onMouseMove={(e) => onHover(idxFromEvent(e))} onMouseLeave={() => onHover(null)} onClick={(e) => onPin(idxFromEvent(e))}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`var(${metric.varName})`} stopOpacity={0.18} />
            <stop offset="100%" stopColor={`var(${metric.varName})`} stopOpacity={0} />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={ys(t)} x2={padL + plotW} y2={ys(t)} stroke={t === 0 ? "var(--zero)" : "var(--grid)"} strokeWidth={t === 0 ? 1.25 : 1} />
            <text x={padL - 6} y={ys(t) + 3} textAnchor="end" className="fill-zinc-400" fontSize={9}>{money(t)}</text>
          </g>
        ))}
        {[0, Math.floor(rows.length / 2), rows.length - 1].map((i) => (
          <text key={i} x={xs(i)} y={H - padB + 14} textAnchor="middle" className="fill-zinc-400" fontSize={9}>{monthLabel(rows[i].month)}</text>
        ))}
        <path d={areaPath} fill={`url(#${gid})`} />
        <path d={path} fill="none" stroke={`var(${metric.varName})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {active !== null && rows[active] && (
          <>
            <line x1={xs(active)} y1={padT} x2={xs(active)} y2={padT + plotH} stroke="var(--zero)" strokeWidth={1} strokeDasharray={pinned === active ? undefined : "3 3"} />
            {(() => { const v = val(rows[active], metric.key); return v === null || v === undefined ? null : <circle cx={xs(active)} cy={ys(v)} r={4} fill={`var(${metric.varName})`} stroke="var(--card,#fff)" strokeWidth={1.5} />; })()}
          </>
        )}
      </svg>
    </div>
  );
}
