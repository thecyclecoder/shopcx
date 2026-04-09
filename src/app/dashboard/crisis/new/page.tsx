"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

interface Variant {
  id: string;
  title: string;
  sku: string;
  price_cents: number;
  image_url: string | null;
}

interface Product {
  id: string;
  shopify_product_id: string;
  title: string;
  image_url: string | null;
  variants: Variant[];
}

interface CouponDetails {
  found: boolean;
  code: string;
  title: string;
  status: string;
  type: string;
  percentage: number | null;
  fixed_amount: string | null;
  summary: string;
}

export default function NewCrisisPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const isAdmin = workspace.role === "owner" || workspace.role === "admin";

  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);

  // Selections
  const [name, setName] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [affectedVariantId, setAffectedVariantId] = useState("");
  const [defaultSwapVariantId, setDefaultSwapVariantId] = useState("");
  const [flavorSwapVariantIds, setFlavorSwapVariantIds] = useState<Set<string>>(new Set());
  const [productSwapProductIds, setProductSwapProductIds] = useState<Set<string>>(new Set());

  // Coupon
  const [couponCode, setCouponCode] = useState("");
  const [couponVerifying, setCouponVerifying] = useState(false);
  const [couponDetails, setCouponDetails] = useState<CouponDetails | null>(null);
  const [couponError, setCouponError] = useState("");

  // Timing
  const [expectedRestockDate, setExpectedRestockDate] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState(7);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Fetch products
  const fetchProducts = useCallback(async () => {
    setLoadingProducts(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/products`);
    if (res.ok) {
      const data = await res.json();
      setProducts(data || []);
    }
    setLoadingProducts(false);
  }, [workspace.id]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <p className="text-zinc-400">Only admins and owners can create crisis events.</p>
        <Link href="/dashboard/crisis" className="mt-2 inline-block text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
          &larr; Back to Crisis Management
        </Link>
      </div>
    );
  }

  // Derived data
  const selectedProduct = products.find(p => p.id === selectedProductId);
  const selectedVariant = selectedProduct?.variants?.find(v => v.id === affectedVariantId);
  const siblingVariants = selectedProduct?.variants?.filter(v => v.id !== affectedVariantId) || [];
  const otherProducts = products.filter(p => p.id !== selectedProductId);

  // All product+variant combos as flat list for display
  const allVariants: { productId: string; productTitle: string; variant: Variant }[] = [];
  for (const p of products) {
    for (const v of (p.variants || [])) {
      allVariants.push({ productId: p.id, productTitle: p.title, variant: v });
    }
  }

  const handleSelectAffectedVariant = (variantId: string) => {
    setAffectedVariantId(variantId);
    // Find which product this variant belongs to
    for (const p of products) {
      if (p.variants?.some(v => v.id === variantId)) {
        setSelectedProductId(p.id);
        break;
      }
    }
    // Reset dependent selections
    setDefaultSwapVariantId("");
    setFlavorSwapVariantIds(new Set());
  };

  const toggleFlavorSwap = (variantId: string) => {
    setFlavorSwapVariantIds(prev => {
      const next = new Set(prev);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  };

  const toggleProductSwap = (productId: string) => {
    setProductSwapProductIds(prev => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const verifyCoupon = async () => {
    if (!couponCode.trim()) return;
    setCouponVerifying(true);
    setCouponError("");
    setCouponDetails(null);
    const res = await fetch(`/api/workspaces/${workspace.id}/crisis/coupon-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: couponCode.trim() }),
    });
    if (res.ok) {
      setCouponDetails(await res.json());
    } else {
      const data = await res.json();
      setCouponError(data.error || "Code not found in Shopify");
    }
    setCouponVerifying(false);
  };

  const handleSave = async () => {
    if (!name.trim()) { setError("Name is required."); return; }
    if (!affectedVariantId) { setError("Select an affected variant."); return; }

    setSaving(true);
    setError("");

    // Build flavor swaps from selected sibling variants
    const flavorSwaps = siblingVariants
      .filter(v => flavorSwapVariantIds.has(v.id))
      .map(v => ({ variantId: v.id, title: v.title }));

    // Build product swaps — store product-level info, system resolves variants at runtime
    const productSwaps = otherProducts
      .filter(p => productSwapProductIds.has(p.id))
      .map(p => ({
        productId: p.id,
        shopifyProductId: p.shopify_product_id,
        productTitle: p.title,
        // Include all variants for the journey builder to use
        variants: (p.variants || []).map(v => ({ variantId: v.id, title: v.title, sku: v.sku })),
      }));

    const defaultSwapVariant = siblingVariants.find(v => v.id === defaultSwapVariantId);

    const res = await fetch(`/api/workspaces/${workspace.id}/crisis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        affected_variant_id: affectedVariantId,
        affected_sku: selectedVariant?.sku || null,
        affected_product_title: selectedProduct
          ? `${selectedProduct.title}${selectedVariant?.title && selectedVariant.title !== "Default Title" ? ` — ${selectedVariant.title}` : ""}`
          : null,
        default_swap_variant_id: defaultSwapVariantId || null,
        default_swap_title: defaultSwapVariant?.title || null,
        available_flavor_swaps: flavorSwaps,
        available_product_swaps: productSwaps,
        tier2_coupon_code: couponDetails?.code || couponCode.trim() || null,
        tier2_coupon_percent: couponDetails?.percentage || 0,
        expected_restock_date: expectedRestockDate || null,
        lead_time_days: leadTimeDays,
        tier_wait_days: 0, // deprecated — uses response delay instead
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
  const selectClass = `${inputClass} appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2020%2020%22%20fill%3D%22%236b7280%22%3E%3Cpath%20fill-rule%3D%22evenodd%22%20d%3D%22M5.23%207.21a.75.75%200%20011.06.02L10%2011.168l3.71-3.938a.75.75%200%20111.08%201.04l-4.25%204.5a.75.75%200%2001-1.08%200l-4.25-4.5a.75.75%200%2001.02-1.06z%22%20clip-rule%3D%22evenodd%22%2F%3E%3C%2Fsvg%3E')] bg-[length:20px] bg-[right_8px_center] bg-no-repeat pr-10`;

  if (loadingProducts) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <p className="text-zinc-400">Loading products...</p>
      </div>
    );
  }

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
          <label className={labelClass}>Crisis Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Mixed Berry Out of Stock" className={inputClass} />
        </div>

        {/* ── Step 1: Affected Variant ── */}
        <div>
          <label className={labelClass}>Affected Variant</label>
          <select
            value={affectedVariantId}
            onChange={e => handleSelectAffectedVariant(e.target.value)}
            className={selectClass}
          >
            <option value="">Select the out-of-stock variant...</option>
            {allVariants.map(({ productTitle, variant }) => (
              <option key={variant.id} value={variant.id}>
                {productTitle}{variant.title !== "Default Title" ? ` — ${variant.title}` : ""}
                {variant.sku ? ` (${variant.sku})` : ""}
              </option>
            ))}
          </select>
          {selectedVariant && (
            <div className="mt-2 flex items-center gap-3 rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
              {selectedProduct?.image_url && (
                <img src={selectedProduct.image_url} alt="" className="h-10 w-10 rounded object-cover" />
              )}
              <div className="text-sm">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  {selectedProduct?.title}{selectedVariant.title !== "Default Title" ? ` — ${selectedVariant.title}` : ""}
                </p>
                <p className="text-xs text-zinc-400">
                  SKU: {selectedVariant.sku || "—"} &middot; Variant ID: {selectedVariant.id}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ── Step 2: Default Swap ── */}
        {affectedVariantId && siblingVariants.length > 0 && (
          <div>
            <label className={labelClass}>Default Flavor Swap</label>
            <p className="mb-1.5 text-xs text-zinc-400">Auto-swap affected customers to this flavor before they respond</p>
            <select
              value={defaultSwapVariantId}
              onChange={e => setDefaultSwapVariantId(e.target.value)}
              className={selectClass}
            >
              <option value="">Select default swap flavor...</option>
              {siblingVariants.map(v => (
                <option key={v.id} value={v.id}>
                  {v.title}{v.sku ? ` (${v.sku})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* ── Step 3: Flavor Swaps (Tier 1 options) ── */}
        {affectedVariantId && siblingVariants.length > 0 && (
          <div>
            <label className={labelClass}>Tier 1 — Available Flavor Swaps</label>
            <p className="mb-2 text-xs text-zinc-400">Other flavors the customer can choose from (same product, different variants)</p>
            <div className="space-y-1.5">
              {siblingVariants
                .filter(v => v.id !== defaultSwapVariantId)
                .map(v => (
                <label key={v.id} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <input
                    type="checkbox"
                    checked={flavorSwapVariantIds.has(v.id)}
                    onChange={() => toggleFlavorSwap(v.id)}
                    className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-600"
                  />
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">{v.title}</span>
                  {v.sku && <span className="text-xs text-zinc-400">({v.sku})</span>}
                </label>
              ))}
              {siblingVariants.filter(v => v.id !== defaultSwapVariantId).length === 0 && (
                <p className="text-xs text-zinc-400 italic">No other variants available (default swap is the only sibling)</p>
              )}
            </div>
          </div>
        )}

        {/* ── Step 4: Product Swaps (Tier 2 options) ── */}
        {affectedVariantId && (
          <div>
            <label className={labelClass}>Tier 2 — Available Product Swaps</label>
            <p className="mb-2 text-xs text-zinc-400">Different products the customer can switch to (all in-stock variants included automatically)</p>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {otherProducts.map(p => (
                <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <input
                    type="checkbox"
                    checked={productSwapProductIds.has(p.id)}
                    onChange={() => toggleProductSwap(p.id)}
                    className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-600"
                  />
                  {p.image_url && (
                    <img src={p.image_url} alt="" className="h-8 w-8 rounded object-cover" />
                  )}
                  <div>
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">{p.title}</span>
                    <span className="ml-2 text-xs text-zinc-400">{(p.variants || []).length} variant{(p.variants || []).length !== 1 ? "s" : ""}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 5: Coupon ── */}
        <div>
          <label className={labelClass}>Tier 2 Coupon Code</label>
          <p className="mb-1.5 text-xs text-zinc-400">Shopify discount code to apply when customer accepts a product swap</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={couponCode}
              onChange={e => { setCouponCode(e.target.value); setCouponDetails(null); setCouponError(""); }}
              onKeyDown={e => e.key === "Enter" && verifyCoupon()}
              placeholder="e.g. CRISIS20"
              className={inputClass}
            />
            <button
              onClick={verifyCoupon}
              disabled={couponVerifying || !couponCode.trim()}
              className="shrink-0 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 transition-colors dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {couponVerifying ? "Verifying..." : "Verify"}
            </button>
          </div>
          {couponError && (
            <p className="mt-1.5 text-sm text-red-600 dark:text-red-400">{couponError}</p>
          )}
          {couponDetails && (
            <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-900/20">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">{couponDetails.title}</p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">{couponDetails.summary}</p>
                </div>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                  couponDetails.status === "ACTIVE"
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                    : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                }`}>
                  {couponDetails.status}
                </span>
              </div>
              <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
                {couponDetails.type === "percentage" ? `${couponDetails.percentage}% off` :
                 couponDetails.type === "fixed_amount" ? `$${couponDetails.fixed_amount} off` :
                 couponDetails.type}
              </p>
            </div>
          )}
        </div>

        {/* ── Step 6: Timing ── */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Expected Restock Date</label>
            <input type="date" value={expectedRestockDate} onChange={e => setExpectedRestockDate(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Lead Time (days)</label>
            <input type="number" value={leadTimeDays} onChange={e => setLeadTimeDays(Number(e.target.value))} min={0} className={inputClass} />
            <p className="mt-1 text-xs text-zinc-400">Days before next billing to start outreach</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <Link href="/dashboard/crisis" className="rounded-md px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200">
            Cancel
          </Link>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim() || !affectedVariantId}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Creating..." : "Create Crisis"}
          </button>
        </div>
      </div>
    </div>
  );
}
