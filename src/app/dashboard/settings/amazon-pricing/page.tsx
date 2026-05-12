"use client";

import React, { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface AsinRow {
  id: string;
  asin: string;
  sku: string;
  title: string;
  image_url: string | null;
  current_price: number | null;
  business_price: number | null;
  list_price: number | null;
  sale_price: number | null;
  sale_start_at: string | null;
  sale_end_at: string | null;
  currency: string;
}

interface Edit {
  price?: number;
  business_price?: number;
  // Sale fields. `sale_action` distinguishes intent:
  //   "set" — write a new sale (requires sale_price + start + end)
  //   "clear" — explicitly remove any existing sale
  //   undefined — sale unchanged from server state
  sale_action?: "set" | "clear";
  sale_price?: number;
  sale_start_at?: string;
  sale_end_at?: string;
}

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return "$" + n.toFixed(2);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

// Convert ISO → datetime-local input value (YYYY-MM-DDTHH:mm in user TZ)
function isoToLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function AmazonPricingPage() {
  const workspace = useWorkspace();
  const [asins, setAsins] = useState<AsinRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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

  function patchEdit(sku: string, patch: Partial<Edit>) {
    setEdits(prev => {
      const next = { ...prev[sku], ...patch };
      // If the edit is empty, drop it
      if (next.price == null && next.business_price == null && !next.sale_action) {
        const out = { ...prev };
        delete out[sku];
        return out;
      }
      return { ...prev, [sku]: next };
    });
  }

  function setEditPrice(sku: string, value: string) {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0) return;
    patchEdit(sku, { price: num });
  }

  function clearEdit(sku: string) {
    setEdits(prev => {
      const next = { ...prev };
      delete next[sku];
      return next;
    });
  }

  function setSaleEdit(sku: string, patch: { sale_price?: string; sale_start_at?: string; sale_end_at?: string }) {
    setEdits(prev => {
      const cur = prev[sku] || {};
      const next: Edit = { ...cur, sale_action: "set" };
      if (patch.sale_price !== undefined) {
        const num = parseFloat(patch.sale_price);
        next.sale_price = isNaN(num) ? undefined : num;
      }
      if (patch.sale_start_at !== undefined) {
        next.sale_start_at = patch.sale_start_at ? new Date(patch.sale_start_at).toISOString() : undefined;
      }
      if (patch.sale_end_at !== undefined) {
        next.sale_end_at = patch.sale_end_at ? new Date(patch.sale_end_at).toISOString() : undefined;
      }
      return { ...prev, [sku]: next };
    });
  }

  function markSaleClear(sku: string) {
    patchEdit(sku, { sale_action: "clear", sale_price: undefined, sale_start_at: undefined, sale_end_at: undefined });
  }

  function discardSaleEdit(sku: string) {
    setEdits(prev => {
      const cur = prev[sku];
      if (!cur) return prev;
      const next: Edit = { price: cur.price, business_price: cur.business_price };
      if (next.price == null && next.business_price == null) {
        const out = { ...prev };
        delete out[sku];
        return out;
      }
      return { ...prev, [sku]: next };
    });
  }

  function applyBulkIncrease() {
    const newEdits: Record<string, Edit> = {};
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

    // Build update payload — every row with any edit must include the resolved price
    // since the API replaces the entire purchasable_offer entry.
    const updates = Object.entries(edits).map(([sku, edit]) => {
      const asin = asins.find(a => a.sku === sku);
      const resolvedPrice = edit.price ?? asin?.current_price ?? 0;
      const u: {
        sku: string;
        price: number;
        business_price?: number;
        sale_price?: number | null;
        sale_start_at?: string | null;
        sale_end_at?: string | null;
      } = { sku, price: resolvedPrice, business_price: edit.business_price };

      if (edit.sale_action === "set") {
        u.sale_price = edit.sale_price ?? null;
        u.sale_start_at = edit.sale_start_at ?? null;
        u.sale_end_at = edit.sale_end_at ?? null;
      } else if (edit.sale_action === "clear") {
        u.sale_price = null;
        u.sale_start_at = null;
        u.sale_end_at = null;
      } else if (asin?.sale_price != null) {
        // Sale unchanged — preserve it
        u.sale_price = asin.sale_price;
        u.sale_start_at = asin.sale_start_at;
        u.sale_end_at = asin.sale_end_at;
      }
      return u;
    }).filter(u => u.price > 0);

    // Frontend-side validation
    for (const u of updates) {
      if (u.business_price && u.business_price < u.price) {
        setMessage(`Error: Business price for ${u.sku} ($${u.business_price}) cannot be lower than standard price ($${u.price})`);
        setSaving(false);
        return;
      }
      if (u.sale_price != null) {
        if (u.sale_price >= u.price) {
          setMessage(`Error: Sale price for ${u.sku} ($${u.sale_price}) must be lower than the regular price ($${u.price})`);
          setSaving(false);
          return;
        }
        if (!u.sale_start_at || !u.sale_end_at) {
          setMessage(`Error: Sale price for ${u.sku} requires both start and end dates`);
          setSaving(false);
          return;
        }
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
      setMessage(`${successes} listing(s) updated. Amazon takes ~30s to reflect changes.`);
      setEdits({});
      setExpanded({});
      // Reload after a short delay so Amazon has time to propagate
      await new Promise(r => setTimeout(r, 1500));
      const reload = await fetch(`/api/workspaces/${workspace.id}/amazon/pricing`);
      const d = await reload.json();
      setAsins(d.asins || []);
    }
    setSaving(false);
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Amazon Pricing</h1>
          <p className="mt-1 text-sm text-zinc-500">List price (MSRP) auto-matches the selling price on save. Sale prices clear automatically when not actively set.</p>
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
          <button onClick={() => { setEdits({}); setExpanded({}); }}
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
                <th className="px-4 py-2">SKU</th>
                <th className="px-4 py-2 text-right">List</th>
                <th className="px-4 py-2 text-right">Current</th>
                <th className="px-4 py-2 text-right">New Price</th>
                <th className="px-4 py-2">Sale</th>
                <th className="px-4 py-2 text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              {asins.map(a => {
                const edit = edits[a.sku];
                const newPrice = edit?.price ?? a.current_price;
                const priceDiff = (newPrice ?? 0) - (a.current_price ?? 0);
                const hasChange = !!edit;
                const isExpanded = !!expanded[a.sku];
                const saleSummary = a.sale_price != null
                  ? `${fmt(a.sale_price)} (${fmtDate(a.sale_start_at)}–${fmtDate(a.sale_end_at)})`
                  : "—";
                const saleEdit = edit?.sale_action;

                return (
                  <React.Fragment key={a.id}>
                    <tr className={`border-b border-zinc-50 dark:border-zinc-800/50 ${hasChange ? "bg-amber-50/50 dark:bg-amber-950/10" : ""}`}>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {a.image_url && <img src={a.image_url} alt="" className="h-8 w-8 rounded object-cover" />}
                          <div className="min-w-0">
                            <div className="text-zinc-700 dark:text-zinc-300 max-w-[220px] truncate" title={a.title}>{a.title}</div>
                            <div className="text-[10px] text-zinc-400 font-mono">{a.asin}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-zinc-500 text-xs font-mono">{a.sku}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-zinc-500">
                        <span className={a.list_price != null && a.current_price != null && Math.abs(a.list_price - a.current_price) >= 0.005 ? "text-amber-600 dark:text-amber-400" : ""} title={a.list_price != null && a.current_price != null && Math.abs(a.list_price - a.current_price) >= 0.005 ? "List price differs from current price" : undefined}>
                          {fmt(a.list_price)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                        {fmt(a.current_price)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={edit?.price ?? a.current_price ?? ""}
                          onChange={(e) => setEditPrice(a.sku, e.target.value)}
                          className={`w-24 rounded border px-2 py-1 text-right text-sm tabular-nums ${edit?.price != null ? "border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/30" : "border-zinc-200 dark:border-zinc-700 dark:bg-zinc-800"} dark:text-zinc-100`}
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => setExpanded(prev => ({ ...prev, [a.sku]: !prev[a.sku] }))}
                          className={`text-left text-xs ${saleEdit === "set" ? "text-amber-600 dark:text-amber-400" : saleEdit === "clear" ? "text-red-600 dark:text-red-400" : a.sale_price != null ? "text-zinc-700 dark:text-zinc-300" : "text-zinc-400"} hover:underline`}
                        >
                          {saleEdit === "set" && (edit?.sale_price != null ? `→ ${fmt(edit.sale_price)}` : "→ (incomplete)")}
                          {saleEdit === "clear" && "→ clear"}
                          {!saleEdit && saleSummary}
                          <svg className={`ml-1 inline h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {hasChange && (priceDiff !== 0 || saleEdit) ? (
                          <div className="flex items-center justify-end gap-2">
                            {priceDiff !== 0 && (
                              <span className={priceDiff > 0 ? "text-emerald-600" : "text-red-600"}>
                                {priceDiff > 0 ? "+" : ""}{fmt(priceDiff)}
                              </span>
                            )}
                            <button onClick={() => clearEdit(a.sku)} className="text-zinc-400 hover:text-zinc-600" title="Reset row">
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        ) : hasChange ? (
                          <button onClick={() => clearEdit(a.sku)} className="text-zinc-400 hover:text-zinc-600" title="Reset row">
                            <svg className="h-3.5 w-3.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-zinc-100 bg-zinc-50/50 dark:border-zinc-800/50 dark:bg-zinc-800/20">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="flex flex-wrap items-end gap-3">
                            <div>
                              <label className="block text-[10px] uppercase tracking-wider text-zinc-400 mb-1">Sale price</label>
                              <input
                                type="number"
                                step="0.01"
                                placeholder="—"
                                value={saleEdit === "set" ? (edit?.sale_price ?? "") : (a.sale_price ?? "")}
                                onChange={(e) => setSaleEdit(a.sku, { sale_price: e.target.value })}
                                disabled={saleEdit === "clear"}
                                className="w-28 rounded border border-zinc-200 px-2 py-1 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 disabled:opacity-40"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] uppercase tracking-wider text-zinc-400 mb-1">Start</label>
                              <input
                                type="datetime-local"
                                value={saleEdit === "set" ? isoToLocal(edit?.sale_start_at) : isoToLocal(a.sale_start_at)}
                                onChange={(e) => setSaleEdit(a.sku, { sale_start_at: e.target.value })}
                                disabled={saleEdit === "clear"}
                                className="rounded border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 disabled:opacity-40"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] uppercase tracking-wider text-zinc-400 mb-1">End</label>
                              <input
                                type="datetime-local"
                                value={saleEdit === "set" ? isoToLocal(edit?.sale_end_at) : isoToLocal(a.sale_end_at)}
                                onChange={(e) => setSaleEdit(a.sku, { sale_end_at: e.target.value })}
                                disabled={saleEdit === "clear"}
                                className="rounded border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 disabled:opacity-40"
                              />
                            </div>
                            <div className="ml-auto flex gap-2">
                              {a.sale_price != null && saleEdit !== "clear" && (
                                <button
                                  type="button"
                                  onClick={() => markSaleClear(a.sku)}
                                  className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-950/50"
                                >
                                  Clear sale
                                </button>
                              )}
                              {saleEdit && (
                                <button
                                  type="button"
                                  onClick={() => discardSaleEdit(a.sku)}
                                  className="rounded border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                >
                                  Discard sale change
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
