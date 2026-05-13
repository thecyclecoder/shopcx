"use client";

import { useMemo, useState } from "react";
import type { PageData } from "../_lib/page-data";
import { useActiveProductData } from "../_lib/active-member-context";
import { SupplementFactsPanel } from "../_components/SupplementFactsPanel";

/**
 * Right-column block in the FAQ section: a variant selector +
 * SupplementFactsPanel. Filters PageData.variants_with_facts down to
 * the active product so when the customer toggles between Instant ↔
 * K-Cups in the hero / price table, this panel also swaps its
 * available variants. Renders nothing when the active product has no
 * variants with facts populated.
 *
 * The variant select is a native <select> for accessibility +
 * keyboard handling. Defaults to the first variant in position order.
 */
export function SupplementFactsSection({ data }: { data: PageData }) {
  const { productHandle } = useActiveProductData(data);

  // Resolve which product's variants to show based on the active
  // product. Map handle → product_id once, then filter facts list.
  const activeProductId = useMemo(() => {
    if (data.product.handle === productHandle) return data.product.id;
    const member = data.link_group?.members.find(
      (m) => m.product_handle === productHandle,
    );
    return member?.product_id ?? data.product.id;
  }, [data, productHandle]);

  const variants = useMemo(
    () =>
      data.variants_with_facts.filter((v) => v.product_id === activeProductId),
    [data.variants_with_facts, activeProductId],
  );

  const [selectedId, setSelectedId] = useState<string | null>(
    variants[0]?.variant_id ?? null,
  );

  // When the active product changes (format toggle) the previously-
  // selected variant id won't be in the new list. Snap to the first
  // available variant for the new product.
  const effectiveSelectedId = useMemo(() => {
    if (selectedId && variants.some((v) => v.variant_id === selectedId)) {
      return selectedId;
    }
    return variants[0]?.variant_id ?? null;
  }, [selectedId, variants]);

  const selectedVariant = variants.find(
    (v) => v.variant_id === effectiveSelectedId,
  );
  if (!selectedVariant || !selectedVariant.supplement_facts) return null;

  return (
    <div className="w-full">
      {variants.length > 1 && (
        <label className="mb-3 block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Flavor
          </span>
          <select
            value={effectiveSelectedId || ""}
            onChange={(e) => setSelectedId(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          >
            {variants.map((v) => (
              <option key={v.variant_id} value={v.variant_id}>
                {v.variant_title || "Default"}
              </option>
            ))}
          </select>
        </label>
      )}
      <SupplementFactsPanel facts={selectedVariant.supplement_facts} />
    </div>
  );
}
