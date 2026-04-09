"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

export default function NewCrisisPage() {
  const workspace = useWorkspace();
  const router = useRouter();

  const [name, setName] = useState("");
  const [affectedVariantId, setAffectedVariantId] = useState("");
  const [affectedSku, setAffectedSku] = useState("");
  const [affectedProductTitle, setAffectedProductTitle] = useState("");
  const [defaultSwapVariantId, setDefaultSwapVariantId] = useState("");
  const [defaultSwapTitle, setDefaultSwapTitle] = useState("");
  const [flavorSwapsJson, setFlavorSwapsJson] = useState("[]");
  const [productSwapsJson, setProductSwapsJson] = useState("[]");
  const [tier2CouponCode, setTier2CouponCode] = useState("");
  const [tier2CouponPercent, setTier2CouponPercent] = useState(20);
  const [expectedRestockDate, setExpectedRestockDate] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState(7);
  const [tierWaitDays, setTierWaitDays] = useState(3);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!name.trim() || !affectedVariantId.trim()) {
      setError("Name and affected variant ID are required.");
      return;
    }

    // Validate JSON
    let flavorSwaps: unknown[];
    let productSwaps: unknown[];
    try {
      flavorSwaps = JSON.parse(flavorSwapsJson);
      if (!Array.isArray(flavorSwaps)) throw new Error("Must be an array");
    } catch {
      setError("Available flavor swaps must be valid JSON array.");
      return;
    }
    try {
      productSwaps = JSON.parse(productSwapsJson);
      if (!Array.isArray(productSwaps)) throw new Error("Must be an array");
    } catch {
      setError("Available product swaps must be valid JSON array.");
      return;
    }

    setSaving(true);
    setError("");

    const res = await fetch(`/api/workspaces/${workspace.id}/crisis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        affected_variant_id: affectedVariantId.trim(),
        affected_sku: affectedSku.trim() || null,
        affected_product_title: affectedProductTitle.trim() || null,
        default_swap_variant_id: defaultSwapVariantId.trim() || null,
        default_swap_title: defaultSwapTitle.trim() || null,
        available_flavor_swaps: flavorSwaps,
        available_product_swaps: productSwaps,
        tier2_coupon_code: tier2CouponCode.trim() || null,
        tier2_coupon_percent: tier2CouponPercent,
        expected_restock_date: expectedRestockDate || null,
        lead_time_days: leadTimeDays,
        tier_wait_days: tierWaitDays,
      }),
    });

    if (res.ok) {
      const crisis = await res.json();
      router.push(`/dashboard/crisis/${crisis.id}`);
    } else {
      const data = await res.json();
      setError(data.error || "Failed to create crisis event");
    }
    setSaving(false);
  };

  const inputClass = "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder:text-zinc-500";
  const labelClass = "block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1";

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <Link href="/dashboard/crisis" className="text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
          &larr; Back to Crisis Management
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">New Crisis Event</h1>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Name */}
        <div>
          <label className={labelClass}>Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Mixed Berry Out of Stock" className={inputClass} />
        </div>

        {/* Affected variant */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Affected Variant ID</label>
            <input type="text" value={affectedVariantId} onChange={e => setAffectedVariantId(e.target.value)} placeholder="Shopify variant ID" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Affected SKU</label>
            <input type="text" value={affectedSku} onChange={e => setAffectedSku(e.target.value)} placeholder="e.g. SC-TABS-BERRY" className={inputClass} />
          </div>
        </div>

        <div>
          <label className={labelClass}>Affected Product Title</label>
          <input type="text" value={affectedProductTitle} onChange={e => setAffectedProductTitle(e.target.value)} placeholder="e.g. Superfood Tabs -- Mixed Berry" className={inputClass} />
        </div>

        {/* Default swap */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Default Swap Variant ID</label>
            <input type="text" value={defaultSwapVariantId} onChange={e => setDefaultSwapVariantId(e.target.value)} placeholder="Auto-swap to this variant" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Default Swap Title</label>
            <input type="text" value={defaultSwapTitle} onChange={e => setDefaultSwapTitle(e.target.value)} placeholder="e.g. Strawberry Lemonade" className={inputClass} />
          </div>
        </div>

        {/* Flavor swaps JSON */}
        <div>
          <label className={labelClass}>Available Flavor Swaps (JSON)</label>
          <textarea
            value={flavorSwapsJson}
            onChange={e => setFlavorSwapsJson(e.target.value)}
            placeholder='[{"variantId": "...", "title": "Strawberry Lemonade"}]'
            rows={3}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-zinc-400">Array of {`{variantId, title}`} objects for Tier 1 journey</p>
        </div>

        {/* Product swaps JSON */}
        <div>
          <label className={labelClass}>Available Product Swaps (JSON)</label>
          <textarea
            value={productSwapsJson}
            onChange={e => setProductSwapsJson(e.target.value)}
            placeholder='[{"variantId": "...", "title": "...", "productTitle": "..."}]'
            rows={3}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-zinc-400">Array of {`{variantId, title, productTitle}`} objects for Tier 2 journey</p>
        </div>

        {/* Coupon */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Tier 2 Coupon Code</label>
            <input type="text" value={tier2CouponCode} onChange={e => setTier2CouponCode(e.target.value)} placeholder="Shopify coupon code" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Tier 2 Coupon %</label>
            <input type="number" value={tier2CouponPercent} onChange={e => setTier2CouponPercent(Number(e.target.value))} min={0} max={100} className={inputClass} />
          </div>
        </div>

        {/* Timing */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className={labelClass}>Expected Restock Date</label>
            <input type="date" value={expectedRestockDate} onChange={e => setExpectedRestockDate(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Lead Time Days</label>
            <input type="number" value={leadTimeDays} onChange={e => setLeadTimeDays(Number(e.target.value))} min={0} className={inputClass} />
            <p className="mt-1 text-xs text-zinc-400">Days before billing to send Tier 1</p>
          </div>
          <div>
            <label className={labelClass}>Tier Wait Days</label>
            <input type="number" value={tierWaitDays} onChange={e => setTierWaitDays(Number(e.target.value))} min={1} className={inputClass} />
            <p className="mt-1 text-xs text-zinc-400">Days between tier escalations</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <Link href="/dashboard/crisis" className="rounded-md px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200">
            Cancel
          </Link>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Creating..." : "Create Crisis"}
          </button>
        </div>
      </div>
    </div>
  );
}
