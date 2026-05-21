"use client";

/**
 * "Complete your order" banner.
 *
 * Shows above the PDP header when an in-flight cart_draft exists
 * (customer started a customize flow, then navigated back to the
 * PDP — instead of making them re-pick a bundle, give them a
 * one-tap path back to where they were, with the savings amount
 * front-and-center so the path back feels like a win.
 *
 * SSG-safe: the PDP route is statically rendered and explicitly
 * does NOT read cookies. This component mounts client-side and
 * fetches /api/cart, so the banner stays out of the SSG payload.
 * Returns null until we know there's a cart to surface.
 */
import { useEffect, useState } from "react";

interface CartLine {
  unit_price_cents: number;
  unit_msrp_cents?: number;
  line_total_cents: number;
  quantity: number;
  mode?: "subscribe" | "onetime";
  is_gift?: boolean;
}
interface CartShape {
  token: string;
  status: string;
  line_items: CartLine[];
  subtotal_cents: number;
}

export function CompleteOrderBanner() {
  const [cart, setCart] = useState<CartShape | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("dismiss_cart_banner") === "1") {
        setDismissed(true);
        return;
      }
    } catch { /* ignore */ }

    let abort = false;
    fetch("/api/cart", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (abort) return;
        const c = d?.cart;
        if (!c || c.status !== "open" || !Array.isArray(c.line_items) || c.line_items.length === 0) return;
        setCart(c as CartShape);
      })
      .catch(() => { /* non-fatal */ });
    return () => { abort = true; };
  }, []);

  if (dismissed || !cart) return null;

  // "You'll save" math mirrors the cart's strikethrough logic so the
  // amount the customer sees in the banner == the amount on the
  // checkout page totals. Includes MSRP gap + gift value (the gift
  // line carries unit_msrp but unit_price=0). Shipping savings are
  // intentionally NOT included here — they require knowing the
  // workspace's onetime_economy rate, which we don't want to fetch
  // on the SSG'd PDP. The banner motivation is "lock in the cart you
  // already built", not exact-to-the-penny savings — the figure here
  // is conservative.
  const msrpSubtotal = cart.line_items.reduce((s, l) => {
    const msrp = l.unit_msrp_cents || l.unit_price_cents || 0;
    return s + msrp * l.quantity;
  }, 0);
  const savedCents = Math.max(0, msrpSubtotal - cart.subtotal_cents);

  return (
    <div className="sticky top-0 z-20 w-full bg-gradient-to-r from-emerald-600 via-emerald-600 to-teal-700 text-white shadow-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <a
          href={`/customize?token=${encodeURIComponent(cart.token)}`}
          className="flex flex-1 items-center gap-2.5 text-sm hover:opacity-90"
        >
          <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l1 12h12l1-9H6m12 9a1 1 0 100 2 1 1 0 000-2zm-9 0a1 1 0 100 2 1 1 0 000-2z" />
          </svg>
          <div className="flex-1 truncate">
            <span className="font-extrabold">Complete your order</span>
            {savedCents > 0 && (
              <span className="ml-1.5 hidden text-emerald-100 sm:inline">
                — you&apos;ll save ${(savedCents / 100).toFixed(2)}
              </span>
            )}
          </div>
          <span className="hidden whitespace-nowrap text-sm font-bold tracking-wide sm:inline">
            Pick up where you left off →
          </span>
          <span className="whitespace-nowrap text-sm font-bold tracking-wide sm:hidden">
            →
          </span>
        </a>
        <button
          type="button"
          onClick={() => {
            try { sessionStorage.setItem("dismiss_cart_banner", "1"); } catch { /* ignore */ }
            setDismissed(true);
          }}
          aria-label="Dismiss"
          className="-mr-1 rounded-md p-1 text-emerald-100 hover:bg-white/10 hover:text-white"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
