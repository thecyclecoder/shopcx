"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Frequency {
  value: number;
  unit: "weeks" | "months";
}

export default function SubscriptionSettingsPage() {
  const workspace = useWorkspace();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [discountPct, setDiscountPct] = useState(25);
  const [frequencies, setFrequencies] = useState<Frequency[]>([]);
  const [freeShipping, setFreeShipping] = useState(false);
  const [freeShipThreshold, setFreeShipThreshold] = useState("");
  const [giftTitle, setGiftTitle] = useState("");

  const [newFreqValue, setNewFreqValue] = useState("");
  const [newFreqUnit, setNewFreqUnit] = useState<"weeks" | "months">("months");

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/subscription-settings`);
    if (res.ok) {
      const data = await res.json();
      setDiscountPct(data.discount_pct ?? 25);
      setFrequencies(data.frequencies || []);
      setFreeShipping(data.free_shipping ?? false);
      setFreeShipThreshold(data.free_shipping_threshold_cents ? (data.free_shipping_threshold_cents / 100).toString() : "");
      setGiftTitle(data.free_gift_product_title || "");
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { load(); }, [load]);

  const addFrequency = () => {
    if (!newFreqValue) return;
    const freq: Frequency = { value: parseInt(newFreqValue), unit: newFreqUnit };
    if (freq.value <= 0) return;
    if (frequencies.some(f => f.value === freq.value && f.unit === freq.unit)) return;
    setFrequencies([...frequencies, freq].sort((a, b) => {
      const aDays = a.unit === "weeks" ? a.value * 7 : a.value * 30;
      const bDays = b.unit === "weeks" ? b.value * 7 : b.value * 30;
      return aDays - bDays;
    }));
    setNewFreqValue("");
  };

  const save = async () => {
    setSaving(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/subscription-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        discount_pct: discountPct,
        frequencies,
        free_shipping: freeShipping,
        free_shipping_threshold_cents: freeShipThreshold ? Math.round(parseFloat(freeShipThreshold) * 100) : null,
        free_gift_product_title: giftTitle || null,
      }),
    });
    setSaving(false);
    if (res.ok) {
      setMessage("Saved");
      setTimeout(() => setMessage(null), 2000);
    }
  };

  if (loading) return <div className="mx-auto max-w-5xl px-4 py-6"><p className="text-sm text-zinc-400">Loading...</p></div>;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Subscription Settings</h1>
      <p className="mb-6 text-sm text-zinc-500">Configure subscribe & save discount, delivery frequencies, and subscription perks.</p>

      <div className="space-y-6">
        {/* Discount */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Subscribe & Save Discount</h2>
          <div className="flex items-center gap-3">
            <input type="number" value={discountPct} onChange={e => setDiscountPct(Number(e.target.value))}
              min={0} max={100}
              className="w-20 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
            <span className="text-sm text-zinc-500">% off MSRP for subscribers</span>
          </div>
          <p className="mt-2 text-xs text-zinc-400">This discount is applied on top of any quantity discounts from pricing rules.</p>
        </div>

        {/* Frequencies */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Delivery Frequencies</h2>
          <p className="mb-3 text-xs text-zinc-500">Available subscription intervals customers can choose from at checkout.</p>

          <div className="mb-3 flex flex-wrap gap-2">
            {frequencies.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-full bg-indigo-100 px-3 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">
                Every {f.value} {f.unit}
                <button onClick={() => setFrequencies(frequencies.filter((_, j) => j !== i))} className="text-indigo-400 hover:text-red-500">×</button>
              </span>
            ))}
            {frequencies.length === 0 && <span className="text-xs text-zinc-400">No frequencies configured yet</span>}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Every</span>
            <input type="number" value={newFreqValue} onChange={e => setNewFreqValue(e.target.value)}
              min={1} placeholder="4"
              className="w-16 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" />
            <select value={newFreqUnit} onChange={e => setNewFreqUnit(e.target.value as "weeks" | "months")}
              className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </select>
            <button onClick={addFrequency}
              className="rounded bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400">
              Add
            </button>
          </div>
        </div>

        {/* Shipping */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Subscription Shipping</h2>
          <label className="mb-3 flex items-center gap-2">
            <input type="checkbox" checked={freeShipping} onChange={e => setFreeShipping(e.target.checked)}
              className="rounded border-zinc-300 text-indigo-500" />
            <span className="text-sm text-zinc-700 dark:text-zinc-300">Free shipping on all subscriptions</span>
          </label>
          {!freeShipping && (
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">Or free shipping on subscriptions above ($)</span>
              <input type="number" value={freeShipThreshold} onChange={e => setFreeShipThreshold(e.target.value)}
                placeholder="e.g. 50.00"
                className="w-40 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" />
            </label>
          )}
        </div>

        {/* Free Gift */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Free Gift with Subscription</h2>
          <p className="mb-3 text-xs text-zinc-500">Optionally include a free product with every new subscription order.</p>
          <input value={giftTitle} onChange={e => setGiftTitle(e.target.value)}
            placeholder="Product name (leave blank for none)"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
        </div>

        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving}
            className="rounded-md bg-indigo-500 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
            {saving ? "Saving..." : "Save Settings"}
          </button>
          {message && <span className="text-sm text-green-600">{message}</span>}
        </div>
      </div>
    </div>
  );
}
