"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface DunningSettings {
  dunning_enabled: boolean;
  dunning_max_card_rotations: number;
  dunning_payday_retry_enabled: boolean;
  dunning_cycle_1_action: string;
  dunning_cycle_2_action: string;
}

export default function DunningSettingsPage() {
  const workspace = useWorkspace();
  const [settings, setSettings] = useState<DunningSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/workspaces/${workspace.id}/dunning`);
      if (cancelled) return;
      if (res.ok) {
        setSettings(await res.json());
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspace.id]);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    const res = await fetch(`/api/workspaces/${workspace.id}/dunning`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (res.ok) {
      setSettings(await res.json());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  };

  if (loading || !settings) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading dunning settings...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Recovery</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Intelligent payment failure recovery. Rotates stored payment methods, retries on paydays, and recovers subscriptions when customers add new cards.
        </p>
      </div>

      <div className="space-y-6">
        {/* Master toggle */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Enable Dunning</h3>
              <p className="mt-0.5 text-xs text-zinc-400">
                When enabled, payment failures will automatically trigger card rotation and payday-aware retries.
              </p>
            </div>
            <button
              onClick={() => setSettings({ ...settings, dunning_enabled: !settings.dunning_enabled })}
              className={`relative h-5 w-9 rounded-full transition-colors ${
                settings.dunning_enabled ? "bg-indigo-500" : "bg-zinc-300 dark:bg-zinc-600"
              }`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${
                settings.dunning_enabled ? "left-[18px]" : "left-0.5"
              }`} />
            </button>
          </div>
        </div>

        {/* Card rotation */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Card Rotation</h3>
          <p className="mb-4 text-xs text-zinc-400">
            When a payment fails, the system tries other stored payment methods before giving up. Cards are tried with a 2-hour delay between each attempt.
          </p>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Max card rotation attempts</label>
            <input
              type="number"
              min={1}
              max={10}
              value={settings.dunning_max_card_rotations}
              onChange={(e) => setSettings({ ...settings, dunning_max_card_rotations: parseInt(e.target.value) || 6 })}
              className="w-32 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            />
            <p className="mt-1 text-xs text-zinc-400">Includes the initial failed card. Default: 6</p>
          </div>
        </div>

        {/* Payday retries */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Payday-Aware Retries</h3>
              <p className="mt-0.5 text-xs text-zinc-400">
                After all cards are exhausted, retry on common payday dates (1st, 15th, Fridays) when customers are most likely to have funds available.
              </p>
            </div>
            <button
              onClick={() => setSettings({ ...settings, dunning_payday_retry_enabled: !settings.dunning_payday_retry_enabled })}
              className={`relative h-5 w-9 rounded-full transition-colors ${
                settings.dunning_payday_retry_enabled ? "bg-indigo-500" : "bg-zinc-300 dark:bg-zinc-600"
              }`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${
                settings.dunning_payday_retry_enabled ? "left-[18px]" : "left-0.5"
              }`} />
            </button>
          </div>
          <div className="mt-4 rounded-md bg-zinc-50 p-3 dark:bg-zinc-800/50">
            <p className="text-xs text-zinc-500">
              <span className="font-medium">Retry schedule:</span> 1st of month, 15th of month, Fridays, last business day of month. Retries at 7 AM US Central time.
            </p>
          </div>
        </div>

        {/* Cycle actions */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Failure Actions</h3>
          <p className="mb-4 text-xs text-zinc-400">
            What happens when all payment methods and retries are exhausted for a billing cycle.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">First cycle failure</label>
              <select
                value={settings.dunning_cycle_1_action}
                onChange={(e) => setSettings({ ...settings, dunning_cycle_1_action: e.target.value })}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              >
                <option value="skip">Skip order</option>
                <option value="pause">Pause subscription</option>
              </select>
              <p className="mt-1 text-xs text-zinc-400">Recommended: Skip — gives customer time to update card</p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Second cycle failure</label>
              <select
                value={settings.dunning_cycle_2_action}
                onChange={(e) => setSettings({ ...settings, dunning_cycle_2_action: e.target.value })}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              >
                <option value="skip">Skip order</option>
                <option value="pause">Pause subscription</option>
              </select>
              <p className="mt-1 text-xs text-zinc-400">Recommended: Pause — creates ticket for agent follow-up</p>
            </div>
          </div>
        </div>

        {/* How it works */}
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-5 dark:border-zinc-700 dark:bg-zinc-900/50">
          <h3 className="mb-2 text-sm font-semibold text-zinc-600 dark:text-zinc-400">How it works</h3>
          <div className="space-y-2 text-xs text-zinc-500">
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              <p><span className="font-medium">Payment fails:</span> System immediately rotates through stored payment methods (2h between each)</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              <p><span className="font-medium">All cards fail:</span> Order is skipped/paused, payment update email sent, payday retries scheduled</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              <p><span className="font-medium">Customer adds new card:</span> Order automatically unskipped and billed immediately</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              <p><span className="font-medium">Second cycle fails:</span> Subscription paused, ticket created for agent follow-up</p>
            </div>
          </div>
        </div>

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
          {saved && <span className="text-sm text-green-600">Saved</span>}
        </div>
      </div>
    </div>
  );
}
