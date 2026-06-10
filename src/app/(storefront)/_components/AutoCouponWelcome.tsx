"use client";

/**
 * AutoCouponWelcome (storefront-mvp Phase 4f).
 *
 * Celebratory arrival modal shown when a visitor lands via a coupon redeem link
 * (/api/popup/land → redirects with ?applied=1). Confirms the discount is
 * already applied and sends them straight to the pack-selection chapter. Shows
 * once per session — we strip the ?applied param after showing so a refresh
 * doesn't re-trigger it. Renders nothing until the bound offer resolves
 * (useAutoCoupon), so the headline can name the exact discount.
 */
import { useEffect, useState } from "react";
import { useAutoCoupon } from "./AutoCouponProvider";

const SESSION_FLAG = "shopcx_coupon_welcomed";

export function AutoCouponWelcome() {
  const coupon = useAutoCoupon();
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  // Fade out, then unmount — lets the pricing chapter be revealed behind it as
  // it scrolls. `scrollFirst` kicks the smooth-scroll the instant the fade
  // begins so the motion and the reveal happen together.
  function dismiss(scrollFirst = false) {
    if (scrollFirst) {
      const el = document.querySelector("#pricing, [data-section='pricing']");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setClosing(true);
    window.setTimeout(() => setOpen(false), 320);
  }

  // Arm once on mount if we arrived via a coupon link and haven't celebrated yet.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("applied") !== "1") return;
    if (sessionStorage.getItem(SESSION_FLAG) === "1") {
      // Already shown — just clean the URL.
      params.delete("applied");
      const qs = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
      return;
    }
    setArmed(true);
  }, []);

  // Open once the bound offer has resolved (so we can name the discount).
  useEffect(() => {
    if (!armed || !coupon || open) return;
    setOpen(true);
    sessionStorage.setItem(SESSION_FLAG, "1");
    const params = new URLSearchParams(window.location.search);
    params.delete("applied");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
  }, [armed, coupon, open]);

  if (!open || !coupon) return null;

  const label =
    coupon.type === "percentage"
      ? `${coupon.value}% off`
      : `$${(coupon.value / 100).toFixed(0)} off`;

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-end justify-center p-0 transition-opacity duration-300 ease-out sm:items-center sm:p-4 ${closing ? "bg-black/0 opacity-0" : "bg-black/50 opacity-100"}`}
      onClick={() => dismiss(false)}
    >
      <div
        className={`relative w-full max-w-sm overflow-hidden rounded-t-2xl bg-white text-center shadow-2xl transition-all duration-300 ease-out sm:rounded-2xl ${closing ? "translate-y-2 opacity-0 sm:translate-y-0 sm:scale-95" : "translate-y-0 opacity-100 sm:scale-100"}`}
        onClick={(e) => e.stopPropagation()}
        style={{ "--p": "var(--storefront-primary, #1f5e3a)" } as React.CSSProperties}
      >
        <button
          onClick={() => dismiss(false)}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/10 text-zinc-600 hover:bg-black/20"
        >
          ×
        </button>

        <div
          className="px-6 pb-5 pt-8 text-white"
          style={{ background: "linear-gradient(135deg, var(--storefront-primary,#1f5e3a), color-mix(in srgb, var(--storefront-primary,#1f5e3a), black 25%))" }}
        >
          <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-white/20 text-4xl" aria-hidden>
            🎉
          </div>
          <h2 className="text-2xl font-extrabold leading-tight">Your {label} is applied!</h2>
          <p className="mt-1 text-sm text-white/90">It's locked to your order automatically — just pick the pack you want and you'll see the discount at checkout.</p>
        </div>

        <div className="px-6 pb-7 pt-5">
          <button
            onClick={() => dismiss(true)}
            className="w-full rounded-xl py-3.5 text-base font-bold text-white"
            style={{ backgroundColor: "var(--storefront-primary,#1f5e3a)" }}
          >
            Choose my pack →
          </button>
          <button
            onClick={() => dismiss(false)}
            className="mt-2 w-full rounded-xl border border-zinc-300 py-3 text-base font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
