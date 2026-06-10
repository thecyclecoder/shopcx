"use client";

/**
 * AutoCouponBanner — the "you have an extra discount applied" notice that sits
 * by the price tables when the visitor has an auto-applied popup coupon
 * (storefront-mvp Phase 4f). Renders nothing when there's no active offer.
 */
import type { AutoCoupon } from "./AutoCouponProvider";

export function AutoCouponBanner({ coupon, className }: { coupon: AutoCoupon | null; className?: string }) {
  if (!coupon) return null;
  const label =
    coupon.type === "percentage"
      ? `An extra ${coupon.value}% off is applied`
      : `An extra $${(coupon.value / 100).toFixed(0)} off is applied`;
  return (
    <div
      className={`mx-auto flex max-w-2xl items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-center text-sm font-bold text-white shadow-sm sm:text-base ${className || ""}`}
    >
      <span aria-hidden="true">🎉</span>
      <span>
        {label} — <span className="underline decoration-white/50">prices below already reflect it</span>
      </span>
    </div>
  );
}
