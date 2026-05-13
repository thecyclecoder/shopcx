"use client";

import { useEffect, useMemo, useState } from "react";
import type { PageData } from "../_lib/page-data";
import {
  useActiveMember,
  useActiveProductData,
} from "../_lib/active-member-context";
import { SupplementFactsPanel } from "../_components/SupplementFactsPanel";

/**
 * Right-column block in the FAQ section: a single variant dropdown
 * that spans every linked product (Instant Cocoa, Instant Hazelnut,
 * K-Cups Cocoa, etc), plus the CSS-rendered SupplementFactsPanel.
 *
 * The dropdown is unified across linked products so a customer
 * shopping Amazing Coffee Instant can peek at K-Cups facts (or any
 * sibling format) without leaving the page. Selecting a variant whose
 * parent product differs from the active link-group member writes to
 * the shared active-member context — so the hero, price table, and
 * any other format-toggled surface stay in sync.
 *
 * Labels collapse to just the variant title when there's a single
 * product in the link group, and expand to "Format — Variant" when
 * there are multiple (so customers can tell K-Cups Cocoa from Instant
 * Cocoa). "Default Title" placeholders (Shopify auto-name) are
 * stripped so a single-variant K-Cups product reads cleanly as just
 * its product name.
 */
export function SupplementFactsSection({ data }: { data: PageData }) {
  const { setActiveMemberId } = useActiveMember(data);
  const { productHandle } = useActiveProductData(data);

  // All variants with facts across the link group (plus current product
  // if no group). Sorted: current product first, then by position.
  const allVariants = useMemo(() => {
    return data.variants_with_facts.slice().sort((a, b) => {
      if (a.product_id === data.product.id && b.product_id !== data.product.id)
        return -1;
      if (b.product_id === data.product.id && a.product_id !== data.product.id)
        return 1;
      return a.position - b.position;
    });
  }, [data.variants_with_facts, data.product.id]);

  // Map each variant_id → display label. When multiple products exist
  // in the group, prefix with the product title for disambiguation.
  const productById = useMemo(() => {
    const m = new Map<string, string>();
    m.set(data.product.id, data.product.title);
    for (const member of data.link_group?.members || []) {
      m.set(member.product_id, member.product_title);
    }
    return m;
  }, [data.product.id, data.product.title, data.link_group]);

  const hasMultipleProducts = (data.link_group?.members.length || 1) > 1;

  const labelFor = (variantId: string): string => {
    const v = allVariants.find((x) => x.variant_id === variantId);
    if (!v) return "";
    const variantTitleClean = (v.variant_title || "").trim();
    const isDefaultPlaceholder =
      variantTitleClean.toLowerCase() === "default title" ||
      !variantTitleClean;
    if (hasMultipleProducts) {
      const product = productById.get(v.product_id) || "";
      return isDefaultPlaceholder
        ? product
        : `${product} — ${variantTitleClean}`;
    }
    return isDefaultPlaceholder ? productById.get(v.product_id) || "" : variantTitleClean;
  };

  // Default selection = the first variant of the active product (the
  // one that matches whatever the hero/price-table is currently
  // showing). Snaps automatically when active member changes.
  const activeProductId = useMemo(() => {
    if (data.product.handle === productHandle) return data.product.id;
    const member = data.link_group?.members.find(
      (m) => m.product_handle === productHandle,
    );
    return member?.product_id ?? data.product.id;
  }, [data, productHandle]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Default + auto-sync the selection to the active product. If the
  // user manually picks a variant we honor it; when the active
  // product changes (format toggle elsewhere) we snap to that
  // product's first variant.
  useEffect(() => {
    const current = allVariants.find((v) => v.variant_id === selectedId);
    if (current && current.product_id === activeProductId) return;
    const firstOfActive = allVariants.find(
      (v) => v.product_id === activeProductId,
    );
    setSelectedId(firstOfActive?.variant_id || allVariants[0]?.variant_id || null);
  }, [activeProductId, allVariants, selectedId]);

  const selectedVariant = allVariants.find(
    (v) => v.variant_id === selectedId,
  );

  if (!selectedVariant || !selectedVariant.supplement_facts) return null;

  const handleChange = (newVariantId: string) => {
    setSelectedId(newVariantId);
    // Sync the rest of the page when the customer picks a variant
    // from a different product than the currently-active one.
    const picked = allVariants.find((v) => v.variant_id === newVariantId);
    if (!picked || picked.product_id === activeProductId) return;
    const targetMember = data.link_group?.members.find(
      (m) => m.product_id === picked.product_id,
    );
    if (targetMember) setActiveMemberId(targetMember.member_id);
  };

  return (
    <div className="w-full">
      {allVariants.length > 1 && (
        <label className="mb-3 block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-zinc-500">
            {hasMultipleProducts ? "Format / Flavor" : "Flavor"}
          </span>
          <select
            value={selectedId || ""}
            onChange={(e) => handleChange(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          >
            {allVariants.map((v) => (
              <option key={v.variant_id} value={v.variant_id}>
                {labelFor(v.variant_id)}
              </option>
            ))}
          </select>
        </label>
      )}
      <SupplementFactsPanel facts={selectedVariant.supplement_facts} />
    </div>
  );
}
