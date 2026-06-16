"use client";

/**
 * Sticky top bar above the PDP header. Two states:
 *
 *  1. Resting (no in-flight cart) — a calm trust bar:
 *     "Love It in 30 Days or Your Money Back." Tapping it opens a
 *     money-back-guarantee modal (a trust seal + reassuring copy)
 *     aimed at warming up the 50+ crowd before they buy. This state
 *     renders in the SSG payload (no cookies/cart needed), so it's
 *     visible instantly with no flash.
 *
 *  2. Cart upgrade — when an open cart_draft exists (customer started
 *     a customize flow then came back to the PDP), the bar upgrades to
 *     "Complete your order — you'll save $X" with a one-tap path back.
 *     Dismissing it falls back to the resting trust bar.
 *
 * The cart check mounts client-side and fetches /api/cart, keeping the
 * personalized state out of the SSG'd HTML.
 */
import { useEffect, useState } from "react";
import { GuaranteeSeal } from "./GuaranteeSeal";
import { ShieldIcon } from "./TrustBadge";

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

export function CompleteOrderBanner({ guaranteeCopy }: { guaranteeCopy?: string | null }) {
  const [cart, setCart] = useState<CartShape | null>(null);
  const [cartDismissed, setCartDismissed] = useState(false);
  const [showGuarantee, setShowGuarantee] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("dismiss_cart_banner") === "1") setCartDismissed(true);
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

  // Lock background scroll + wire Escape while the modal is open.
  useEffect(() => {
    if (!showGuarantee) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowGuarantee(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [showGuarantee]);

  const showCart = !!cart && !cartDismissed;

  return (
    <>
      <div className="sticky top-0 z-20 w-full bg-gradient-to-r from-emerald-600 via-emerald-600 to-teal-700 text-white shadow-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          {showCart ? (
            <CartContent cart={cart!} onDismiss={() => {
              try { sessionStorage.setItem("dismiss_cart_banner", "1"); } catch { /* ignore */ }
              setCartDismissed(true);
            }} />
          ) : (
            <button
              type="button"
              onClick={() => setShowGuarantee(true)}
              className="flex flex-1 items-center justify-center gap-2.5 text-sm hover:opacity-90 sm:justify-start"
            >
              <ShieldIcon size={18} />
              <span className="font-extrabold">Love It in 30 Days or Your Money Back.</span>
              <span className="ml-auto hidden whitespace-nowrap text-sm font-bold tracking-wide underline-offset-2 hover:underline sm:inline">
                Learn more →
              </span>
            </button>
          )}
        </div>
      </div>

      {showGuarantee && (
        <GuaranteeModal copy={guaranteeCopy} onClose={() => setShowGuarantee(false)} />
      )}
    </>
  );
}

function CartContent({ cart, onDismiss }: { cart: CartShape; onDismiss: () => void }) {
  // "You'll save" math mirrors the cart's strikethrough logic so the
  // amount here == the amount on the checkout page totals.
  const msrpSubtotal = cart.line_items.reduce((s, l) => {
    const msrp = l.unit_msrp_cents || l.unit_price_cents || 0;
    return s + msrp * l.quantity;
  }, 0);
  const savedCents = Math.max(0, msrpSubtotal - cart.subtotal_cents);

  return (
    <>
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
        <span className="whitespace-nowrap text-sm font-bold tracking-wide sm:hidden">→</span>
      </a>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-1 rounded-md p-1 text-emerald-100 hover:bg-white/10 hover:text-white"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </>
  );
}

const DEFAULT_GUARANTEE_COPY =
  "Try it for a full 30 days. If you don't love how you feel, just reach out — we'll refund every penny. No forms, no hoops, and no hard feelings.";

function GuaranteeModal({ copy, onClose }: { copy?: string | null; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="30-day money-back guarantee"
        className="relative w-full max-w-md overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/10 text-lg leading-none text-zinc-600 hover:bg-black/20"
        >
          ×
        </button>

        <div className="flex flex-col items-center px-6 pb-7 pt-8 text-center">
          <GuaranteeSeal size={148} />
          <h2 className="mt-4 text-2xl font-extrabold leading-tight text-zinc-900">
            Love It in 30 Days
            <br />
            or Your Money Back
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
            {copy || DEFAULT_GUARANTEE_COPY}
          </p>

          <ul className="mt-5 w-full space-y-2.5 text-left">
            {[
              "A full 30 days to decide — no rush.",
              "Refund with no questions asked.",
              "A real person helps you, by phone or email.",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-[15px] text-zinc-700">
                <span className="mt-0.5 flex-shrink-0 text-emerald-600">
                  <ShieldIcon size={18} />
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>

          <button
            onClick={onClose}
            className="mt-6 w-full rounded-xl py-3 text-base font-bold text-white"
            style={{ backgroundColor: "var(--storefront-primary,#1f5e3a)" }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
