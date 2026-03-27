"use client";

import { useEffect, useState, useRef } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface ShopifyDiscount {
  id: string;
  code: string;
  title: string;
  valueType: string;
  value: number;
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
  const [showAddForm, setShowAddForm] = useState(false);

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

  const handleSave = async (mapping: Partial<CouponMapping> & { shopify_discount_id: string; code: string; value_type: string; value: number }) => {
    setSaving(true);
    await fetch(`/api/workspaces/${workspace.id}/coupons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mapping),
    });
    setShowAddForm(false);
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

  // Filter mapped coupons by search
  const q = search.toLowerCase();
  const filteredMappings = mappings.filter(m =>
    !q || m.code.toLowerCase().includes(q) || (m.title || "").toLowerCase().includes(q) || m.use_cases.some(uc => uc.includes(q))
  );

  // Unmapped discounts for the add form
  const unmapped = shopifyDiscounts.filter(d => !mappings.some(m => m.code === d.code));

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
            type="number" min={0} max={100} value={vipThreshold}
            onChange={(e) => setVipThreshold(parseInt(e.target.value) || 0)}
            className="w-20 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <span className="text-sm text-zinc-500">/ 100 retention score</span>
          <button onClick={handleVipSave} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">Save</button>
        </div>
      </div>

      {/* Header + actions */}
      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Mapped Coupons ({mappings.length})</h2>
        <div className="flex gap-2">
          <button onClick={handleSync} disabled={syncing}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
            {syncing ? "Syncing..." : "Sync from Shopify"}
          </button>
          <button onClick={() => setShowAddForm(true)} disabled={unmapped.length === 0}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            Map Coupon
          </button>
        </div>
      </div>

      {shopifyDiscounts.length === 0 && mappings.length === 0 && (
        <p className="mt-3 text-sm text-zinc-400">Click "Sync from Shopify" to pull your active discount codes. Requires read_discounts scope.</p>
      )}

      {/* Add new mapping form */}
      {showAddForm && (
        <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950">
          <CouponMapper discounts={unmapped} saving={saving} onSave={handleSave} onCancel={() => setShowAddForm(false)} />
        </div>
      )}

      {/* Search */}
      {mappings.length > 0 && (
        <div className="mt-4">
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search mapped coupons..."
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
        </div>
      )}

      {/* Mapped coupons list */}
      <div className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        {filteredMappings.length === 0 && mappings.length > 0 && (
          <p className="p-4 text-sm text-zinc-400">No coupons match your search.</p>
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
                    : m.customer_tier === "non_vip" ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800"
                    : "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                  }`}>
                    {TIER_OPTIONS.find(t => t.value === m.customer_tier)?.label}
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
                  {m.ai_enabled && <span className="text-cyan-500">AI</span>}
                  {m.agent_enabled && <span className="text-indigo-500">Agent</span>}
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
            {editingId === m.id && (
              <div className="border-t border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
                <CouponEditor mapping={m} saving={saving} onSave={(updated) => handleSave({ ...updated, shopify_discount_id: m.shopify_discount_id, code: m.code, value_type: m.value_type, value: m.value })} onCancel={() => setEditingId(null)} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Worksheet-style mapper: searchable coupon picker → configure → save
function CouponMapper({ discounts, saving, onSave, onCancel }: {
  discounts: ShopifyDiscount[];
  saving: boolean;
  onSave: (m: { shopify_discount_id: string; code: string; title: string; value_type: string; value: number; summary: string; use_cases: string[]; customer_tier: string; ai_enabled: boolean; agent_enabled: boolean; notes: string }) => void;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ShopifyDiscount | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [useCases, setUseCases] = useState<string[]>(["discount_request"]);
  const [tier, setTier] = useState("all");
  const [aiEnabled, setAiEnabled] = useState(true);
  const [agentEnabled, setAgentEnabled] = useState(true);
  const [notes, setNotes] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filtered = discounts.filter(d =>
    !search || d.code.toLowerCase().includes(search.toLowerCase()) || d.title.toLowerCase().includes(search.toLowerCase())
  );

  const toggleUseCase = (uc: string) => {
    setUseCases(prev => prev.includes(uc) ? prev.filter(u => u !== uc) : [...prev, uc]);
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-indigo-900 dark:text-indigo-100">Map a New Coupon</h3>

      {/* Step 1: Select coupon */}
      <div>
        <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">1. Select Coupon</label>
        {selected ? (
          <div className="mt-1 flex items-center gap-2">
            <span className="rounded-md border border-indigo-300 bg-white px-3 py-2 font-mono text-sm font-bold text-zinc-900 dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100">
              {selected.code}
            </span>
            <span className="text-xs text-zinc-500">{formatValue(selected.valueType, selected.value)}</span>
            <button onClick={() => setSelected(null)} className="text-xs text-red-500 hover:underline">Change</button>
          </div>
        ) : (
          <div className="relative mt-1" ref={dropdownRef}>
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setShowDropdown(true); }}
              onFocus={() => setShowDropdown(true)}
              placeholder="Search discount codes..."
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            {showDropdown && (
              <div className="absolute left-0 top-full z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                {filtered.length === 0 ? (
                  <p className="p-3 text-sm text-zinc-400">No matching discounts. Try syncing from Shopify first.</p>
                ) : (
                  filtered.slice(0, 50).map(d => (
                    <button key={d.id} type="button"
                      onClick={() => { setSelected(d); setShowDropdown(false); setSearch(""); }}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-700">
                      <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{d.code}</span>
                      <span className="text-xs text-zinc-500">{formatValue(d.valueType, d.value)}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {selected && (
        <>
          {/* Step 2: Use cases */}
          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">2. Use Cases</label>
            <div className="mt-1 flex flex-wrap gap-2">
              {USE_CASE_OPTIONS.map(uc => (
                <button key={uc.value} type="button" onClick={() => toggleUseCase(uc.value)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    useCases.includes(uc.value) ? "bg-indigo-600 text-white" : "bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-400"
                  }`}>
                  {uc.label}
                </button>
              ))}
            </div>
          </div>

          {/* Step 3: Customer tier */}
          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">3. Customer Tier</label>
            <div className="mt-1 flex gap-2">
              {TIER_OPTIONS.map(t => (
                <button key={t.value} type="button" onClick={() => setTier(t.value)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    tier === t.value ? "bg-indigo-600 text-white" : "bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-400"
                  }`}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Step 4: Options */}
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 text-indigo-600" />
              AI Agent can use
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <input type="checkbox" checked={agentEnabled} onChange={(e) => setAgentEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 text-indigo-600" />
              Human agents can use
            </label>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Notes (optional)</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Only for customers who complained about shipping"
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" />
          </div>

          {/* Save */}
          <div className="flex gap-2">
            <button onClick={() => onSave({
              shopify_discount_id: selected.id,
              code: selected.code,
              title: selected.title,
              value_type: selected.valueType,
              value: selected.value,
              summary: formatValue(selected.valueType, selected.value),
              use_cases: useCases,
              customer_tier: tier,
              ai_enabled: aiEnabled,
              agent_enabled: agentEnabled,
              notes,
            })} disabled={saving || useCases.length === 0}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {saving ? "Mapping..." : "Map Coupon"}
            </button>
            <button onClick={onCancel} className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

// Edit existing mapping
function CouponEditor({ mapping, saving, onSave, onCancel }: {
  mapping: CouponMapping;
  saving: boolean;
  onSave: (m: Partial<CouponMapping>) => void;
  onCancel: () => void;
}) {
  const [useCases, setUseCases] = useState(mapping.use_cases);
  const [tier, setTier] = useState(mapping.customer_tier);
  const [aiEnabled, setAiEnabled] = useState(mapping.ai_enabled);
  const [agentEnabled, setAgentEnabled] = useState(mapping.agent_enabled);
  const [notes, setNotes] = useState(mapping.notes || "");

  const toggleUseCase = (uc: string) => {
    setUseCases(prev => prev.includes(uc) ? prev.filter(u => u !== uc) : [...prev, uc]);
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-zinc-500">Use Cases</label>
        <div className="mt-1 flex flex-wrap gap-2">
          {USE_CASE_OPTIONS.map(uc => (
            <button key={uc.value} type="button" onClick={() => toggleUseCase(uc.value)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                useCases.includes(uc.value) ? "bg-indigo-600 text-white" : "bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-400"
              }`}>
              {uc.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="block text-xs text-zinc-500">Customer Tier</label>
        <div className="mt-1 flex gap-2">
          {TIER_OPTIONS.map(t => (
            <button key={t.value} type="button" onClick={() => setTier(t.value)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                tier === t.value ? "bg-indigo-600 text-white" : "bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-400"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} className="h-4 w-4 rounded border-zinc-300 text-indigo-600" />
          AI Agent
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={agentEnabled} onChange={(e) => setAgentEnabled(e.target.checked)} className="h-4 w-4 rounded border-zinc-300 text-indigo-600" />
          Human agents
        </label>
      </div>
      <div>
        <label className="block text-xs text-zinc-500">Notes</label>
        <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" />
      </div>
      <div className="flex gap-2">
        <button onClick={() => onSave({ use_cases: useCases, customer_tier: tier, ai_enabled: aiEnabled, agent_enabled: agentEnabled, notes })} disabled={saving}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {saving ? "Saving..." : "Save"}
        </button>
        <button onClick={onCancel} className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">Cancel</button>
      </div>
    </div>
  );
}
