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

interface ErrorCode {
  id: string;
  error_code: string;
  error_message: string | null;
  is_terminal: boolean;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export default function DunningSettingsPage() {
  const workspace = useWorkspace();
  const [settings, setSettings] = useState<DunningSettings | null>(null);
  const [errorCodes, setErrorCodes] = useState<ErrorCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [settingsRes, codesRes] = await Promise.all([
        fetch(`/api/workspaces/${workspace.id}/dunning`),
        fetch(`/api/workspaces/${workspace.id}/dunning/error-codes`),
      ]);
      if (cancelled) return;
      if (settingsRes.ok) setSettings(await settingsRes.json());
      if (codesRes.ok) setErrorCodes(await codesRes.json());
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspace.id]);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setSaved(false);

    // Save settings + error code changes in parallel
    const promises: Promise<unknown>[] = [
      fetch(`/api/workspaces/${workspace.id}/dunning`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      }).then(async (res) => {
        if (res.ok) setSettings(await res.json());
      }),
    ];

    // Save error code terminal toggles if changed
    const updates = Object.entries(pendingChanges).map(([id, is_terminal]) => ({ id, is_terminal }));
    if (updates.length > 0) {
      promises.push(
        fetch(`/api/workspaces/${workspace.id}/dunning/error-codes`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates }),
        }).then(async (res) => {
          if (res.ok) {
            setErrorCodes(await res.json());
            setPendingChanges({});
          }
        }),
      );
    }

    await Promise.all(promises);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setSaving(false);
  };

  const toggleTerminal = (code: ErrorCode) => {
    const newVal = !((pendingChanges[code.id] !== undefined) ? pendingChanges[code.id] : code.is_terminal);
    setPendingChanges({ ...pendingChanges, [code.id]: newVal });
  };

  const isTerminal = (code: ErrorCode) =>
    pendingChanges[code.id] !== undefined ? pendingChanges[code.id] : code.is_terminal;

  if (loading || !settings) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading dunning settings...</p>
      </div>
    );
  }

  const terminalCount = errorCodes.filter(c => isTerminal(c)).length;
  const retryableCount = errorCodes.filter(c => !isTerminal(c)).length;

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
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

        {/* Error codes */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Billing Error Codes</h3>
          <p className="mb-4 text-xs text-zinc-400">
            Error codes from payment processors. Terminal errors skip card rotation and immediately cancel the subscription (customer can recover by adding a new payment method).
            New error codes appear here automatically.
          </p>
          <div className="mb-3 flex gap-3 text-xs">
            <span className="rounded-full bg-red-100 px-2.5 py-0.5 font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
              {terminalCount} terminal
            </span>
            <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              {retryableCount} retryable
            </span>
          </div>
          {errorCodes.length === 0 ? (
            <p className="text-xs text-zinc-400">No error codes recorded yet. They will appear here once billing failures occur.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                    <th className="pb-2 pr-3">Error Code</th>
                    <th className="pb-2 pr-3">Message</th>
                    <th className="pb-2 pr-3 text-right">Count</th>
                    <th className="pb-2 pr-3">Last Seen</th>
                    <th className="pb-2 text-center">Terminal</th>
                  </tr>
                </thead>
                <tbody>
                  {errorCodes.map((code) => {
                    const terminal = isTerminal(code);
                    const changed = pendingChanges[code.id] !== undefined;
                    return (
                      <tr key={code.id} className={`border-b border-zinc-50 dark:border-zinc-800/50 ${changed ? "bg-amber-50/50 dark:bg-amber-900/10" : ""}`}>
                        <td className="py-2 pr-3">
                          <code className={`rounded px-1.5 py-0.5 text-xs font-mono ${
                            terminal
                              ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                          }`}>
                            {code.error_code}
                          </code>
                        </td>
                        <td className="py-2 pr-3 text-xs text-zinc-500 max-w-[200px] truncate" title={code.error_message || ""}>
                          {code.error_message || "—"}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-xs text-zinc-500">
                          {code.occurrence_count.toLocaleString()}
                        </td>
                        <td className="py-2 pr-3 text-xs text-zinc-400">
                          {new Date(code.last_seen_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </td>
                        <td className="py-2 text-center">
                          <button
                            onClick={() => toggleTerminal(code)}
                            className={`relative h-4 w-7 rounded-full transition-colors ${
                              terminal ? "bg-red-500" : "bg-zinc-300 dark:bg-zinc-600"
                            }`}
                          >
                            <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform shadow-sm ${
                              terminal ? "left-[14px]" : "left-0.5"
                            }`} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* How it works */}
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-5 dark:border-zinc-700 dark:bg-zinc-900/50">
          <h3 className="mb-2 text-sm font-semibold text-zinc-600 dark:text-zinc-400">How it works</h3>
          <div className="space-y-2 text-xs text-zinc-500">
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              <p><span className="font-medium">Payment fails:</span> System checks if error is terminal. If terminal, skips card rotation and cancels immediately.</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              <p><span className="font-medium">Retryable error:</span> System rotates through stored payment methods (2h between each)</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              <p><span className="font-medium">All cards fail:</span> Order is skipped/paused, payment update email sent, payday retries scheduled</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              <p><span className="font-medium">Customer adds new card:</span> Subscription automatically reactivated and billed immediately</p>
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
          {Object.keys(pendingChanges).length > 0 && !saved && (
            <span className="text-xs text-amber-600">Unsaved error code changes</span>
          )}
        </div>
      </div>
    </div>
  );
}
