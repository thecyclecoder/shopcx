"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface FraudRule {
  id: string;
  rule_type: string;
  name: string;
  description: string | null;
  is_active: boolean;
  config: Record<string, unknown>;
  severity: string;
  is_seeded: boolean;
  updated_at: string;
}

const SEVERITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const FUTURE_RULES = [
  { name: "Large single order threshold", description: "Flag orders above a dollar amount threshold." },
  { name: "Multiple failed payment attempts", description: "Detect customers with repeated payment failures." },
  { name: "Rapid account creation from same IP range", description: "Identify coordinated account creation patterns." },
  { name: "Multiple refund requests", description: "Flag customers requesting frequent refunds." },
];

export default function FraudSettingsPage() {
  const workspace = useWorkspace();
  const [rules, setRules] = useState<FraudRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/workspaces/${workspace.id}/fraud-rules`);
      if (cancelled) return;
      if (res.ok) {
        const data = await res.json();
        setRules(data.rules || []);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspace.id]);

  const reloadRules = async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/fraud-rules`);
    if (res.ok) {
      const data = await res.json();
      setRules(data.rules || []);
    }
  };

  const updateRule = async (ruleId: string, updates: Record<string, unknown>) => {
    setSavingId(ruleId);
    await fetch(`/api/workspaces/${workspace.id}/fraud-rules/${ruleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    await reloadRules();
    setSavingId(null);
  };

  const updateConfig = (rule: FraudRule, key: string, value: unknown) => {
    setRules((prev) =>
      prev.map((r) =>
        r.id === rule.id ? { ...r, config: { ...r.config, [key]: value } } : r
      )
    );
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading fraud rules...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Fraud Detection Rules</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Configure thresholds and behavior for fraud pattern detection. Changes trigger a re-scan within 5 minutes.
        </p>
      </div>

      <div className="space-y-6">
        {rules.map((rule) => (
          <div key={rule.id} className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            {/* Rule header */}
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => updateRule(rule.id, { is_active: !rule.is_active })}
                  className={`relative h-5 w-9 rounded-full transition-colors ${
                    rule.is_active ? "bg-indigo-500" : "bg-zinc-300 dark:bg-zinc-600"
                  }`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${
                    rule.is_active ? "left-[18px]" : "left-0.5"
                  }`} />
                </button>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{rule.name}</h3>
                  <p className="text-xs text-zinc-400">{rule.description}</p>
                </div>
              </div>
              {rule.is_seeded && (
                <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-400 dark:bg-zinc-800">Default</span>
              )}
            </div>

            {/* Rule config */}
            <div className="space-y-4 p-5">
              {/* Name */}
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-500">Rule Name</label>
                <input
                  type="text"
                  value={rule.name}
                  onChange={(e) => setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, name: e.target.value } : r))}
                  className="w-full max-w-md rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                />
              </div>

              {/* Severity */}
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-500">Severity</label>
                <select
                  value={rule.severity}
                  onChange={(e) => setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, severity: e.target.value } : r))}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  {SEVERITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {/* Shared Address config */}
              {rule.rule_type === "shared_address" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ConfigNumber label="Minimum distinct customer accounts" value={rule.config.min_customers as number} onChange={(v) => updateConfig(rule, "min_customers", v)} />
                  <ConfigNumber label="Minimum total orders across accounts" value={rule.config.min_orders_total as number} onChange={(v) => updateConfig(rule, "min_orders_total", v)} />
                  <ConfigToggle label="Suppress if all customers share last name" value={rule.config.ignore_same_last_name as boolean} onChange={(v) => updateConfig(rule, "ignore_same_last_name", v)} />
                  <ConfigNumber label="Lookback period (days)" value={rule.config.lookback_days as number} onChange={(v) => updateConfig(rule, "lookback_days", v)} />
                </div>
              )}

              {/* High Velocity config */}
              {rule.rule_type === "high_velocity" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ConfigNumber label="Minimum items per order to qualify" value={rule.config.min_quantity_per_order as number} onChange={(v) => updateConfig(rule, "min_quantity_per_order", v)} />
                  <ConfigNumber label="Minimum qualifying orders in window" value={rule.config.min_qualifying_orders as number} onChange={(v) => updateConfig(rule, "min_qualifying_orders", v)} />
                  <ConfigNumber label="Rolling window (days)" value={rule.config.window_days as number} onChange={(v) => updateConfig(rule, "window_days", v)} />
                  <ConfigNumber label="Lookback period (days)" value={rule.config.lookback_days as number} onChange={(v) => updateConfig(rule, "lookback_days", v)} />
                </div>
              )}

              {/* Address Distance config */}
              {rule.rule_type === "address_distance" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ConfigNumber label="Distance threshold (miles)" value={rule.config.distance_threshold_miles as number} onChange={(v) => updateConfig(rule, "distance_threshold_miles", v)} />
                </div>
              )}

              {/* Name Mismatch config */}
              {rule.rule_type === "name_mismatch" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ConfigToggle label="Ignore if last names match (spouse/family)" value={rule.config.ignore_last_name_match as boolean} onChange={(v) => updateConfig(rule, "ignore_last_name_match", v)} />
                </div>
              )}

              {/* Save button */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={() => updateRule(rule.id, { name: rule.name, config: rule.config, severity: rule.severity })}
                  disabled={savingId === rule.id}
                  className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
                >
                  {savingId === rule.id ? "Saving..." : "Save Changes"}
                </button>
                <span className="text-xs text-zinc-400">
                  Last updated: {new Date(rule.updated_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          </div>
        ))}

        {/* Future rules placeholder */}
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-6 dark:border-zinc-700 dark:bg-zinc-900/50">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <h3 className="text-sm font-semibold text-zinc-600 dark:text-zinc-400">Add Custom Rule</h3>
          </div>
          <p className="mb-3 mt-1 text-xs text-zinc-400">Additional rule types coming soon:</p>
          <div className="space-y-2">
            {FUTURE_RULES.map((r) => (
              <div key={r.name} className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                <div>
                  <p className="text-sm text-zinc-500">{r.name}</p>
                  <p className="text-xs text-zinc-400">{r.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Config field components ──

function ConfigNumber({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-zinc-500">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value) || 0)}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
      />
    </div>
  );
}

function ConfigToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => onChange(!value)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          value ? "bg-indigo-500" : "bg-zinc-300 dark:bg-zinc-600"
        }`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${
          value ? "left-[18px]" : "left-0.5"
        }`} />
      </button>
      <label className="text-xs font-medium text-zinc-500">{label}</label>
    </div>
  );
}
