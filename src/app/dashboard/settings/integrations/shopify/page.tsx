"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface SourceRow {
  source: string;
  friendly_name: string | null;
  count: number;
  order_type: string;
}

export default function ShopifySettingsPage() {
  const workspace = useWorkspace();

  if (!["owner", "admin"].includes(workspace.role)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-sm text-zinc-400">You don&apos;t have permission to view this page.</p>
      </div>
    );
  }

  const [sources, setSources] = useState<SourceRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [replacementThreshold, setReplacementThreshold] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const hasReplacementMapping = Object.values(mapping).includes("replacement");

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/order-sources`)
      .then((res) => res.json())
      .then((data) => {
        setSources(data.sources || []);
        setMapping(data.mapping || {});
        setReplacementThreshold(data.replacement_threshold_cents ?? 0);
        setLoading(false);
      });
  }, [workspace.id]);

  const handleTypeChange = (source: string, orderType: string) => {
    setMapping((prev) => ({ ...prev, [source]: orderType }));
    setSources((prev) =>
      prev.map((s) => (s.source === source ? { ...s, order_type: orderType } : s))
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage("");

    const res = await fetch(`/api/workspaces/${workspace.id}/order-sources`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mapping, replacement_threshold_cents: replacementThreshold }),
    });

    if (res.ok) {
      const data = await res.json();
      setMessage(`Mapping saved. ${data.updated} orders updated.`);
    } else {
      setMessage("Failed to save mapping");
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Shopify Settings
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          Map order sources to classify orders as one-time checkout or recurring subscription.
        </p>
      </div>

      {message && (
        <div className="mb-6 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300">
          {message}
        </div>
      )}

      <div className="max-w-2xl">
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Order Source Mapping
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Each order from Shopify has a source. Map each source to either &quot;Checkout&quot; (one-time) or &quot;Recurring&quot; (subscription).
            </p>
          </div>

          {sources.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-zinc-400">
              No order sources found. Sync orders first.
            </div>
          ) : (
            <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {sources.map((s) => (
                <div
                  key={s.source}
                  className="flex items-center justify-between px-5 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {s.friendly_name || s.source}
                    </p>
                    <p className="text-xs text-zinc-400">
                      {s.friendly_name && s.friendly_name !== s.source && (
                        <span className="font-mono">{s.source}</span>
                      )}
                      {s.friendly_name && s.friendly_name !== s.source && " · "}
                      {s.count.toLocaleString()} order{s.count !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <select
                    value={s.order_type}
                    onChange={(e) => handleTypeChange(s.source, e.target.value)}
                    className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                      s.order_type === "recurring"
                        ? "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-400"
                        : s.order_type === "checkout"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                          : s.order_type === "replacement"
                            ? "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-700 dark:bg-orange-950 dark:text-orange-400"
                            : "border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}
                  >
                    <option value="unknown">Unmapped</option>
                    <option value="checkout">Checkout</option>
                    <option value="recurring">Recurring</option>
                    <option value="replacement">Replacement</option>
                  </select>
                </div>
              ))}
            </div>
          )}

          {/* Replacement threshold */}
          {hasReplacementMapping && (
            <div className="border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <div className="rounded-md border border-orange-200 bg-orange-50 p-3 dark:border-orange-800 dark:bg-orange-950">
                <p className="text-xs font-medium text-orange-700 dark:text-orange-400">Replacement Order Threshold</p>
                <p className="mt-1 text-[10px] text-orange-600 dark:text-orange-500">
                  Orders from sources mapped as &quot;Replacement&quot; will only be tagged as replacement if the order value is at or below this amount. Orders above this threshold will be tagged as &quot;Checkout&quot;.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-sm text-orange-700 dark:text-orange-400">$</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={replacementThreshold / 100}
                    onChange={(e) => setReplacementThreshold(Math.round(parseFloat(e.target.value || "0") * 100))}
                    className="w-24 rounded-md border border-orange-300 bg-white px-2 py-1 text-sm text-zinc-900 focus:border-orange-500 focus:outline-none dark:border-orange-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </div>
              </div>
            </div>
          )}

          {sources.length > 0 && (
            <div className="border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <button
                onClick={handleSave}
                disabled={saving}
                className="cursor-pointer rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save & Apply to All Orders"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
