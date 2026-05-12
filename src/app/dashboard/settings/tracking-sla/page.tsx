"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

export default function TrackingSlaPage() {
  const workspace = useWorkspace();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [slaDays, setSlaDays] = useState(1);
  const [cutoffHour, setCutoffHour] = useState(11);
  const [cutoffTimezone, setCutoffTimezone] = useState("America/Chicago");
  const [shippingDays, setShippingDays] = useState<number[]>([1, 2, 3, 4, 5]);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/integrations`);
      if (res.ok) {
        const data = await res.json();
        if (data.amplifier_tracking_sla_days) setSlaDays(data.amplifier_tracking_sla_days);
        if (data.amplifier_cutoff_hour != null) setCutoffHour(data.amplifier_cutoff_hour);
        if (data.amplifier_cutoff_timezone) setCutoffTimezone(data.amplifier_cutoff_timezone);
        if (data.amplifier_shipping_days) setShippingDays(data.amplifier_shipping_days);
      }
    } catch {}
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amplifier_tracking_sla_days: slaDays,
        amplifier_cutoff_hour: cutoffHour,
        amplifier_cutoff_timezone: cutoffTimezone,
        amplifier_shipping_days: shippingDays,
      }),
    });
    if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); }
    setSaving(false);
  };

  if (loading) {
    return <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6"><p className="text-sm text-zinc-400">Loading...</p></div>;
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Tracking SLA</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Define when orders are considered late for tracking. Used by the Orders page to flag late shipments.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 space-y-5">
        {/* Expected tracking days */}
        <div className="flex items-center gap-3">
          <label className="w-44 text-sm font-medium text-zinc-700 dark:text-zinc-300">Expected tracking</label>
          <input
            type="number" min="1" max="14" value={slaDays}
            onChange={e => setSlaDays(parseInt(e.target.value) || 1)}
            className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <span className="text-sm text-zinc-500">business day(s) after received</span>
        </div>

        {/* Cutoff time */}
        <div className="flex items-center gap-3">
          <label className="w-44 text-sm font-medium text-zinc-700 dark:text-zinc-300">Daily cutoff time</label>
          <select value={cutoffHour} onChange={e => setCutoffHour(parseInt(e.target.value))}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i}>
                {i === 0 ? "12:00 AM" : i < 12 ? `${i}:00 AM` : i === 12 ? "12:00 PM" : `${i - 12}:00 PM`}
              </option>
            ))}
          </select>
          <select value={cutoffTimezone} onChange={e => setCutoffTimezone(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
            <option value="America/New_York">Eastern</option>
            <option value="America/Chicago">Central</option>
            <option value="America/Denver">Mountain</option>
            <option value="America/Los_Angeles">Pacific</option>
          </select>
        </div>

        {/* Shipping days */}
        <div>
          <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Shipping days</label>
          <p className="mb-2 text-xs text-zinc-400">Orders received after cutoff or on non-shipping days start the SLA on the next shipping day.</p>
          <div className="flex flex-wrap gap-2">
            {[
              { day: 1, label: "Mon" }, { day: 2, label: "Tue" }, { day: 3, label: "Wed" },
              { day: 4, label: "Thu" }, { day: 5, label: "Fri" }, { day: 6, label: "Sat" }, { day: 7, label: "Sun" },
            ].map(({ day, label }) => (
              <button key={day} type="button"
                onClick={() => setShippingDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort())}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  shippingDays.includes(day)
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950 dark:text-indigo-300"
                    : "border-zinc-300 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <button type="button" disabled={saving} onClick={save}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {saving ? "Saving..." : "Save"}
          </button>
          {saved && <span className="text-sm text-emerald-600">Saved</span>}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-5 dark:border-zinc-700 dark:bg-zinc-900/50">
        <h3 className="mb-2 text-sm font-semibold text-zinc-600 dark:text-zinc-400">How it works</h3>
        <div className="space-y-2 text-xs text-zinc-500">
          <p>Orders received by Amplifier before the cutoff time start the SLA clock that same day. Orders received after cutoff start the next shipping day.</p>
          <p>An order is considered &quot;late&quot; if it hasn&apos;t shipped within the configured number of business days (shipping days only).</p>
          <p>Late orders appear in the Orders &gt; Late Tracking tab with an alert badge.</p>
        </div>
      </div>
    </div>
  );
}
