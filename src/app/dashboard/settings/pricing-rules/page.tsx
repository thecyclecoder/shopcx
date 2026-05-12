"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface QuantityBreak {
  quantity: number;
  discount_pct: number;
  label: string;
}

interface Frequency {
  interval_days: number;
  label: string;
  default?: boolean;
}

interface PricingRule {
  id: string;
  name: string;
  is_active: boolean;
  quantity_breaks: QuantityBreak[];
  free_shipping: boolean;
  free_shipping_threshold_cents: number | null;
  free_shipping_subscription_only: boolean;
  free_gift_variant_id: string | null;
  free_gift_product_title: string | null;
  free_gift_image_url: string | null;
  free_gift_min_quantity: number;
  free_gift_subscription_only: boolean;
  subscribe_discount_pct: number;
  available_frequencies: Frequency[];
  product_ids: string[];
}

interface Product {
  id: string;
  title: string;
  image_url: string | null;
}

interface Variant {
  id: string;
  product_id: string;
  shopify_variant_id: string | null;
  title: string | null;
  sku: string | null;
  price_cents: number;
  image_url: string | null;
  position: number;
}

export default function PricingRulesPage() {
  const workspace = useWorkspace();
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
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
      setVariants(data.variants || []);
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
        subscribe_discount_pct: 25,
        available_frequencies: [
          { interval_days: 30, label: "Every month", default: true },
          { interval_days: 60, label: "Every 2 months" },
          { interval_days: 90, label: "Every 3 months" },
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

  if (loading) return <div className="mx-auto max-w-screen-2xl px-4 py-6"><p className="text-sm text-zinc-400">Loading...</p></div>;

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Pricing Rules</h1>
      <p className="mb-6 text-sm text-zinc-500">Quantity discounts, subscription terms, free shipping, and free gifts. Assign rules to products.</p>

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-500">{rules.length} rule{rules.length !== 1 ? "s" : ""}</p>
          <button onClick={createRule} disabled={saving}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
            + New Pricing Rule
          </button>
        </div>

        {rules.map(rule => (
          <RuleCard key={rule.id} rule={rule} products={products} variants={variants} workspaceId={workspace.id}
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
  rule, products, variants, workspaceId, isEditing, onEdit, onDelete, onSaved,
}: {
  rule: PricingRule; products: Product[]; variants: Variant[]; workspaceId: string;
  isEditing: boolean; onEdit: () => void; onDelete: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(rule.name);
  const [breaks, setBreaks] = useState<QuantityBreak[]>(rule.quantity_breaks || []);
  const [freeShipping, setFreeShipping] = useState(rule.free_shipping);
  const [freeShipThreshold, setFreeShipThreshold] = useState(rule.free_shipping_threshold_cents ? (rule.free_shipping_threshold_cents / 100).toString() : "");
  const [freeShipSubOnly, setFreeShipSubOnly] = useState(rule.free_shipping_subscription_only);
  const [giftVariantId, setGiftVariantId] = useState(rule.free_gift_variant_id || "");
  const [giftMinQty, setGiftMinQty] = useState(rule.free_gift_min_quantity);
  const [giftSubOnly, setGiftSubOnly] = useState(rule.free_gift_subscription_only);
  const [subDiscount, setSubDiscount] = useState(rule.subscribe_discount_pct);
  const [frequencies, setFrequencies] = useState<Frequency[]>(rule.available_frequencies || []);
  const [selectedProducts, setSelectedProducts] = useState<string[]>(rule.product_ids);
  const [saving, setSaving] = useState(false);

  // Match selected gift variant to its product so the picker can
  // display name + image without an extra lookup. The denormalized
  // title/image columns are written on save.
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const giftVariant = giftVariantId
    ? variants.find((v) => v.id === giftVariantId || v.shopify_variant_id === giftVariantId)
    : null;
  const giftProduct = giftVariant ? productById.get(giftVariant.product_id) : null;

  const save = async () => {
    setSaving(true);
    // Re-derive denormalized title/image from the selected variant so
    // the storefront doesn't need to join product_variants to render
    // the gift line.
    const v = variants.find((x) => x.id === giftVariantId || x.shopify_variant_id === giftVariantId);
    const p = v ? productById.get(v.product_id) : null;
    const giftTitle = v
      ? v.title && p && v.title !== p.title
        ? `${p.title} — ${v.title}`
        : p?.title || v.title || ""
      : null;
    const giftImage = v?.image_url || p?.image_url || null;

    await fetch(`/api/workspaces/${workspaceId}/pricing-rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        quantity_breaks: breaks,
        free_shipping: freeShipping,
        free_shipping_threshold_cents: freeShipThreshold ? Math.round(parseFloat(freeShipThreshold) * 100) : null,
        free_shipping_subscription_only: freeShipSubOnly,
        free_gift_variant_id: giftVariantId || null,
        free_gift_product_title: giftTitle,
        free_gift_image_url: giftImage,
        free_gift_min_quantity: giftMinQty,
        free_gift_subscription_only: giftSubOnly,
        subscribe_discount_pct: subDiscount,
        available_frequencies: frequencies,
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

  const addFrequency = () => {
    const lastDays = frequencies.length > 0 ? frequencies[frequencies.length - 1].interval_days : 30;
    const days = lastDays + 30;
    setFrequencies([...frequencies, { interval_days: days, label: `Every ${days} days` }]);
  };

  const updateFrequency = (i: number, field: keyof Frequency, value: string | number | boolean) => {
    const next = [...frequencies];
    if (field === "default" && value) {
      // Only one default
      next.forEach((f, j) => { f.default = j === i; });
    } else {
      next[i] = { ...next[i], [field]: field === "interval_days" ? Number(value) : value };
    }
    setFrequencies(next);
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
            {rule.subscribe_discount_pct > 0 && ` · Subscribe save ${rule.subscribe_discount_pct}%`}
            {rule.free_shipping && (rule.free_shipping_subscription_only ? " · Sub free shipping" : " · Free shipping")}
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
        <div className="space-y-6 border-t border-zinc-200 p-4 dark:border-zinc-800">
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

          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Subscription</h4>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">Subscribe & Save discount (%)</span>
              <input
                type="number"
                value={subDiscount}
                onChange={(e) => setSubDiscount(Number(e.target.value))}
                placeholder="e.g. 25"
                className="w-32 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
              />
            </label>
            <div className="mt-3">
              <span className="mb-2 block text-xs text-zinc-500">Available frequencies</span>
              <div className="space-y-2">
                {frequencies.map((f, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input type="number" value={f.interval_days} onChange={(e) => updateFrequency(i, "interval_days", e.target.value)}
                      className="w-20 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" placeholder="Days" />
                    <span className="text-xs text-zinc-400">days</span>
                    <input value={f.label} onChange={(e) => updateFrequency(i, "label", e.target.value)}
                      className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" placeholder="Label (e.g. Every month)" />
                    <label className="flex items-center gap-1 text-xs text-zinc-500">
                      <input type="radio" name={`default-freq-${rule.id}`} checked={!!f.default} onChange={() => updateFrequency(i, "default", true)} />
                      Default
                    </label>
                    <button onClick={() => setFrequencies(frequencies.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-600">×</button>
                  </div>
                ))}
              </div>
              <button onClick={addFrequency} className="mt-2 text-xs font-medium text-indigo-500 hover:text-indigo-700">+ Add frequency</button>
            </div>
          </div>

          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Free Shipping</h4>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={freeShipping} onChange={e => setFreeShipping(e.target.checked)}
                className="rounded border-zinc-300 text-indigo-500" />
              <span className="text-sm text-zinc-700 dark:text-zinc-300">Offer free shipping</span>
            </label>
            {freeShipping && (
              <label className="ml-6 mt-2 flex items-center gap-2">
                <input type="checkbox" checked={freeShipSubOnly} onChange={(e) => setFreeShipSubOnly(e.target.checked)}
                  className="rounded border-zinc-300 text-indigo-500" />
                <span className="text-sm text-zinc-700 dark:text-zinc-300">Only when subscribing</span>
              </label>
            )}
            {!freeShipping && (
              <label className="mt-2 block">
                <span className="mb-1 block text-xs text-zinc-500">Or free shipping above ($)</span>
                <input type="number" value={freeShipThreshold} onChange={e => setFreeShipThreshold(e.target.value)}
                  placeholder="e.g. 99.00"
                  className="w-40 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" />
              </label>
            )}
          </div>

          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Free Gift</h4>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">Product / variant</span>
              <select
                value={giftVariantId}
                onChange={(e) => setGiftVariantId(e.target.value)}
                className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
              >
                <option value="">— None —</option>
                {variants.map((v) => {
                  const p = productById.get(v.product_id);
                  const label =
                    v.title && p && v.title !== p.title
                      ? `${p?.title} — ${v.title}`
                      : p?.title || v.title || v.id;
                  return (
                    <option key={v.id} value={v.id}>
                      {label}
                    </option>
                  );
                })}
              </select>
            </label>
            {giftVariantId && (
              <>
                <div className="mt-3 flex items-center gap-3 rounded border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-800">
                  {(giftVariant?.image_url || giftProduct?.image_url) && (
                    <img
                      src={giftVariant?.image_url || giftProduct?.image_url || ""}
                      alt=""
                      className="h-10 w-10 rounded object-cover"
                    />
                  )}
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">
                    {giftProduct?.title}
                    {giftVariant?.title && giftVariant.title !== giftProduct?.title && ` — ${giftVariant.title}`}
                  </span>
                </div>
                <label className="mt-3 flex items-center gap-2">
                  <span className="text-xs text-zinc-500">Min quantity to qualify:</span>
                  <input type="number" value={giftMinQty} onChange={e => setGiftMinQty(Number(e.target.value))}
                    className="w-16 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800" />
                </label>
                <label className="mt-2 flex items-center gap-2">
                  <input type="checkbox" checked={giftSubOnly} onChange={(e) => setGiftSubOnly(e.target.checked)}
                    className="rounded border-zinc-300 text-indigo-500" />
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">Only when subscribing</span>
                </label>
              </>
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
