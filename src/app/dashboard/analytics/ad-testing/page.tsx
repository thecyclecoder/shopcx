"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

// Mirrors src/lib/ads/testing-results-sdk.ts (READ-ONLY lens).
type TestTier = "crown" | "promising" | "testing" | "dud";
interface TestCreative {
  headline: string | null; primaryText: string | null; description: string | null;
  thumbnailUrl?: string | null; imageUrl?: string | null; link?: string | null;
  metaEnriched?: boolean; metaAdId?: string | null;
}
interface TestAdsetRow {
  adsetId: string; adsetName: string; effectiveStatus: string; active: boolean;
  spendCents: number; impressions: number; addToCart: number; purchases: number;
  cpmCents: number; ctrPct: number; costPerAtcCents: number | null; cacCents: number | null;
  tier: TestTier; lastDataDate: string | null; creative: TestCreative | null;
}
interface ProductTestGroup {
  productTitle: string; metaAccountName: string; campaignIds: string[];
  activeCount: number; rows: TestAdsetRow[]; flags: string[];
}
interface AccountFreshness { metaAccountName: string; latestSnapshot: string | null; ageHours: number | null; }
interface TestThresholds {
  crownMaxCpaCents: number; crownMinSpendCents: number; crownMinPurchases: number;
  holdBandMaxCpaCents: number; maxTestSpendCents: number; earlyTrimMinSpendCents: number;
}
interface TestingResults {
  generatedAt: string; thresholds: TestThresholds; products: ProductTestGroup[];
  globalFlags: string[]; freshness: AccountFreshness[];
}

const usd = (c: number) => "$" + Math.round(c / 100).toLocaleString();
const usdOrDash = (c: number | null) => (c == null ? "—" : usd(c));

const TIER: Record<TestTier, { label: string; cls: string }> = {
  crown: { label: "👑 Crown", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  promising: { label: "📈 Promising", cls: "bg-green-100 text-green-800 border-green-300" },
  testing: { label: "⏳ Testing", cls: "bg-slate-100 text-slate-700 border-slate-300" },
  dud: { label: "💀 Dud", cls: "bg-red-100 text-red-700 border-red-300" },
};

function Thumb({ row, onClick }: { row: TestAdsetRow; onClick: () => void }) {
  const url = row.creative?.thumbnailUrl ?? row.creative?.imageUrl ?? null;
  return (
    <button
      onClick={onClick}
      className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-50 hover:ring-2 hover:ring-indigo-400"
      title="View creative"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={row.adsetName} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">no img</span>
      )}
    </button>
  );
}

function CreativeModal({ row, onClose }: { row: TestAdsetRow; onClose: () => void }) {
  const c = row.creative;
  const img = c?.imageUrl ?? c?.thumbnailUrl ?? null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-100 p-4">
          <div>
            <div className="text-sm font-semibold text-slate-900">{row.adsetName}</div>
            <div className="text-xs text-slate-500">
              {TIER[row.tier].label} · {row.active ? "live" : "paused"} · {usd(row.spendCents)} spend · {row.purchases} sales · CAC {usdOrDash(row.cacCents)}
            </div>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">✕</button>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
            {img ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={img} alt={row.adsetName} className="w-full object-contain" />
            ) : (
              <div className="flex h-64 items-center justify-center text-sm text-slate-400">No creative image</div>
            )}
          </div>
          <div className="space-y-3 text-sm">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Headline</div>
              <div className="text-slate-900">{c?.headline || <span className="text-slate-400">—</span>}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Primary text</div>
              <div className="whitespace-pre-wrap text-slate-700">{c?.primaryText || <span className="text-slate-400">—</span>}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Description</div>
              <div className="text-slate-700">{c?.description || <span className="text-slate-400">—</span>}</div>
            </div>
            {c?.link && (
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Destination</div>
                <a href={c.link} target="_blank" rel="noreferrer" className="break-all text-indigo-600 hover:underline">{c.link}</a>
              </div>
            )}
            {!c?.metaEnriched && <div className="text-xs text-amber-600">Copy is a publish-time snapshot (live creative not loaded).</div>}
          </div>
        </div>
        {/* funnel strip */}
        <div className="grid grid-cols-3 gap-2 border-t border-slate-100 p-4 text-center text-xs sm:grid-cols-6">
          {[
            ["Spend", usd(row.spendCents)], ["CPM", usdOrDash(row.cpmCents || null)], ["CTR", `${row.ctrPct}%`],
            ["ATC", String(row.addToCart)], ["$/ATC", usdOrDash(row.costPerAtcCents)], ["Sales", String(row.purchases)],
          ].map(([k, v]) => (
            <div key={k} className="rounded bg-slate-50 p-2">
              <div className="text-[10px] uppercase text-slate-400">{k}</div>
              <div className="font-semibold text-slate-800">{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function AdTestingDashboard() {
  const workspace = useWorkspace();
  const [data, setData] = useState<TestingResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalRow, setModalRow] = useState<TestAdsetRow | null>(null);

  useEffect(() => {
    if (!workspace?.id) return;
    setLoading(true);
    fetch(`/api/workspaces/${workspace.id}/analytics/ad-testing`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: TestingResults) => { setData(d); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [workspace?.id]);

  const t = data?.thresholds;

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Ad Testing</h1>
        {data && <span className="text-xs text-slate-400">as of {new Date(data.generatedAt).toLocaleString()}</span>}
      </div>
      <p className="mb-4 text-sm text-slate-500">
        One row per live test (ad set), grouped by product, sorted crowning-potential → early dud. Numbers are
        cumulative-lifetime and today-inclusive (refreshed every 2h). Read-only.
      </p>

      {t && (
        <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <span className="font-semibold">Verdict rules:</span>{" "}
          Crown = ≥{t.crownMinPurchases} sales @ CAC ≤ {usd(t.crownMaxCpaCents)} @ ≥ {usd(t.crownMinSpendCents)} spend ·
          Hold band ≤ {usd(t.holdBandMaxCpaCents)} · Deadline {usd(t.maxTestSpendCents)} · Early-trim ≥ {usd(t.earlyTrimMinSpendCents)} with 0 sales
        </div>
      )}

      {loading && <div className="py-16 text-center text-slate-400">Loading test results…</div>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Failed to load: {error}</div>}

      {data && !loading && (
        <>
          {data.globalFlags.length > 0 && (
            <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700">Structure issues</div>
              <ul className="list-disc pl-5 text-sm text-amber-800">
                {data.globalFlags.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}

          <div className="space-y-6">
            {data.products.map((g) => (
              <div key={g.productTitle + g.metaAccountName} className="overflow-hidden rounded-xl border border-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3">
                  <div>
                    <span className="text-base font-semibold text-slate-900">{g.productTitle}</span>
                    <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-xs text-slate-500 ring-1 ring-slate-200">{g.metaAccountName}</span>
                  </div>
                  <span className="text-xs text-slate-500">{g.activeCount} active · {g.campaignIds.length} campaign{g.campaignIds.length !== 1 ? "s" : ""}</span>
                </div>
                <div className="divide-y divide-slate-100">
                  {g.rows.map((row) => (
                    <div key={row.adsetId} className={`px-4 py-2.5 ${row.active ? "" : "opacity-60"}`}>
                      <div className="flex items-center gap-3">
                        <Thumb row={row} onClick={() => setModalRow(row)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${TIER[row.tier].cls}`}>{TIER[row.tier].label}</span>
                            <span className={`text-[11px] ${row.active ? "text-green-600" : "text-slate-400"}`}>{row.active ? "● live" : "○ paused"}</span>
                          </div>
                          <div className="truncate text-sm text-slate-700">{row.creative?.headline || row.adsetName}</div>
                        </div>
                        {/* Desktop: compact inline metrics. Hidden on mobile, where the metrics grid below takes over. */}
                        <div className="hidden shrink-0 gap-4 text-right text-xs text-slate-600 sm:flex">
                          <Metric k="Spend" v={usd(row.spendCents)} />
                          <Metric k="CPM" v={usdOrDash(row.cpmCents || null)} />
                          <Metric k="CTR" v={`${row.ctrPct}%`} />
                          <Metric k="ATC" v={String(row.addToCart)} />
                          <Metric k="Sales" v={String(row.purchases)} strong />
                          <Metric k="CAC" v={usdOrDash(row.cacCents)} strong />
                        </div>
                      </div>
                      {/* Mobile: the same metrics as a readable 3-col card grid (the desktop row hides them off-screen). */}
                      <div className="mt-2.5 grid grid-cols-3 gap-x-3 gap-y-2 rounded-lg bg-slate-50 p-3 sm:hidden">
                        <MobileMetric k="Spend" v={usd(row.spendCents)} />
                        <MobileMetric k="CPM" v={usdOrDash(row.cpmCents || null)} />
                        <MobileMetric k="CTR" v={`${row.ctrPct}%`} />
                        <MobileMetric k="ATC" v={String(row.addToCart)} />
                        <MobileMetric k="Sales" v={String(row.purchases)} strong />
                        <MobileMetric k="CAC" v={usdOrDash(row.cacCents)} strong />
                      </div>
                    </div>
                  ))}
                </div>
                {g.flags.length > 0 && (
                  <div className="border-t border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-700">
                    {g.flags.map((f, i) => <div key={i}>⚠ {f}</div>)}
                  </div>
                )}
              </div>
            ))}
          </div>

          {data.freshness.length > 0 && (
            <div className="mt-6 text-xs text-slate-400">
              Data freshness:{" "}
              {data.freshness.map((f, i) => (
                <span key={f.metaAccountName}>
                  {i > 0 && " · "}
                  {f.metaAccountName} {f.ageHours == null ? "no data" : `${f.ageHours}h ago`}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {modalRow && <CreativeModal row={modalRow} onClose={() => setModalRow(null)} />}
    </div>
  );
}

function Metric({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="w-14">
      <div className="text-[10px] uppercase text-slate-400">{k}</div>
      <div className={strong ? "font-semibold text-slate-900" : "text-slate-700"}>{v}</div>
    </div>
  );
}

// Mobile-only metric cell — fills its grid column (no fixed width) with a larger, tappable-sized
// value so the funnel is legible on a phone, where the desktop inline metrics row is hidden.
function MobileMetric({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{k}</div>
      <div className={`truncate text-sm ${strong ? "font-semibold text-slate-900" : "text-slate-700"}`}>{v}</div>
    </div>
  );
}
