"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface RedemptionTier {
  label: string;
  points_cost: number;
  discount_value: number;
}

interface LoyaltySettings {
  enabled: boolean;
  points_per_dollar: number;
  points_per_dollar_value: number;
  redemption_tiers: RedemptionTier[];
  coupon_applies_to: string;
  coupon_combines_product: boolean;
  coupon_combines_shipping: boolean;
  coupon_combines_order: boolean;
  coupon_expiry_days: number;
  exclude_tax: boolean;
  exclude_discounts: boolean;
  exclude_shipping: boolean;
  exclude_shipping_protection: boolean;
}

export default function LoyaltySettingsPage() {
  const workspace = useWorkspace();
  const [settings, setSettings] = useState<LoyaltySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/workspaces/${workspace.id}/loyalty`);
      if (cancelled) return;
      if (res.ok) setSettings(await res.json());
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspace.id]);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    const res = await fetch(`/api/workspaces/${workspace.id}/loyalty`, {
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
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading loyalty settings...</p>
      </div>
    );
  }

  const updateTier = (idx: number, field: keyof RedemptionTier, value: string | number) => {
    const tiers = [...settings.redemption_tiers];
    tiers[idx] = { ...tiers[idx], [field]: value };
    setSettings({ ...settings, redemption_tiers: tiers });
  };

  const addTier = () => {
    const last = settings.redemption_tiers[settings.redemption_tiers.length - 1];
    setSettings({
      ...settings,
      redemption_tiers: [
        ...settings.redemption_tiers,
        {
          label: `$${(last?.discount_value || 15) + 5} Off`,
          points_cost: (last?.points_cost || 1500) + 500,
          discount_value: (last?.discount_value || 15) + 5,
        },
      ],
    });
  };

  const removeTier = (idx: number) => {
    if (settings.redemption_tiers.length <= 1) return;
    setSettings({
      ...settings,
      redemption_tiers: settings.redemption_tiers.filter((_, i) => i !== idx),
    });
  };

  const Toggle = ({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) => (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</p>
        {hint && <p className="text-xs text-zinc-400 mt-0.5">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${checked ? "bg-emerald-500" : "bg-zinc-200 dark:bg-zinc-700"}`}
      >
        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${checked ? "translate-x-5" : "translate-x-0"}`} />
      </button>
    </div>
  );

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Loyalty</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Configure your native loyalty points program. Customers earn points on purchases and redeem them for discounts.
        </p>
      </div>

      <div className="space-y-6">
        {/* Master toggle */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <Toggle
            checked={settings.enabled}
            onChange={(v) => setSettings({ ...settings, enabled: v })}
            label="Enable Loyalty"
            hint="When enabled, points are earned on orders and customers can redeem for discounts."
          />
        </div>

        {/* Earning settings */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Earning</h3>
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={100}
                value={settings.points_per_dollar}
                onChange={(e) => setSettings({ ...settings, points_per_dollar: parseInt(e.target.value) || 10 })}
                className="w-20 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              <span className="text-sm text-zinc-500">points per $1 spent</span>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">Exclude from qualifying amount:</p>
              <div className="space-y-2">
                <Toggle checked={settings.exclude_tax} onChange={(v) => setSettings({ ...settings, exclude_tax: v })} label="Tax" />
                <Toggle checked={settings.exclude_discounts} onChange={(v) => setSettings({ ...settings, exclude_discounts: v })} label="Discounts already applied" />
                <Toggle checked={settings.exclude_shipping} onChange={(v) => setSettings({ ...settings, exclude_shipping: v })} label="Shipping costs" />
                <Toggle checked={settings.exclude_shipping_protection} onChange={(v) => setSettings({ ...settings, exclude_shipping_protection: v })} label="Shipping protection" />
              </div>
            </div>
          </div>
        </div>

        {/* Conversion */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Conversion Rate</h3>
          <p className="mt-0.5 text-xs text-zinc-400">How many points equal $1 in rewards.</p>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={settings.points_per_dollar_value}
              onChange={(e) => setSettings({ ...settings, points_per_dollar_value: parseInt(e.target.value) || 100 })}
              className="w-24 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <span className="text-sm text-zinc-500">points = $1</span>
          </div>
        </div>

        {/* Redemption tiers */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Redemption Tiers</h3>
              <p className="mt-0.5 text-xs text-zinc-400">Define reward tiers customers can redeem.</p>
            </div>
            <button
              onClick={addTier}
              className="rounded-md border border-indigo-300 px-3 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-950"
            >
              Add Tier
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {settings.redemption_tiers.map((tier, idx) => (
              <div key={idx} className="flex items-center gap-2 rounded-md bg-zinc-50 px-3 py-2.5 dark:bg-zinc-800">
                <input
                  type="text"
                  value={tier.label}
                  onChange={(e) => updateTier(idx, "label", e.target.value)}
                  className="w-28 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  placeholder="Label"
                />
                <input
                  type="number"
                  min={1}
                  value={tier.points_cost}
                  onChange={(e) => updateTier(idx, "points_cost", parseInt(e.target.value) || 0)}
                  className="w-24 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <span className="text-sm text-zinc-400">pts =</span>
                <div className="flex items-center">
                  <span className="text-sm text-zinc-500">$</span>
                  <input
                    type="number"
                    min={1}
                    value={tier.discount_value}
                    onChange={(e) => updateTier(idx, "discount_value", parseFloat(e.target.value) || 0)}
                    className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                </div>
                <span className="text-sm text-zinc-400">off</span>
                {settings.redemption_tiers.length > 1 && (
                  <button
                    onClick={() => removeTier(idx)}
                    className="ml-auto text-sm text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Coupon settings */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Coupon Settings</h3>
          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-600 dark:text-zinc-400">Applies to</label>
              <select
                value={settings.coupon_applies_to}
                onChange={(e) => setSettings({ ...settings, coupon_applies_to: e.target.value })}
                className="mt-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              >
                <option value="both">One-time + Subscription</option>
                <option value="one_time">One-time purchase only</option>
                <option value="subscription">Subscription only</option>
              </select>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">Combines with:</p>
              <div className="space-y-2">
                <Toggle checked={settings.coupon_combines_product} onChange={(v) => setSettings({ ...settings, coupon_combines_product: v })} label="Product discounts" />
                <Toggle checked={settings.coupon_combines_shipping} onChange={(v) => setSettings({ ...settings, coupon_combines_shipping: v })} label="Shipping discounts" />
                <Toggle checked={settings.coupon_combines_order} onChange={(v) => setSettings({ ...settings, coupon_combines_order: v })} label="Order discounts" />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Expiry:</label>
              <input
                type="number"
                min={1}
                max={365}
                value={settings.coupon_expiry_days}
                onChange={(e) => setSettings({ ...settings, coupon_expiry_days: parseInt(e.target.value) || 90 })}
                className="w-20 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              <span className="text-sm text-zinc-500">days</span>
            </div>
          </div>
        </div>

        {/* Save button */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-indigo-600 px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
          {saved && (
            <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">Saved!</span>
          )}
        </div>
      </div>
    </div>
  );
}
