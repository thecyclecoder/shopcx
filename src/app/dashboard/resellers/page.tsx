"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface Reseller {
  id: string;
  platform: string;
  amazon_seller_id: string | null;
  business_name: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  status: "active" | "dormant" | "whitelisted" | "unverified";
  source_asins: string[] | null;
  notes: string | null;
  discovered_at: string;
  last_seen_at: string;
}

interface ApiPayload {
  resellers: Reseller[];
  statusCounts: Record<string, number>;
  recentRuns: Array<{ ranAt: string; discovered: number }>;
}

const STATUS_OPTIONS: Array<{ value: Reseller["status"]; label: string; color: string }> = [
  { value: "active", label: "Active — blocked", color: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300" },
  { value: "dormant", label: "Dormant", color: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
  { value: "whitelisted", label: "Whitelisted", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" },
  { value: "unverified", label: "Unverified", color: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" },
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function ResellersPage() {
  const workspace = useWorkspace();
  const [data, setData] = useState<ApiPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [discoveryStarted, setDiscoveryStarted] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/resellers`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { load(); }, [load]);

  async function updateStatus(resellerId: string, status: Reseller["status"]) {
    setBusy(true);
    await fetch(`/api/workspaces/${workspace.id}/resellers/${resellerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusy(false);
    load();
  }

  async function runDiscovery() {
    setBusy(true);
    setDiscoveryStarted(new Date().toISOString());
    await fetch(`/api/workspaces/${workspace.id}/resellers/discover`, { method: "POST" });
    setBusy(false);
    // Auto-poll for ~3 minutes so the UI updates without a manual refresh
    let polls = 0;
    const interval = setInterval(async () => {
      polls++;
      await load();
      if (polls >= 18) clearInterval(interval); // 18 × 10s = 3 min
    }, 10000);
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 py-6">
        <p className="text-sm text-zinc-400">Loading resellers…</p>
      </div>
    );
  }

  const resellers = data?.resellers || [];
  const counts = data?.statusCounts || { active: 0, dormant: 0, whitelisted: 0, unverified: 0 };
  const recentRuns = data?.recentRuns || [];
  const lastRun = recentRuns[0];

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Known Resellers</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Operators we&apos;ve identified buying from our store with coupons and reselling on Amazon.
            Discovered automatically from Amazon SP-API. Active resellers&apos; addresses are blocked
            by the <code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">amazon_reseller</code> fraud rule.
          </p>
        </div>
        <button
          onClick={runDiscovery}
          disabled={busy}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          {busy ? "Running…" : "Run discovery now"}
        </button>
      </div>

      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STATUS_OPTIONS.map(opt => (
          <div key={opt.value} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{counts[opt.value] || 0}</div>
            <div className="mt-1 text-xs text-zinc-500">{opt.label}</div>
          </div>
        ))}
      </div>

      {/* Last discovery run */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Discovery History
        </h2>
        {lastRun ? (
          <div className="text-sm text-zinc-700 dark:text-zinc-300">
            Last run: <span className="font-medium">{formatDate(lastRun.ranAt)}</span>
            {" — "}
            <span className="font-medium">{lastRun.discovered}</span> new reseller{lastRun.discovered === 1 ? "" : "s"} discovered
          </div>
        ) : (
          <p className="text-sm text-zinc-500">No discovery runs yet. Click &quot;Run discovery now&quot; to start.</p>
        )}
        {discoveryStarted && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            Discovery dispatched at {formatDate(discoveryStarted)} — runs in the background, takes 1-3 minutes.
            New rows will appear in the table below.
          </p>
        )}
        {recentRuns.length > 1 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700">
              {recentRuns.length} recent runs
            </summary>
            <ul className="mt-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
              {recentRuns.map((r, i) => (
                <li key={i}>{formatDate(r.ranAt)} — {r.discovered} new</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* Reseller table */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {resellers.length === 0 ? (
          <p className="p-6 text-sm text-zinc-500">
            No resellers discovered yet. Run discovery to scan Amazon SP-API.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800">
                <th className="px-4 py-2">Business</th>
                <th className="px-4 py-2">Address</th>
                <th className="px-4 py-2">Source ASINs</th>
                <th className="px-4 py-2">Discovered</th>
                <th className="px-4 py-2">Last seen</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {resellers.map((r) => {
                const opt = STATUS_OPTIONS.find(o => o.value === r.status);
                return (
                  <tr key={r.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">
                        {r.business_name || "(no business name)"}
                      </div>
                      <div className="mt-0.5 text-[10px] text-zinc-400">
                        {r.platform === "amazon" && r.amazon_seller_id ? (
                          <a href={`https://www.amazon.com/sp?seller=${r.amazon_seller_id}`}
                             target="_blank" rel="noopener noreferrer"
                             className="font-mono hover:text-emerald-600">
                            {r.amazon_seller_id}
                          </a>
                        ) : (
                          <span className="font-mono">{r.amazon_seller_id || "—"}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
                      <div>{r.address1}{r.address2 ? `, ${r.address2}` : ""}</div>
                      <div>{r.city}, {r.state} {r.zip}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                      {(r.source_asins || []).length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {(r.source_asins || []).slice(0, 3).map(a => (
                            <span key={a} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-zinc-800">{a}</span>
                          ))}
                          {(r.source_asins || []).length > 3 && (
                            <span className="text-[10px]">+{(r.source_asins || []).length - 3}</span>
                          )}
                        </div>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500">{formatDate(r.discovered_at)}</td>
                    <td className="px-4 py-3 text-xs text-zinc-500">{formatDate(r.last_seen_at)}</td>
                    <td className="px-4 py-3">
                      <select
                        value={r.status}
                        onChange={(e) => updateStatus(r.id, e.target.value as Reseller["status"])}
                        disabled={busy}
                        className={`rounded-md px-2 py-1 text-xs font-medium ${opt?.color || ""} disabled:opacity-50`}
                      >
                        {STATUS_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-4 text-[10px] text-zinc-400">
        Status: <span className="text-red-600">Active</span> = order addresses matching this reseller will be flagged by the
        amazon_reseller fraud rule (and orders held in Shopify).
        <span className="text-emerald-600 ml-1">Whitelisted</span> = legitimate B2B partner; ignore.
        <span className="ml-1">Dormant</span> = no longer competing.
        Weekly discovery runs Mondays at 6 AM Central via the
        <Link href="/dashboard/settings/fraud" className="ml-1 text-emerald-600 hover:underline">Fraud rules page</Link>.
      </p>
    </div>
  );
}
