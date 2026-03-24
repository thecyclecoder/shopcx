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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/order-sources`)
      .then((res) => res.json())
      .then((data) => {
        setSources(data.sources || []);
        setMapping(data.mapping || {});
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
      body: JSON.stringify({ mapping }),
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
                          : "border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}
                  >
                    <option value="unknown">Unmapped</option>
                    <option value="checkout">Checkout</option>
                    <option value="recurring">Recurring</option>
                  </select>
                </div>
              ))}
            </div>
          )}

          {sources.length > 0 && (
            <div className="border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
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
