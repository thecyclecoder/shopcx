"use client";

// Acquisition Research Hub — the owner-only surface (docs/brain/specs/acquisition-research-hub.md,
// Phase 1; M4 of the Acquisition Research Engine). One place for the competitor sets + both scouts'
// findings + the unified gap queue → approve routes a gap to Build / the storefront optimizer, tracked
// through to shipped/won. Reads /api/ads/acquisition (owner-only). Nothing routes without approval.

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface CompetitorRow {
  id: string;
  brand: string;
  domain: string | null;
  category: string | null;
  spend_signal: string | null;
  source: string;
  status: string;
}
interface AdEvidence {
  advertiser: string | null;
  destination_domain: string | null;
  days_running: number | null;
}
interface AdGapRec {
  label: string;
  recommendation: string;
  brandCount: number;
  brands: string[];
  maxDaysRunning: number;
  totalEstimatedSpend: number;
  evidence: AdEvidence[];
}
interface AdFindings {
  generatedFrom: number;
  ourAngleCount: number;
  coveredAngles: number;
  recommendations: AdGapRec[];
}
interface LanderSnapshot {
  id: string;
  is_ours: boolean;
  brand: string | null;
  url: string;
  source: string;
  status: string;
  chapter_count: number;
}
interface GapQueueItem {
  id: string;
  source: "ad" | "lander";
  product_title: string | null;
  gap_type: string;
  title: string;
  rationale: string;
  route: "build" | "optimizer";
  status: "proposed" | "approved" | "rejected";
  shipped: boolean;
  won: boolean;
}
interface Throughput {
  proposed: number;
  approved: number;
  shipped: number;
  won: number;
}
interface HubData {
  products: { id: string; title: string | null }[];
  selectedProductId: string | null;
  competitors: CompetitorRow[];
  adFindings: AdFindings;
  landerSnapshots: LanderSnapshot[];
  gapQueue: GapQueueItem[];
  throughput: Throughput;
}

const STATUS_BADGE: Record<string, string> = {
  proposed: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  approved: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  rejected: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className={`text-2xl font-bold ${accent}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}

export default function AcquisitionHubPage() {
  const workspace = useWorkspace();
  const [data, setData] = useState<HubData | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [productId, setProductId] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ workspaceId: workspace.id });
    if (productId) qs.set("productId", productId);
    const res = await fetch(`/api/ads/acquisition?${qs.toString()}`);
    if (res.status === 403) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [workspace.id, productId]);

  useEffect(() => {
    load();
  }, [load]);

  const review = async (item: GapQueueItem, action: "approve" | "reject") => {
    setBusy(item.id);
    const endpoint =
      item.source === "ad"
        ? `/api/ads/acquisition/gaps/${item.id}`
        : `/api/ads/lander-recommendations/${item.id}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, action }),
    });
    setBusy(null);
    if (res.ok) load();
    else {
      const e = await res.json().catch(() => ({}));
      alert(e.error || "Failed");
    }
  };

  if (forbidden) {
    return (
      <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
        <h1 className="mb-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Acquisition Research</h1>
        <p className="text-sm text-zinc-500">This surface is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Acquisition Research</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Competitor sets, the ad &amp; landing-page scouts&apos; findings, and the unified gap queue.
        Approve a gap to route it to Build or the storefront optimizer — tracked through to shipped / won.
      </p>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : !data ? (
        <p className="text-sm text-zinc-500">No data.</p>
      ) : (
        <>
          {/* Throughput — the goal's success metric */}
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Proposed" value={data.throughput.proposed} accent="text-amber-600 dark:text-amber-400" />
            <StatCard label="Approved" value={data.throughput.approved} accent="text-indigo-600 dark:text-indigo-400" />
            <StatCard label="Shipped" value={data.throughput.shipped} accent="text-sky-600 dark:text-sky-400" />
            <StatCard label="Won" value={data.throughput.won} accent="text-emerald-600 dark:text-emerald-400" />
          </div>

          {/* Product scope */}
          <div className="mb-6 flex items-center gap-2">
            <label className="text-xs uppercase tracking-wide text-zinc-500">Product</label>
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="rounded border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">All products</option>
              {data.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title || p.id}
                </option>
              ))}
            </select>
          </div>

          {/* The unified gap queue */}
          <section className="mb-8">
            <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Gap queue</h2>
            {data.gapQueue.length === 0 ? (
              <p className="text-sm text-zinc-500">No gaps surfaced yet.</p>
            ) : (
              <div className="space-y-2">
                {data.gapQueue.map((g) => (
                  <div
                    key={`${g.source}-${g.id}`}
                    className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {g.source}
                      </span>
                      <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                        → {g.route}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[g.status]}`}>
                        {g.status}
                      </span>
                      {g.shipped && (
                        <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                          shipped
                        </span>
                      )}
                      {g.won && (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                          won
                        </span>
                      )}
                      {g.product_title && <span className="text-xs text-zinc-400">{g.product_title}</span>}
                    </div>
                    <div className="mt-1 font-medium text-zinc-900 dark:text-zinc-100">{g.title}</div>
                    <div className="text-sm text-zinc-600 dark:text-zinc-400">{g.rationale}</div>
                    {g.status === "proposed" && (
                      <div className="mt-2 flex gap-2">
                        <button
                          disabled={busy === g.id}
                          onClick={() => review(g, "approve")}
                          className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          Approve &amp; route
                        </button>
                        <button
                          disabled={busy === g.id}
                          onClick={() => review(g, "reject")}
                          className="rounded border border-zinc-200 px-3 py-1 text-xs font-semibold text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Competitor set */}
          <section className="mb-8">
            <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Competitor set</h2>
            {data.competitors.length === 0 ? (
              <p className="text-sm text-zinc-500">No competitors yet.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                    <tr>
                      <th className="px-4 py-2">Brand</th>
                      <th className="px-4 py-2">Domain</th>
                      <th className="px-4 py-2">Source</th>
                      <th className="px-4 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {data.competitors.map((c) => (
                      <tr key={c.id} className="bg-white dark:bg-zinc-950">
                        <td className="px-4 py-2 font-medium text-zinc-900 dark:text-zinc-100">{c.brand}</td>
                        <td className="px-4 py-2 text-zinc-500">{c.domain || "—"}</td>
                        <td className="px-4 py-2 text-zinc-500">{c.source}</td>
                        <td className="px-4 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[c.status] || ""}`}>
                            {c.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Ad findings */}
          <section className="mb-8">
            <h2 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Ad findings</h2>
            <p className="mb-2 text-xs text-zinc-500">
              {data.adFindings.recommendations.length} competitor angles we don&apos;t run · from{" "}
              {data.adFindings.generatedFrom} analyzed ads · {data.adFindings.ourAngleCount} of ours.
            </p>
            {data.adFindings.recommendations.length === 0 ? (
              <p className="text-sm text-zinc-500">No ad gaps (run the creative-finder sweep for approved competitors).</p>
            ) : (
              <div className="space-y-2">
                {data.adFindings.recommendations.slice(0, 12).map((r) => (
                  <div
                    key={r.label}
                    className="rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.label}</div>
                    <div className="text-zinc-600 dark:text-zinc-400">{r.recommendation}</div>
                    <div className="mt-1 text-xs text-zinc-400">
                      {r.brandCount} brands · up to {r.maxDaysRunning}d running · ${Math.round(r.totalEstimatedSpend).toLocaleString()} est. spend
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Lander findings */}
          <section className="mb-8">
            <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Lander findings</h2>
            {data.landerSnapshots.length === 0 ? (
              <p className="text-sm text-zinc-500">No lander snapshots yet.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                    <tr>
                      <th className="px-4 py-2">Brand</th>
                      <th className="px-4 py-2">URL</th>
                      <th className="px-4 py-2">Source</th>
                      <th className="px-4 py-2">Chapters</th>
                      <th className="px-4 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {data.landerSnapshots.map((s) => (
                      <tr key={s.id} className="bg-white dark:bg-zinc-950">
                        <td className="px-4 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                          {s.is_ours ? "us" : s.brand || "—"}
                        </td>
                        <td className="max-w-xs truncate px-4 py-2 text-zinc-500" title={s.url}>
                          {s.url.replace(/^https?:\/\//, "")}
                        </td>
                        <td className="px-4 py-2 text-zinc-500">{s.source}</td>
                        <td className="px-4 py-2 text-zinc-500">{s.chapter_count}</td>
                        <td className="px-4 py-2 text-zinc-500">{s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
