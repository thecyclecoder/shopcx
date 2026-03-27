"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface ShopifyDiscount {
  id: string;
  code: string;
  title: string;
  valueType: string;
  value: number;
  appliesOnSubscription: boolean;
}

interface CouponMapping {
  id: string;
  code: string;
  title: string | null;
  value_type: string;
  value: number;
  summary: string | null;
  use_cases: string[];
  customer_tier: string;
  ai_enabled: boolean;
  agent_enabled: boolean;
  notes: string | null;
  shopify_discount_id: string;
}

const USE_CASE_OPTIONS = [
  { value: "discount_request", label: "Discount Request" },
  { value: "fixing_mistake", label: "Fixing a Mistake" },
  { value: "retention_save", label: "Retention / Save" },
  { value: "win_back", label: "Win-Back" },
  { value: "first_order", label: "First Order Incentive" },
  { value: "subscription_incentive", label: "Subscription Incentive" },
  { value: "apology", label: "Apology / Service Recovery" },
];

const TIER_OPTIONS = [
  { value: "all", label: "All Customers" },
  { value: "vip", label: "VIP Only" },
  { value: "non_vip", label: "Non-VIP Only" },
];

function formatValue(type: string, value: number): string {
  if (type === "percentage") return `${value}% off`;
  if (type === "fixed_amount") return `$${value.toFixed(2)} off`;
  return "Free shipping";
}

export default function CouponsPage() {
  const workspace = useWorkspace();
  const [mappings, setMappings] = useState<CouponMapping[]>([]);
  const [shopifyDiscounts, setShopifyDiscounts] = useState<ShopifyDiscount[]>([]);
  const [vipThreshold, setVipThreshold] = useState(85);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const loadData = async (sync = false) => {
    const res = await fetch(`/api/workspaces/${workspace.id}/coupons${sync ? "?sync=true" : ""}`);
    const data = await res.json();
    setMappings(data.mappings || []);
    if (data.shopify_discounts?.length) setShopifyDiscounts(data.shopify_discounts);
    setVipThreshold(data.vip_threshold || 85);
    setLoading(false);
  };

  useEffect(() => { loadData(); }, [workspace.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSync = async () => {
    setSyncing(true);
    await loadData(true);
    setSyncing(false);
  };

  const handleImport = async (d: ShopifyDiscount) => {
    setSaving(true);
    await fetch(`/api/workspaces/${workspace.id}/coupons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shopify_discount_id: d.id,
        code: d.code,
        title: d.title,
        value_type: d.valueType,
        value: d.value,
        summary: formatValue(d.valueType, d.value),
        use_cases: ["discount_request"],
        customer_tier: "all",
        ai_enabled: true,
        agent_enabled: true,
        applies_to_subscriptions: true,
      }),
    });
    await loadData();
    setSaving(false);
  };

  const handleSave = async (mapping: CouponMapping) => {
    setSaving(true);
    await fetch(`/api/workspaces/${workspace.id}/coupons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mapping),
    });
    setEditingId(null);
    await loadData();
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this coupon mapping?")) return;
    await fetch(`/api/workspaces/${workspace.id}/coupons?id=${id}`, { method: "DELETE" });
    await loadData();
  };

  const handleVipSave = async () => {
    await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vip_retention_threshold: vipThreshold }),
    });
    alert("VIP threshold saved!");
  };

  if (loading) return <div className="p-8 text-zinc-500">Loading...</div>;

  // Filter by search
  const q = search.toLowerCase();
  const unmapped = shopifyDiscounts.filter(d => !mappings.some(m => m.code === d.code))
    .filter(d => !q || d.code.toLowerCase().includes(q) || d.title.toLowerCase().includes(q));
  const filteredMappings = mappings.filter(m => !q || m.code.toLowerCase().includes(q) || (m.title || "").toLowerCase().includes(q) || m.use_cases.some(uc => uc.includes(q)));

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Coupons</h1>
      <p className="mt-1 text-sm text-zinc-500">Map Shopify discount codes for AI and agent use.</p>

      {/* VIP Threshold */}
      <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">VIP Tier Threshold</h2>
        <p className="mt-1 text-xs text-zinc-500">Customers with a retention score at or above this threshold are considered VIP.</p>
        <div className="mt-3 flex items-center gap-3">
          <input
            type="number"
            min={0}
            max={100}
            value={vipThreshold}
            onChange={(e) => setVipThreshold(parseInt(e.target.value) || 0)}
            className="w-20 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <span className="text-sm text-zinc-500">/ 100 retention score</span>
          <button onClick={handleVipSave} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
            Save
          </button>
        </div>
      </div>

      {/* Sync from Shopify */}
      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Mapped Coupons ({mappings.length})</h2>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {syncing ? "Syncing..." : "Sync from Shopify"}
        </button>
      </div>

      {/* Unmapped Shopify discounts */}
      {unmapped.length > 0 && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{unmapped.length} subscription-eligible discounts found in Shopify</p>
          <div className="mt-3 space-y-2">
            {unmapped.map(d => (
              <div key={d.id} className="flex items-center justify-between rounded-md bg-white px-3 py-2 dark:bg-zinc-800">
                <div>
                  <span className="text-sm font-mono font-medium text-zinc-900 dark:text-zinc-100">{d.code}</span>
                  <span className="ml-2 text-xs text-zinc-500">{formatValue(d.valueType, d.value)}</span>
                  <span className="ml-2 text-xs text-zinc-400">{d.title}</span>
                </div>
                <button
                  onClick={() => handleImport(d)}
                  disabled={saving}
                  className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  Import
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      <div className="mt-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search coupons by code, title, or use case..."
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
      </div>

      {/* Mapped coupons list */}
      <div className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        {filteredMappings.length === 0 && (
          <p className="p-4 text-sm text-zinc-400">{mappings.length === 0 ? "No coupons mapped yet. Sync from Shopify to get started." : "No coupons match your search."}</p>
        )}
        {filteredMappings.map(m => (
          <div key={m.id}>
            <div className="flex items-center justify-between p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-zinc-900 dark:text-zinc-100">{m.code}</span>
                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                    {formatValue(m.value_type, m.value)}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    m.customer_tier === "vip" ? "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
                    : m.customer_tier === "non_vip" ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    : "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                  }`}>
                    {TIER_OPTIONS.find(t => t.value === m.customer_tier)?.label || m.customer_tier}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {m.use_cases.map(uc => (
                    <span key={uc} className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {USE_CASE_OPTIONS.find(o => o.value === uc)?.label || uc}
                    </span>
                  ))}
                </div>
                <div className="mt-1 flex gap-3 text-xs text-zinc-400">
                  {m.ai_enabled && <span className="text-cyan-500">AI enabled</span>}
                  {m.agent_enabled && <span className="text-indigo-500">Agent enabled</span>}
                  {m.notes && <span>{m.notes}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setEditingId(editingId === m.id ? null : m.id)} className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
                  {editingId === m.id ? "Close" : "Edit"}
                </button>
                <button onClick={() => handleDelete(m.id)} className="text-sm text-red-500 hover:underline">Remove</button>
              </div>
            </div>

            {/* Inline edit */}
            {editingId === m.id && (
              <CouponEditor mapping={m} saving={saving} onSave={handleSave} onCancel={() => setEditingId(null)} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CouponEditor({ mapping, saving, onSave, onCancel }: {
  mapping: CouponMapping;
  saving: boolean;
  onSave: (m: CouponMapping) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(mapping);

  const toggleUseCase = (uc: string) => {
    setForm(f => ({
      ...f,
      use_cases: f.use_cases.includes(uc) ? f.use_cases.filter(u => u !== uc) : [...f.use_cases, uc],
    }));
  };

  return (
    <div className="border-t border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
      <div className="space-y-3">
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-xs text-zinc-500">Summary (shown to AI)</label>
            <input type="text" value={form.summary || ""} onChange={(e) => setForm({ ...form, summary: e.target.value })}
              placeholder="e.g. 15% off for subscription customers"
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" />
          </div>
          <div>
            <label className="block text-xs text-zinc-500">Customer Tier</label>
            <select value={form.customer_tier} onChange={(e) => setForm({ ...form, customer_tier: e.target.value })}
              className="mt-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
              {TIER_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs text-zinc-500">Use Cases (select all that apply)</label>
          <div className="mt-1 flex flex-wrap gap-2">
            {USE_CASE_OPTIONS.map(uc => (
              <button key={uc.value} type="button" onClick={() => toggleUseCase(uc.value)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  form.use_cases.includes(uc.value)
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-400"
                }`}>
                {uc.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={form.ai_enabled} onChange={(e) => setForm({ ...form, ai_enabled: e.target.checked })}
              className="h-4 w-4 rounded border-zinc-300 text-indigo-600" />
            AI Agent can use
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={form.agent_enabled} onChange={(e) => setForm({ ...form, agent_enabled: e.target.checked })}
              className="h-4 w-4 rounded border-zinc-300 text-indigo-600" />
            Human agents can use
          </label>
        </div>

        <div>
          <label className="block text-xs text-zinc-500">Notes (internal only)</label>
          <input type="text" value={form.notes || ""} onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="e.g. Only for customers who complained about shipping"
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" />
        </div>

        <div className="flex gap-2">
          <button onClick={() => onSave(form)} disabled={saving}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {saving ? "Saving..." : "Save"}
          </button>
          <button onClick={onCancel}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
