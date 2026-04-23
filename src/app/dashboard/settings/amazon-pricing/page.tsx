"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface AsinRow {
  id: string;
  asin: string;
  sku: string;
  title: string;
  image_url: string | null;
  current_price: number | null;
  business_price: number | null;
  currency: string;
}

function fmt(n: number | null): string {
  if (n == null) return "—";
  return "$" + n.toFixed(2);
}

export default function AmazonPricingPage() {
  const workspace = useWorkspace();
  const [asins, setAsins] = useState<AsinRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, { price?: number; business_price?: number }>>({});
  const [saving, setSaving] = useState(false);
  const [bulkPct, setBulkPct] = useState(15);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/workspaces/${workspace.id}/amazon/pricing`)
      .then(r => r.json())
      .then(d => { setAsins(d.asins || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [workspace.id]);

  const hasEdits = Object.keys(edits).length > 0;

  function setEdit(sku: string, field: "price" | "business_price", value: string) {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0) return;
    setEdits(prev => ({
      ...prev,
      [sku]: { ...prev[sku], [field]: num },
    }));
  }

  function clearEdit(sku: string) {
    setEdits(prev => {
      const next = { ...prev };
      delete next[sku];
      return next;
    });
  }

  function applyBulkIncrease() {
    const newEdits: Record<string, { price?: number; business_price?: number }> = {};
    for (const a of asins) {
      if (a.current_price != null && a.current_price > 0) {
        const newPrice = Math.round(a.current_price * (1 + bulkPct / 100) * 100) / 100;
        const newBiz = a.business_price != null
          ? Math.max(newPrice, Math.round(a.business_price * (1 + bulkPct / 100) * 100) / 100)
          : undefined;
        newEdits[a.sku] = { price: newPrice, ...(newBiz ? { business_price: newBiz } : {}) };
      }
    }
    setEdits(newEdits);
  }

  async function saveChanges() {
    setSaving(true);
    setMessage(null);
    const updates = Object.entries(edits).map(([sku, edit]) => {
      const asin = asins.find(a => a.sku === sku);
      return {
        sku,
        price: edit.price ?? asin?.current_price ?? 0,
        business_price: edit.business_price,
      };
    }).filter(u => u.price > 0);

    // Validate: business price must not be lower than standard
    for (const u of updates) {
      if (u.business_price && u.business_price < u.price) {
        setMessage(`Error: Business price for ${u.sku} ($${u.business_price}) cannot be lower than standard price ($${u.price})`);
        setSaving(false);
        return;
      }
    }

    const res = await fetch(`/api/workspaces/${workspace.id}/amazon/pricing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    const data = await res.json();

    const successes = (data.results || []).filter((r: { success: boolean }) => r.success).length;
    const failures = (data.results || []).filter((r: { success: boolean }) => !r.success);

    if (failures.length > 0) {
      setMessage(`${successes} updated, ${failures.length} failed: ${failures[0].error}`);
    } else {
      setMessage(`${successes} price(s) updated successfully!`);
      setEdits({});
      // Reload
      const reload = await fetch(`/api/workspaces/${workspace.id}/amazon/pricing`);
      const d = await reload.json();
      setAsins(d.asins || []);
    }
    setSaving(false);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Amazon Pricing</h1>
          <p className="mt-1 text-sm text-zinc-500">Manage listing prices. Business price must never be lower than standard price.</p>
        </div>
        <div className="flex items-center gap-3">
          {hasEdits && (
            <button onClick={saveChanges} disabled={saving}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              {saving ? "Saving..." : `Save ${Object.keys(edits).length} change(s)`}
            </button>
          )}
        </div>
      </div>

      {message && (
        <div className={`mb-4 rounded-md p-3 text-sm ${message.includes("failed") || message.includes("Error") ? "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"}`}>
          {message}
        </div>
      )}

      {/* Bulk actions */}
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <span className="text-sm text-zinc-500">Bulk increase all prices by</span>
        <input type="number" value={bulkPct} onChange={(e) => setBulkPct(Number(e.target.value))}
          className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
        <span className="text-sm text-zinc-500">%</span>
        <button onClick={applyBulkIncrease}
          className="rounded-md border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
          Apply to all
        </button>
        {hasEdits && (
          <button onClick={() => setEdits({})}
            className="text-sm text-zinc-400 hover:text-zinc-600">
            Clear all edits
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-zinc-400">Loading prices from Amazon...</p>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">ASIN</th>
                <th className="px-4 py-2">SKU</th>
                <th className="px-4 py-2 text-right">Current Price</th>
                <th className="px-4 py-2 text-right">New Price</th>
                <th className="px-4 py-2 text-right">Business Price</th>
                <th className="px-4 py-2 text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              {asins.map(a => {
                const edit = edits[a.sku];
                const newPrice = edit?.price ?? a.current_price;
                const priceDiff = (newPrice ?? 0) - (a.current_price ?? 0);
                const hasChange = !!edit;

                return (
                  <tr key={a.id} className={`border-b border-zinc-50 dark:border-zinc-800/50 ${hasChange ? "bg-amber-50/50 dark:bg-amber-950/10" : ""}`}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {a.image_url && <img src={a.image_url} alt="" className="h-8 w-8 rounded object-cover" />}
                        <span className="text-zinc-700 dark:text-zinc-300 max-w-[200px] truncate" title={a.title}>{a.title}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-500 text-xs font-mono">{a.asin}</td>
                    <td className="px-4 py-2.5 text-zinc-500 text-xs font-mono">{a.sku}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {fmt(a.current_price)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <input
                        type="number"
                        step="0.01"
                        value={edit?.price ?? a.current_price ?? ""}
                        onChange={(e) => setEdit(a.sku, "price", e.target.value)}
                        className={`w-24 rounded border px-2 py-1 text-right text-sm tabular-nums ${hasChange ? "border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/30" : "border-zinc-200 dark:border-zinc-700 dark:bg-zinc-800"} dark:text-zinc-100`}
                      />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <input
                        type="number"
                        step="0.01"
                        value={edit?.business_price ?? a.business_price ?? ""}
                        onChange={(e) => setEdit(a.sku, "business_price", e.target.value)}
                        placeholder="—"
                        className={`w-24 rounded border px-2 py-1 text-right text-sm tabular-nums ${edit?.business_price ? "border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/30" : "border-zinc-200 dark:border-zinc-700 dark:bg-zinc-800"} dark:text-zinc-100`}
                      />
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {hasChange && priceDiff !== 0 ? (
                        <div className="flex items-center justify-end gap-2">
                          <span className={priceDiff > 0 ? "text-emerald-600" : "text-red-600"}>
                            {priceDiff > 0 ? "+" : ""}{fmt(priceDiff)}
                          </span>
                          <button onClick={() => clearEdit(a.sku)} className="text-zinc-400 hover:text-zinc-600" title="Reset">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
