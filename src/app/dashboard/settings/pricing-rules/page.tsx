"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface QuantityBreak {
  quantity: number;
  discount_pct: number;
  label: string;
}

interface PricingRule {
  id: string;
  name: string;
  is_active: boolean;
  quantity_breaks: QuantityBreak[];
  free_shipping: boolean;
  free_shipping_threshold_cents: number | null;
  free_gift_variant_id: string | null;
  free_gift_product_title: string | null;
  free_gift_image_url: string | null;
  free_gift_min_quantity: number;
  product_ids: string[];
}

interface Product {
  id: string;
  title: string;
  image_url: string | null;
}

export default function PricingRulesPage() {
  const workspace = useWorkspace();
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/pricing-rules`);
    if (res.ok) {
      const data = await res.json();
      setRules(data.rules || []);
      setProducts(data.products || []);
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { load(); }, [load]);

  const createRule = async () => {
    setSaving(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/pricing-rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "New Pricing Rule",
        quantity_breaks: [
          { quantity: 1, discount_pct: 0, label: "Starter" },
          { quantity: 3, discount_pct: 15, label: "Most Popular" },
          { quantity: 6, discount_pct: 25, label: "Best Value" },
        ],
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setEditingId(data.rule.id);
      await load();
    }
    setSaving(false);
  };

  const deleteRule = async (id: string) => {
    if (!confirm("Delete this pricing rule?")) return;
    await fetch(`/api/workspaces/${workspace.id}/pricing-rules/${id}`, { method: "DELETE" });
    await load();
  };

  if (loading) return <div className="mx-auto max-w-5xl px-4 py-6"><p className="text-sm text-zinc-400">Loading...</p></div>;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Pricing Rules</h1>
      <p className="mb-6 text-sm text-zinc-500">Define quantity discounts, free shipping thresholds, and free gifts. Assign rules to products.</p>

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-500">{rules.length} rule{rules.length !== 1 ? "s" : ""}</p>
          <button onClick={createRule} disabled={saving}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
            + New Pricing Rule
          </button>
        </div>

        {rules.map(rule => (
          <RuleCard key={rule.id} rule={rule} products={products} workspaceId={workspace.id}
            isEditing={editingId === rule.id}
            onEdit={() => setEditingId(editingId === rule.id ? null : rule.id)}
            onDelete={() => deleteRule(rule.id)}
            onSaved={() => { load(); setMessage("Saved"); setTimeout(() => setMessage(null), 2000); }} />
        ))}

        {rules.length === 0 && (
          <div className="rounded-lg border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-500">No pricing rules yet. Create one to define quantity discounts.</p>
          </div>
        )}

        {message && <p className="text-sm text-green-600">{message}</p>}
      </div>
    </div>
  );
}

function RuleCard({
  rule, products, workspaceId, isEditing, onEdit, onDelete, onSaved,
}: {
  rule: PricingRule; products: Product[]; workspaceId: string;
  isEditing: boolean; onEdit: () => void; onDelete: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(rule.name);
  const [breaks, setBreaks] = useState<QuantityBreak[]>(rule.quantity_breaks || []);
  const [freeShipping, setFreeShipping] = useState(rule.free_shipping);
  const [freeShipThreshold, setFreeShipThreshold] = useState(rule.free_shipping_threshold_cents ? (rule.free_shipping_threshold_cents / 100).toString() : "");
  const [giftTitle, setGiftTitle] = useState(rule.free_gift_product_title || "");
  const [giftMinQty, setGiftMinQty] = useState(rule.free_gift_min_quantity);
  const [selectedProducts, setSelectedProducts] = useState<string[]>(rule.product_ids);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    await fetch(`/api/workspaces/${workspaceId}/pricing-rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name, quantity_breaks: breaks, free_shipping: freeShipping,
        free_shipping_threshold_cents: freeShipThreshold ? Math.round(parseFloat(freeShipThreshold) * 100) : null,
        free_gift_product_title: giftTitle || null, free_gift_min_quantity: giftMinQty,
        product_ids: selectedProducts,
      }),
    });
    setSaving(false);
    onSaved();
  };

  const addBreak = () => {
    const lastQty = breaks.length > 0 ? breaks[breaks.length - 1].quantity : 0;
    setBreaks([...breaks, { quantity: lastQty + 3, discount_pct: 0, label: `${lastQty + 3} Units` }]);
  };

  const updateBreak = (i: number, field: keyof QuantityBreak, value: string | number) => {
    const next = [...breaks];
    next[i] = { ...next[i], [field]: field === "quantity" || field === "discount_pct" ? Number(value) : value };
    setBreaks(next);
  };

  const toggleProduct = (pid: string) => {
    setSelectedProducts(prev => prev.includes(pid) ? prev.filter(p => p !== pid) : [...prev, pid]);
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between p-4">
        <div>
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{rule.name}</h3>
          <p className="text-xs text-zinc-500">
            {(rule.quantity_breaks || []).length} tier{(rule.quantity_breaks || []).length !== 1 ? "s" : ""} · {selectedProducts.length} product{selectedProducts.length !== 1 ? "s" : ""}
            {rule.free_shipping && " · Free shipping"}
            {rule.free_gift_product_title && ` · Gift: ${rule.free_gift_product_title}`}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={onEdit} className="rounded bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400">
            {isEditing ? "Close" : "Edit"}
          </button>
          <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600">Delete</button>
        </div>
      </div>

      {isEditing && (
        <div className="space-y-5 border-t border-zinc-200 p-4 dark:border-zinc-800">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Rule Name</span>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
          </label>

          <div>
            <span className="mb-2 block text-xs font-medium text-zinc-500">Quantity Tiers</span>
            <div className="space-y-2">
              {breaks.map((b, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="number" value={b.quantity} onChange={e => updateBreak(i, "quantity", e.target.value)}
                    className="w-20 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" placeholder="Qty" />
                  <span className="text-xs text-zinc-400">units @</span>
                  <input type="number" value={b.discount_pct} onChange={e => updateBreak(i, "discount_pct", e.target.value)}
                    className="w-20 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" placeholder="%" />
                  <span className="text-xs text-zinc-400">% off</span>
                  <input value={b.label} onChange={e => updateBreak(i, "label", e.target.value)}
                    className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" placeholder="Column label" />
                  <button onClick={() => setBreaks(breaks.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-600">×</button>
                </div>
              ))}
            </div>
            <button onClick={addBreak} className="mt-2 text-xs font-medium text-indigo-500 hover:text-indigo-700">+ Add tier</button>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={freeShipping} onChange={e => setFreeShipping(e.target.checked)}
                className="rounded border-zinc-300 text-indigo-500" />
              <span className="text-sm text-zinc-700 dark:text-zinc-300">Free shipping (all quantities)</span>
            </label>
            {!freeShipping && (
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">Or free shipping above ($)</span>
                <input type="number" value={freeShipThreshold} onChange={e => setFreeShipThreshold(e.target.value)}
                  placeholder="e.g. 99.00"
                  className="w-40 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" />
              </label>
            )}
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium text-zinc-500">Free Gift</span>
            <input value={giftTitle} onChange={e => setGiftTitle(e.target.value)}
              placeholder="Product name (leave blank for none)"
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" />
            {giftTitle && (
              <label className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">Min quantity to qualify:</span>
                <input type="number" value={giftMinQty} onChange={e => setGiftMinQty(Number(e.target.value))}
                  className="w-16 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" />
              </label>
            )}
          </div>

          <div>
            <span className="mb-2 block text-xs font-medium text-zinc-500">Assigned Products ({selectedProducts.length})</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {products.map(p => (
                <label key={p.id} className={`flex cursor-pointer items-center gap-2 rounded-md border p-2 text-xs ${
                  selectedProducts.includes(p.id)
                    ? "border-indigo-400 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-950"
                    : "border-zinc-200 dark:border-zinc-700"
                }`}>
                  <input type="checkbox" checked={selectedProducts.includes(p.id)} onChange={() => toggleProduct(p.id)}
                    className="rounded border-zinc-300 text-indigo-500" />
                  {p.image_url && <img src={p.image_url} alt="" className="h-6 w-6 rounded object-cover" />}
                  <span className="truncate text-zinc-700 dark:text-zinc-300">{p.title}</span>
                </label>
              ))}
            </div>
          </div>

          <button onClick={save} disabled={saving}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
            {saving ? "Saving..." : "Save Rule"}
          </button>
        </div>
      )}
    </div>
  );
}
