"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface CancelReason {
  id: string;
  slug: string;
  label: string;
  type: "remedy" | "ai_conversation";
  suggested_remedy_id?: string | null;
  enabled: boolean;
  sort_order: number;
}

interface Remedy {
  id: string;
  name: string;
  type: string;
  description: string;
  is_active: boolean;
  priority: number;
  config: Record<string, unknown>;
  success_rate: number | null;
  coupon_mapping_id?: string | null;
}

interface CouponMapping {
  id: string;
  code: string;
  value_type: string;
  value: number;
}

interface Product {
  id: string;
  shopify_product_id: string;
  title: string;
  image_url: string | null;
  variants: { id: string; shopify_variant_id: string; title: string }[];
}

const REMEDY_TYPES = [
  { value: "coupon", label: "Coupon / Discount" },
  { value: "pause", label: "Pause subscription" },
  { value: "skip", label: "Skip next order" },
  { value: "frequency_change", label: "Change frequency" },
  { value: "free_product", label: "Free product (one-time)" },
  { value: "line_item_modifier", label: "Line item change (swap/qty)" },
];

const REASON_TYPES = [
  { value: "remedy", label: "Show remedies (AI picks top 3)" },
  { value: "ai_conversation", label: "AI conversation (open-ended chat)" },
];

// Config fields per remedy type
const TYPE_CONFIG_FIELDS: Record<string, { key: string; label: string; type: "number" | "select"; unit?: string; options?: { value: string; label: string }[] }[]> = {
  pause: [
    { key: "pause_days", label: "Pause duration", type: "select", options: [
      { value: "14", label: "14 days" }, { value: "30", label: "30 days" },
      { value: "60", label: "60 days" }, { value: "90", label: "90 days" },
    ]},
  ],
  skip: [
    { key: "skip_count", label: "Orders to skip", type: "select", options: [
      { value: "1", label: "1 order" }, { value: "2", label: "2 orders" }, { value: "3", label: "3 orders" },
    ]},
  ],
  frequency_change: [
    { key: "frequency_interval", label: "New frequency", type: "select", options: [
      { value: "monthly", label: "Every month" }, { value: "bimonthly", label: "Every 2 months" },
      { value: "quarterly", label: "Every 3 months" },
    ]},
  ],
};

const DEFAULT_REASONS: Omit<CancelReason, "id">[] = [
  { slug: "too_expensive", label: "It's too expensive", type: "remedy", enabled: true, sort_order: 0 },
  { slug: "too_much_product", label: "I have too much product", type: "remedy", enabled: true, sort_order: 1 },
  { slug: "not_seeing_results", label: "I'm not seeing results", type: "remedy", enabled: true, sort_order: 2 },
  { slug: "reached_goals", label: "I already reached my goals", type: "ai_conversation", enabled: true, sort_order: 3 },
  { slug: "just_need_a_break", label: "I just need a break", type: "ai_conversation", enabled: true, sort_order: 4 },
  { slug: "something_else", label: "Something else", type: "ai_conversation", enabled: true, sort_order: 5 },
];

function rateBadge(rate: number | null) {
  if (rate == null) return <span className="text-xs text-zinc-400">No data</span>;
  const pct = Math.round(rate * 100);
  const color = pct >= 50 ? "text-emerald-600 bg-emerald-50" : pct >= 25 ? "text-amber-600 bg-amber-50" : "text-red-600 bg-red-50";
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{pct}%</span>;
}

export default function CancelFlowSettingsPage() {
  const workspace = useWorkspace();
  const [reasons, setReasons] = useState<CancelReason[]>([]);
  const [remedies, setRemedies] = useState<Remedy[]>([]);
  const [coupons, setCoupons] = useState<CouponMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editingRemedy, setEditingRemedy] = useState<Remedy | null>(null);
  const [editingReason, setEditingReason] = useState<CancelReason | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/cancel-flow`);
      if (res.ok) {
        const data = await res.json();
        setReasons(data.reasons || []);
        setRemedies(data.remedies || []);
        setCoupons(data.coupons || []);
      }
    } catch {}
    setLoading(false);
  }, [workspace.id]);

  const fetchProducts = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/products`);
      if (res.ok) setProducts(await res.json());
    } catch {}
  }, [workspace.id]);

  useEffect(() => { fetchData(); fetchProducts(); }, [fetchData, fetchProducts]);

  const saveReasons = async (updated: CancelReason[]) => {
    setSaving(true);
    setSaved(false);
    const res = await fetch(`/api/workspaces/${workspace.id}/cancel-flow`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasons: updated }),
    });
    if (res.ok) {
      const data = await res.json();
      setReasons(data.reasons || updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  };

  const saveRemedy = async (remedy: Partial<Remedy>) => {
    setSaving(true);
    const isNew = !remedy.id;
    const res = await fetch(`/api/workspaces/${workspace.id}/cancel-flow/remedies`, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(remedy),
    });
    if (res.ok) {
      await fetchData();
      setEditingRemedy(null);
    }
    setSaving(false);
  };

  const deleteRemedy = async (id: string) => {
    const res = await fetch(`/api/workspaces/${workspace.id}/cancel-flow/remedies?id=${id}`, {
      method: "DELETE",
    });
    if (res.ok) await fetchData();
  };

  const moveReason = (idx: number, dir: -1 | 1) => {
    const swap = idx + dir;
    if (swap < 0 || swap >= reasons.length) return;
    const updated = [...reasons];
    [updated[idx], updated[swap]] = [updated[swap], updated[idx]];
    updated.forEach((r, i) => { r.sort_order = i; });
    setReasons(updated);
    saveReasons(updated);
  };

  const toggleReason = (idx: number) => {
    const updated = [...reasons];
    updated[idx] = { ...updated[idx], enabled: !updated[idx].enabled };
    setReasons(updated);
    saveReasons(updated);
  };

  const addReason = () => {
    setEditingReason({
      id: "",
      slug: "",
      label: "",
      type: "remedy",
      enabled: true,
      sort_order: reasons.length,
    });
  };

  const saveReason = async () => {
    if (!editingReason?.label || !editingReason?.slug) return;
    const updated = editingReason.id
      ? reasons.map(r => r.id === editingReason.id ? editingReason : r)
      : [...reasons, { ...editingReason, id: "new_" + Date.now(), sort_order: reasons.length }];
    setEditingReason(null);
    await saveReasons(updated);
  };

  const deleteReason = (id: string) => {
    const updated = reasons.filter(r => r.id !== id);
    updated.forEach((r, i) => { r.sort_order = i; });
    saveReasons(updated);
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading cancel flow settings...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Cancel Flow</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Configure cancel reasons shown to customers and the retention remedies AI selects from.
        </p>
      </div>

      <div className="space-y-6">
        {/* Cancel Reasons */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Cancel Reasons</h3>
              <p className="mt-0.5 text-xs text-zinc-400">Reasons displayed to customers during the cancel journey.</p>
            </div>
            <button onClick={addReason} className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600">
              Add Reason
            </button>
          </div>

          <div className="space-y-2">
            {reasons.map((r, i) => (
              <div key={r.id || r.slug} className="flex items-center gap-3 rounded-md border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-800/50">
                <div className="flex flex-col gap-0.5">
                  <button onClick={() => moveReason(i, -1)} disabled={i === 0} className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-30">&#9650;</button>
                  <button onClick={() => moveReason(i, 1)} disabled={i === reasons.length - 1} className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-30">&#9660;</button>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.label}</span>
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${r.type === "ai_conversation" ? "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300" : "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300"}`}>
                      {r.type === "ai_conversation" ? "AI chat" : "Remedies"}
                    </span>
                  </div>
                  <div className="text-xs text-zinc-400 font-mono">{r.slug}</div>
                </div>
                <button
                  onClick={() => toggleReason(i)}
                  className={`relative h-5 w-9 rounded-full transition-colors ${r.enabled ? "bg-indigo-500" : "bg-zinc-300 dark:bg-zinc-600"}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${r.enabled ? "left-[18px]" : "left-0.5"}`} />
                </button>
                <button onClick={() => setEditingReason(r)} className="text-xs text-indigo-500 hover:text-indigo-700">Edit</button>
                <button onClick={() => deleteReason(r.id)} className="text-xs text-red-400 hover:text-red-600">Delete</button>
              </div>
            ))}
            {reasons.length === 0 && (
              <div className="text-center py-4">
                <p className="text-sm text-zinc-400">No cancel reasons configured.</p>
                <button onClick={() => {
                  const seeded = DEFAULT_REASONS.map((r, i) => ({ ...r, id: "seed_" + i })) as CancelReason[];
                  saveReasons(seeded);
                }} className="mt-2 text-xs text-indigo-500 hover:text-indigo-700">
                  Seed defaults
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Edit Reason Modal */}
        {editingReason && (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-5 dark:border-indigo-800 dark:bg-indigo-950">
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
              {editingReason.id ? "Edit Reason" : "Add Reason"}
            </h4>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1">Label (customer-facing)</label>
                <input
                  value={editingReason.label}
                  onChange={(e) => setEditingReason({ ...editingReason, label: e.target.value })}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1">Slug (internal key)</label>
                <input
                  value={editingReason.slug}
                  onChange={(e) => setEditingReason({ ...editingReason, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1">Type</label>
                <select
                  value={editingReason.type || "remedy"}
                  onChange={(e) => setEditingReason({ ...editingReason, type: e.target.value as "remedy" | "ai_conversation" })}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  {REASON_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              {editingReason.type === "remedy" && (
                <div>
                  <label className="block text-xs font-medium text-zinc-500 mb-1">Suggested remedy (optional — AI will prioritize this)</label>
                  <select
                    value={editingReason.suggested_remedy_id || ""}
                    onChange={(e) => setEditingReason({ ...editingReason, suggested_remedy_id: e.target.value || null })}
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    <option value="">AI decides (no suggestion)</option>
                    {remedies.filter(r => r.is_active).map(r => (
                      <option key={r.id} value={r.id}>{r.name} ({r.type})</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={saveReason} disabled={!editingReason.label || !editingReason.slug}
                  className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
                  Save
                </button>
                <button onClick={() => setEditingReason(null)} className="text-xs text-zinc-500 hover:text-zinc-700">Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Remedies Library */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Remedies Library</h3>
              <p className="mt-0.5 text-xs text-zinc-400">Retention offers AI selects from. Max 3 shown to each customer.</p>
            </div>
            <button onClick={() => setEditingRemedy({
              id: "", name: "", type: "coupon", description: "", is_active: true,
              priority: remedies.length, config: {}, success_rate: null,
            })} className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600">
              Add Remedy
            </button>
          </div>

          <div className="space-y-2">
            {remedies.map(r => (
              <div key={r.id} className="flex items-center gap-3 rounded-md border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-800/50">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.name}</span>
                    <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-mono text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400">{r.type}</span>
                    {rateBadge(r.success_rate)}
                  </div>
                  {r.description && <div className="text-xs text-zinc-500 mt-0.5 truncate">{r.description}</div>}
                </div>
                <button
                  onClick={async () => {
                    const updated = { ...r, is_active: !r.is_active };
                    await saveRemedy(updated);
                  }}
                  className={`relative h-5 w-9 rounded-full transition-colors ${r.is_active ? "bg-indigo-500" : "bg-zinc-300 dark:bg-zinc-600"}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${r.is_active ? "left-[18px]" : "left-0.5"}`} />
                </button>
                <button onClick={() => setEditingRemedy(r)} className="text-xs text-indigo-500 hover:text-indigo-700">Edit</button>
                <button onClick={() => deleteRemedy(r.id)} className="text-xs text-red-400 hover:text-red-600">Delete</button>
              </div>
            ))}
            {remedies.length === 0 && (
              <p className="text-center py-4 text-sm text-zinc-400">No remedies configured yet.</p>
            )}
          </div>
        </div>

        {/* Edit Remedy Form */}
        {editingRemedy && (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-5 dark:border-indigo-800 dark:bg-indigo-950">
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
              {editingRemedy.id ? "Edit Remedy" : "Add Remedy"}
            </h4>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1">Name</label>
                <input value={editingRemedy.name}
                  onChange={(e) => setEditingRemedy({ ...editingRemedy, name: e.target.value })}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1">Type</label>
                <select value={editingRemedy.type}
                  onChange={(e) => setEditingRemedy({ ...editingRemedy, type: e.target.value })}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {REMEDY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1">Pitch text (max 25 words, shown to customer)</label>
                <input value={editingRemedy.description}
                  onChange={(e) => setEditingRemedy({ ...editingRemedy, description: e.target.value })}
                  maxLength={150}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
              </div>
              {editingRemedy.type === "coupon" && (
                <div>
                  <label className="block text-xs font-medium text-zinc-500 mb-1">Coupon (from Coupons settings)</label>
                  <select
                    value={editingRemedy.coupon_mapping_id || ""}
                    onChange={(e) => setEditingRemedy({ ...editingRemedy, coupon_mapping_id: e.target.value || null })}
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    <option value="">Select coupon...</option>
                    {coupons.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.code} ({c.value_type === "percentage" ? c.value + "%" : "$" + c.value} off)
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {editingRemedy.type === "free_product" && (
                <div>
                  <label className="block text-xs font-medium text-zinc-500 mb-1">Free product to add</label>
                  <input
                    type="text"
                    placeholder="Search products..."
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm mb-2 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  />
                  <div className="max-h-48 overflow-y-auto rounded-md border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800">
                    {products
                      .filter(p => !productSearch || p.title.toLowerCase().includes(productSearch.toLowerCase()))
                      .slice(0, 20)
                      .map(p => {
                        const firstVariant = p.variants?.[0];
                        const isSelected = (editingRemedy.config as Record<string, unknown>)?.product_variant_id === (firstVariant?.id || p.shopify_product_id);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setEditingRemedy({
                              ...editingRemedy,
                              config: {
                                ...((editingRemedy.config || {}) as Record<string, unknown>),
                                product_variant_id: firstVariant?.id || p.shopify_product_id,
                                product_title: p.title,
                                product_image_url: p.image_url,
                              },
                            })}
                            className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 ${isSelected ? "bg-indigo-50 dark:bg-indigo-900/30" : ""}`}
                          >
                            {p.image_url ? (
                              <img src={p.image_url} alt="" className="h-8 w-8 rounded object-cover" />
                            ) : (
                              <div className="h-8 w-8 rounded bg-zinc-200 dark:bg-zinc-600" />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{p.title}</div>
                              {firstVariant?.title && firstVariant.title !== "Default Title" && (
                                <div className="text-xs text-zinc-400 truncate">{firstVariant.title}</div>
                              )}
                            </div>
                            {isSelected && <span className="text-indigo-500 text-xs font-medium">Selected</span>}
                          </button>
                        );
                      })}
                    {products.filter(p => !productSearch || p.title.toLowerCase().includes(productSearch.toLowerCase())).length === 0 && (
                      <div className="px-3 py-4 text-center text-xs text-zinc-400">No products found</div>
                    )}
                  </div>
                  {String((editingRemedy.config as Record<string, unknown>)?.product_title || "") && (
                    <div className="mt-2 flex items-center gap-2 rounded-md bg-indigo-50 px-3 py-2 text-sm dark:bg-indigo-900/30">
                      {String((editingRemedy.config as Record<string, unknown>)?.product_image_url || "") && (
                        <img src={String((editingRemedy.config as Record<string, unknown>).product_image_url)} alt="" className="h-6 w-6 rounded object-cover" />
                      )}
                      <span className="text-indigo-700 dark:text-indigo-300 font-medium">
                        {String((editingRemedy.config as Record<string, unknown>).product_title)}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {TYPE_CONFIG_FIELDS[editingRemedy.type]?.map(field => (
                <div key={field.key}>
                  <label className="block text-xs font-medium text-zinc-500 mb-1">{field.label}</label>
                  {field.type === "select" && field.options ? (
                    <select
                      value={String((editingRemedy.config as Record<string, unknown>)?.[field.key] || "")}
                      onChange={(e) => setEditingRemedy({
                        ...editingRemedy,
                        config: { ...((editingRemedy.config || {}) as Record<string, unknown>), [field.key]: e.target.value },
                      })}
                      className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    >
                      <option value="">Select...</option>
                      {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input
                      type="number"
                      value={String((editingRemedy.config as Record<string, unknown>)?.[field.key] || "")}
                      onChange={(e) => setEditingRemedy({
                        ...editingRemedy,
                        config: { ...((editingRemedy.config || {}) as Record<string, unknown>), [field.key]: e.target.value },
                      })}
                      className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    />
                  )}
                </div>
              ))}
              <div className="flex gap-2">
                <button onClick={() => saveRemedy(editingRemedy)} disabled={saving || !editingRemedy.name}
                  className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
                  {saving ? "Saving..." : "Save"}
                </button>
                <button onClick={() => setEditingRemedy(null)} className="text-xs text-zinc-500 hover:text-zinc-700">Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* How it works */}
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-5 dark:border-zinc-700 dark:bg-zinc-900/50">
          <h3 className="mb-2 text-sm font-semibold text-zinc-600 dark:text-zinc-400">How it works</h3>
          <div className="space-y-2 text-xs text-zinc-500">
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400" />
              <p><span className="font-medium">Customer selects cancel reason:</span> Shown in the portal cancel flow</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400" />
              <p><span className="font-medium">AI picks top 3 remedies:</span> Claude Haiku selects from enabled remedies based on cancel reason + customer context</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400" />
              <p><span className="font-medium">Learning over time:</span> Acceptance rates tracked per remedy. AI adjusts selections based on success_rate</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400" />
              <p><span className="font-medium">Social proof:</span> Relevant product reviews are shown alongside all remedies automatically (tagged by cancel reason)</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400" />
              <p><span className="font-medium">Reason types:</span> &quot;Remedy&quot; reasons show AI-picked offers. &quot;AI conversation&quot; reasons open a chat. Cancel button hidden until 2 AI turns.</p>
            </div>
          </div>
        </div>

        {saved && <span className="text-sm text-green-600">Saved</span>}
      </div>
    </div>
  );
}
