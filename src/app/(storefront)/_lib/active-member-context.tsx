"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type {
  LinkMember,
  PageData,
  PricingRule,
} from "./page-data";

/**
 * Shared state for the active link-group member across Hero + Price
 * Table. When the customer toggles the format pill in the hero, the
 * price table swaps to that member's pricing rule, base variant, and
 * cached Amazon price WITHOUT a page reload — each linked product's
 * data is already loaded server-side (see loadLinkGroup).
 *
 * `useActiveProductData` returns the effective slice for whatever's
 * currently active: the page's own data when active === current, else
 * the link-group member's slice. Components read from this hook
 * instead of `data.base_variant` / `data.pricing_rule` /
 * `data.amazon_price_cents` directly so they stay in sync with the
 * toggle.
 */

interface ActiveMemberContextValue {
  activeMemberId: string | null;
  setActiveMemberId: (id: string | null) => void;
}

const ActiveMemberContext = createContext<ActiveMemberContextValue | null>(null);

export function ActiveMemberProvider({
  initialMemberId,
  children,
}: {
  initialMemberId: string | null;
  children: React.ReactNode;
}) {
  const [activeMemberId, setActiveMemberId] = useState<string | null>(initialMemberId);
  const value = useMemo(
    () => ({ activeMemberId, setActiveMemberId }),
    [activeMemberId],
  );
  return (
    <ActiveMemberContext.Provider value={value}>
      {children}
    </ActiveMemberContext.Provider>
  );
}

export function useActiveMember(data: PageData): {
  activeMember: LinkMember | null;
  isViewingCurrent: boolean;
  setActiveMemberId: (id: string | null) => void;
} {
  const ctx = useContext(ActiveMemberContext);
  const members = data.link_group?.members || [];
  const activeMember =
    (ctx?.activeMemberId
      ? members.find((m) => m.member_id === ctx.activeMemberId)
      : null) || null;
  const isViewingCurrent = !activeMember || activeMember.is_current;
  return {
    activeMember,
    isViewingCurrent,
    setActiveMemberId: ctx?.setActiveMemberId || (() => {}),
  };
}

/**
 * Returns the data slice the price table should render against. When
 * the active member is the current page's product (or there's no
 * active member), uses the page-data fields directly. When the
 * customer has toggled to a sibling member, returns that member's
 * stored slice.
 */
export function useActiveProductData(data: PageData): {
  baseVariant: PageData["base_variant"];
  pricingRule: PricingRule | null;
  amazonPriceCents: number | null;
  productHandle: string;
} {
  const { activeMember, isViewingCurrent } = useActiveMember(data);

  return useMemo(() => {
    if (isViewingCurrent || !activeMember) {
      return {
        baseVariant: data.base_variant,
        pricingRule: data.pricing_rule,
        amazonPriceCents: data.amazon_price_cents,
        productHandle: data.product.handle,
      };
    }
    return {
      baseVariant: activeMember.primary_variant_price_cents != null
        ? {
            shopify_variant_id: activeMember.primary_variant_shopify_id,
            price_cents: activeMember.primary_variant_price_cents,
            image_url: activeMember.primary_variant_image_url,
            servings: activeMember.primary_variant_servings,
            servings_unit: activeMember.primary_variant_servings_unit,
          }
        : null,
      pricingRule: activeMember.pricing_rule,
      amazonPriceCents: activeMember.amazon_price_cents,
      productHandle: activeMember.product_handle,
    };
  }, [activeMember, isViewingCurrent, data]);
}
