"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Summary {
  total_customers: number;
  enriched_count: number;
  gender_distribution: Record<string, number>;
  age_distribution: Record<string, number>;
  income_distribution: Record<string, number>;
  urban_distribution: Record<string, number>;
  buyer_type_distribution: Record<string, number>;
  top_health_priorities: Array<{ priority: string; count: number }>;
  suggested_target_customer: string | null;
}

interface Status {
  total_customers: number;
  enriched: number;
  pending: number;
  last_enriched_at: string | null;
  enrichment_version: number | null;
  zip_codes_cached: number;
}

const AGE_LABELS: Record<string, string> = {
  under_25: "Under 25",
  "25-34": "25-34",
  "35-44": "35-44",
  "45-54": "45-54",
  "55-64": "55-64",
  "65+": "65+",
};

const INCOME_LABELS: Record<string, string> = {
  under_40k: "Under $40K",
  "40-60k": "$40-60K",
  "60-80k": "$60-80K",
  "80-100k": "$80-100K",
  "100-125k": "$100-125K",
  "125-150k": "$125-150K",
  "150k+": "$150K+",
};

const BUYER_LABELS: Record<string, string> = {
  committed_subscriber: "Committed subscriber",
  new_subscriber: "New subscriber",
  lapsed_subscriber: "Lapsed subscriber",
  value_buyer: "Value buyer",
  cautious_buyer: "Cautious buyer",
  one_time_buyer: "One-time buyer",
};

function prettyKey(k: string, map?: Record<string, string>): string {
  if (map && map[k]) return map[k];
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface ProductOption {
  id: string;
  title: string;
}

export default function DemographicsPage() {
  const workspace = useWorkspace();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [forceAll, setForceAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<string>("");

  // Load products list once
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/products`)
      .then(r => r.ok ? r.json() : { products: [] })
      .then(d => setProducts((d.products || []).filter((p: ProductOption & { status?: string }) => p.status === "active")))
      .catch(() => {});
  }, [workspace.id]);

  const load = useCallback(async () => {
    const productParam = selectedProduct ? `?product_id=${selectedProduct}` : "";
    const [sumRes, statRes] = await Promise.all([
      fetch(`/api/workspaces/${workspace.id}/demographics/summary${productParam}`),
      fetch(`/api/workspaces/${workspace.id}/demographics/status`),
    ]);
    if (sumRes.ok) setSummary(await sumRes.json());
    if (statRes.ok) setStatus(await statRes.json());
    setLoading(false);
  }, [workspace.id, selectedProduct]);

  useEffect(() => {
    load();
  }, [load]);

  const runEnrichment = async () => {
    setEnriching(true);
    try {
      await fetch(`/api/workspaces/${workspace.id}/demographics/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force_all: forceAll }),
      });
    } finally {
      setTimeout(() => {
        load();
        setEnriching(false);
      }, 1500);
    }
  };

  const copyTarget = async () => {
    if (!summary?.suggested_target_customer) return;
    try {
      await navigator.clipboard.writeText(summary.suggested_target_customer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no-op
    }
  };

  const progressPct = useMemo(() => {
    if (!status || status.total_customers === 0) return 0;
    return Math.round((status.enriched / status.total_customers) * 100);
  }, [status]);

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <p className="text-sm text-zinc-400">Loading demographics...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Customer Demographics</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Inferred from names (Claude Haiku), zip codes (US Census ACS), and order history. Internal use only.
          </p>
          <div className="mt-3">
            <select
              value={selectedProduct}
              onChange={e => { setSelectedProduct(e.target.value); setLoading(true); }}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            >
              <option value="">All Customers</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
            {selectedProduct && (
              <span className="ml-2 text-xs text-zinc-500">Showing demographics for customers who purchased this product</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={forceAll}
              onChange={(e) => setForceAll(e.target.checked)}
              className="rounded border-zinc-300 dark:border-zinc-700"
            />
            Re-enrich all
          </label>
          <button
            onClick={runEnrichment}
            disabled={enriching}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            {enriching ? "Queued..." : "Run Enrichment"}
          </button>
        </div>
      </div>

      {/* Status bar */}
      {status && (
        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              {status.enriched.toLocaleString()} of {status.total_customers.toLocaleString()} customers enriched
            </span>
            <span className="text-xs text-zinc-500">{progressPct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(2, progressPct)}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-zinc-500">
            <span>{status.pending.toLocaleString()} pending</span>
            <span>{status.zip_codes_cached.toLocaleString()} zip codes cached</span>
            {status.last_enriched_at && <span>Last enriched: {new Date(status.last_enriched_at).toLocaleString()}</span>}
          </div>
        </div>
      )}

      {/* Suggested target customer */}
      {summary?.suggested_target_customer && (
        <div className="mb-6 rounded-lg border border-indigo-200 bg-indigo-50 p-5 dark:border-indigo-800 dark:bg-indigo-950/40">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
            Suggested target customer
          </div>
          <p className="text-base text-zinc-900 dark:text-zinc-100">
            {summary.suggested_target_customer}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={copyTarget}
              className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 shadow-sm hover:bg-indigo-100 dark:bg-zinc-900 dark:text-indigo-300 dark:hover:bg-zinc-800"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-2 text-[10px] text-indigo-600 dark:text-indigo-400">
            Based on the most common demographic values across your {summary.enriched_count.toLocaleString()} enriched customers. Use as the starting point for Product Intelligence Engine&apos;s target customer field.
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <DistributionCard
          title="Gender"
          distribution={summary?.gender_distribution || {}}
          total={summary?.enriched_count || 0}
        />
        <DistributionCard
          title="Age Range"
          distribution={summary?.age_distribution || {}}
          total={summary?.enriched_count || 0}
          labelMap={AGE_LABELS}
        />
        <DistributionCard
          title="Household Income (by zip)"
          distribution={summary?.income_distribution || {}}
          total={summary?.enriched_count || 0}
          labelMap={INCOME_LABELS}
        />
        <DistributionCard
          title="Urban / Suburban / Rural"
          distribution={summary?.urban_distribution || {}}
          total={summary?.enriched_count || 0}
        />
        <DistributionCard
          title="Buyer Type"
          distribution={summary?.buyer_type_distribution || {}}
          total={summary?.enriched_count || 0}
          labelMap={BUYER_LABELS}
        />

        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Top Health Priorities
          </h3>
          {(summary?.top_health_priorities || []).length === 0 ? (
            <p className="text-xs text-zinc-400">No priorities detected yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {(summary?.top_health_priorities || []).map((p) => (
                <li key={p.priority} className="flex items-center justify-between text-sm">
                  <span className="text-zinc-700 dark:text-zinc-300">{prettyKey(p.priority)}</span>
                  <span className="text-xs text-zinc-500">{p.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="mt-6 text-[10px] text-zinc-400">
        Demographic inferences use aggregate name popularity and US Census ACS 2022 data. Never use for individual
        pricing or service decisions. Confidence thresholds: &ge;0.85 strong, 0.65-0.84 moderate, below 0.65 hidden.
      </p>
    </div>
  );
}

function DistributionCard({
  title,
  distribution,
  total,
  labelMap,
}: {
  title: string;
  distribution: Record<string, number>;
  total: number;
  labelMap?: Record<string, string>;
}) {
  const entries = Object.entries(distribution)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  const max = entries.length > 0 ? entries[0][1] : 1;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-xs text-zinc-400">No data yet — run enrichment.</p>
      ) : (
        <div className="space-y-2">
          {entries.map(([key, count]) => (
            <div key={key}>
              <div className="mb-0.5 flex items-baseline justify-between text-xs">
                <span className="text-zinc-700 dark:text-zinc-300">{prettyKey(key, labelMap)}</span>
                <span className="text-zinc-500">
                  {count.toLocaleString()}
                  {total > 0 && <span className="ml-1 text-zinc-400">({Math.round((count / total) * 100)}%)</span>}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div
                  className="h-full rounded-full bg-indigo-400"
                  style={{ width: `${Math.max(4, (count / max) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
