"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

type OfferKind = "physical" | "digital";
type OfferScope = "checkout_only" | "checkout_and_renewals";

interface OfferIncluded {
  ref_id: string;
  kind: OfferKind;
  quantity: number;
}

interface Offer {
  id: string;
  variant_id: string;
  name: string | null;
  included: OfferIncluded[];
  scope: OfferScope;
  overrides_pricing_rule_gifts: boolean;
  is_active: boolean;
}

interface Product {
  id: string;
  title: string;
  image_url: string | null;
}

interface Variant {
  id: string;
  product_id: string;
  title: string | null;
  sku: string | null;
  price_cents: number;
  image_url: string | null;
  position: number;
}

interface DigitalGood {
  id: string;
  name: string;
  type: string;
}

function isRealVariantTitle(t: string | null | undefined): boolean {
  if (!t) return false;
  return t.trim().toLowerCase() !== "default title";
}

export default function OffersPage() {
  const workspace = useWorkspace();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [digitalGoods, setDigitalGoods] = useState<DigitalGood[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/offers`);
    if (res.ok) {
      const data = await res.json();
      setOffers(data.offers || []);
      setProducts(data.products || []);
      setVariants(data.variants || []);
      setDigitalGoods(data.digital_goods || []);
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const variantById = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants]);

  const variantLabel = useCallback(
    (v: Variant) => {
      const p = productById.get(v.product_id);
      if (isRealVariantTitle(v.title) && p && v.title !== p.title) {
        return `${p.title} — ${v.title}`;
      }
      return p?.title || (isRealVariantTitle(v.title) ? String(v.title) : "") || v.id;
    },
    [productById],
  );

  const createOffer = async (variantId: string) => {
    setCreating(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: variantId,
        name: "New Offer",
        included: [],
        scope: "checkout_only",
        overrides_pricing_rule_gifts: false,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setEditingId(data.offer.id);
      await load();
    }
    setCreating(false);
  };

  const deleteOffer = async (id: string) => {
    if (!confirm("Delete this offer?")) return;
    await fetch(`/api/workspaces/${workspace.id}/offers/${id}`, { method: "DELETE" });
    await load();
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-screen-2xl px-4 py-6">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Offers</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Attach extra included products (physical or digital) to a variant. Sits beside pricing rules — overrides free_gift when the flag is set.
      </p>

      <div className="space-y-6">
        <NewOfferPicker
          variants={variants}
          variantLabel={variantLabel}
          onPick={createOffer}
          disabled={creating}
        />

        {offers.map((offer) => (
          <OfferCard
            key={offer.id}
            offer={offer}
            variants={variants}
            variantById={variantById}
            variantLabel={variantLabel}
            digitalGoods={digitalGoods}
            workspaceId={workspace.id}
            isEditing={editingId === offer.id}
            onEdit={() => setEditingId(editingId === offer.id ? null : offer.id)}
            onDelete={() => deleteOffer(offer.id)}
            onSaved={() => {
              load();
              setMessage("Saved");
              setTimeout(() => setMessage(null), 2000);
            }}
          />
        ))}

        {offers.length === 0 && (
          <div className="rounded-lg border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-500">
              No offers yet. Pick a variant above to attach included items.
            </p>
          </div>
        )}

        {message && <p className="text-sm text-green-600">{message}</p>}
      </div>
    </div>
  );
}

function NewOfferPicker({
  variants,
  variantLabel,
  onPick,
  disabled,
}: {
  variants: Variant[];
  variantLabel: (v: Variant) => string;
  onPick: (variantId: string) => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <span className="text-sm text-zinc-700 dark:text-zinc-300">New offer for variant:</span>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="min-w-[16rem] rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
      >
        <option value="">— Pick a variant —</option>
        {variants.map((v) => (
          <option key={v.id} value={v.id}>
            {variantLabel(v)}
          </option>
        ))}
      </select>
      <button
        onClick={() => {
          if (selected) onPick(selected);
        }}
        disabled={disabled || !selected}
        className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
      >
        + New Offer
      </button>
    </div>
  );
}

function OfferCard({
  offer,
  variants,
  variantById,
  variantLabel,
  digitalGoods,
  workspaceId,
  isEditing,
  onEdit,
  onDelete,
  onSaved,
}: {
  offer: Offer;
  variants: Variant[];
  variantById: Map<string, Variant>;
  variantLabel: (v: Variant) => string;
  digitalGoods: DigitalGood[];
  workspaceId: string;
  isEditing: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(offer.name || "");
  const [variantId, setVariantId] = useState(offer.variant_id);
  const [included, setIncluded] = useState<OfferIncluded[]>(offer.included || []);
  const [scope, setScope] = useState<OfferScope>(offer.scope);
  const [overridesGifts, setOverridesGifts] = useState(offer.overrides_pricing_rule_gifts);
  const [isActive, setIsActive] = useState(offer.is_active);
  const [saving, setSaving] = useState(false);

  const anchor = variantById.get(offer.variant_id);
  const anchorLabel = anchor ? variantLabel(anchor) : offer.variant_id;

  const save = async () => {
    setSaving(true);
    await fetch(`/api/workspaces/${workspaceId}/offers/${offer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        variant_id: variantId,
        included,
        scope,
        overrides_pricing_rule_gifts: overridesGifts,
        is_active: isActive,
      }),
    });
    setSaving(false);
    onSaved();
  };

  const addPhysical = () => {
    const first = variants[0];
    if (!first) return;
    setIncluded([...included, { ref_id: first.id, kind: "physical", quantity: 1 }]);
  };
  const addDigital = () => {
    const first = digitalGoods[0];
    if (!first) return;
    setIncluded([...included, { ref_id: first.id, kind: "digital", quantity: 1 }]);
  };
  const updateInc = (i: number, patch: Partial<OfferIncluded>) => {
    const next = [...included];
    next[i] = { ...next[i], ...patch };
    setIncluded(next);
  };
  const removeInc = (i: number) => setIncluded(included.filter((_, j) => j !== i));

  const summary = included.length
    ? `${included.length} included item${included.length !== 1 ? "s" : ""}`
    : "no items yet";

  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between p-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {offer.name || "(unnamed offer)"}
          </h3>
          <p className="truncate text-xs text-zinc-500">
            {anchorLabel} · {summary} · {offer.scope === "checkout_only" ? "checkout only" : "checkout + renewals"}
            {offer.overrides_pricing_rule_gifts && " · overrides free_gift"}
            {!offer.is_active && " · inactive"}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onEdit}
            className="rounded bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400"
          >
            {isEditing ? "Close" : "Edit"}
          </button>
          <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600">
            Delete
          </button>
        </div>
      </div>

      {isEditing && (
        <div className="space-y-6 border-t border-zinc-200 p-4 dark:border-zinc-800">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Variant</span>
            <select
              value={variantId}
              onChange={(e) => setVariantId(e.target.value)}
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            >
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {variantLabel(v)}
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className="mb-2 block text-xs font-medium text-zinc-500">Included items</span>
            <div className="space-y-2">
              {included.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={row.kind}
                    onChange={(e) => {
                      const nextKind = e.target.value === "digital" ? "digital" : "physical";
                      const nextRefList = nextKind === "physical" ? variants : digitalGoods;
                      updateInc(i, {
                        kind: nextKind,
                        ref_id: nextRefList[0]?.id || row.ref_id,
                      });
                    }}
                    className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                  >
                    <option value="physical">Physical</option>
                    <option value="digital">Digital</option>
                  </select>
                  <select
                    value={row.ref_id}
                    onChange={(e) => updateInc(i, { ref_id: e.target.value })}
                    className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                  >
                    {row.kind === "physical"
                      ? variants.map((v) => (
                          <option key={v.id} value={v.id}>
                            {variantLabel(v)}
                          </option>
                        ))
                      : digitalGoods.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name} ({d.type})
                          </option>
                        ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    value={row.quantity}
                    onChange={(e) => updateInc(i, { quantity: Math.max(1, Number(e.target.value) || 1) })}
                    className="w-16 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                  />
                  <button
                    onClick={() => removeInc(i)}
                    className="text-xs text-red-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-3">
              <button
                onClick={addPhysical}
                disabled={variants.length === 0}
                className="text-xs font-medium text-indigo-500 hover:text-indigo-700 disabled:opacity-50"
              >
                + Add physical
              </button>
              <button
                onClick={addDigital}
                disabled={digitalGoods.length === 0}
                className="text-xs font-medium text-indigo-500 hover:text-indigo-700 disabled:opacity-50"
              >
                + Add digital
              </button>
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Scope</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value === "checkout_and_renewals" ? "checkout_and_renewals" : "checkout_only")}
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            >
              <option value="checkout_only">Checkout only (strip at renewal)</option>
              <option value="checkout_and_renewals">Checkout AND renewals</option>
            </select>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={overridesGifts}
              onChange={(e) => setOverridesGifts(e.target.checked)}
              className="rounded border-zinc-300 text-indigo-500"
            />
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              Override pricing-rule free gift (this offer replaces the free_gift)
            </span>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-zinc-300 text-indigo-500"
            />
            <span className="text-sm text-zinc-700 dark:text-zinc-300">Active</span>
          </label>

          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Offer"}
          </button>
        </div>
      )}
    </div>
  );
}
