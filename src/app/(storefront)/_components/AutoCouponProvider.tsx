"use client";

/**
 * AutoCouponProvider (storefront-mvp Phase 4f).
 *
 * Exposes the visitor's auto-applied popup coupon to the price tables so they
 * render POST-coupon pricing. The code lives in the (client-readable)
 * popup_coupon cookie and the owner in the httpOnly sx_customer cookie — and
 * neither carries the discount VALUE — so we ask /api/popup/active-offer, which
 * resolves + binds the coupon server-side and returns { code, type, value }.
 *
 * The page itself stays statically prerendered (no cookies() server-side) — this
 * is a CLIENT fetch after hydration, so SSG/edge caching is untouched.
 */
import { createContext, useContext, useEffect, useState } from "react";

export interface AutoCoupon {
  code: string;
  type: "percentage" | "fixed_amount";
  value: number;
}

const Ctx = createContext<AutoCoupon | null>(null);

export function useAutoCoupon(): AutoCoupon | null {
  return useContext(Ctx);
}

/** Apply the auto-coupon to a displayed price (cents). Percentage only affects
 *  display here; fixed-amount coupons don't reprice per-tier (they're whole-cart),
 *  so they pass through unchanged and only surface via the banner. */
export function applyAutoCoupon(cents: number, coupon: AutoCoupon | null): number {
  if (!coupon || coupon.type !== "percentage" || !cents) return cents;
  return Math.round(cents * (1 - Math.max(0, Math.min(100, coupon.value)) / 100));
}

export function AutoCouponProvider({ workspaceId, children }: { workspaceId: string; children: React.ReactNode }) {
  const [coupon, setCoupon] = useState<AutoCoupon | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    // Cheap gate: only call the resolver when the coupon cookie is present.
    if (!/(?:^|;\s*)popup_coupon=/.test(document.cookie)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/popup/active-offer?workspace_id=${encodeURIComponent(workspaceId)}`, {
          headers: { "Content-Type": "application/json" },
        });
        const data = (await res.json()) as Partial<AutoCoupon>;
        if (!cancelled && data && data.code && data.type && typeof data.value === "number") {
          setCoupon({ code: data.code, type: data.type, value: data.value });
        }
      } catch { /* no offer — tables render at normal pricing */ }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  return <Ctx.Provider value={coupon}>{children}</Ctx.Provider>;
}
