"use client";

import { useEffect, useState } from "react";
import type { PageData } from "../_lib/page-data";

/**
 * Slim sticky bar that appears on mobile after the hero has scrolled
 * past. Dismissible (persists in sessionStorage for the tab). Hidden
 * on md+ where the sticky hero CTA is visually close enough.
 */
export function StickyMobileCTA({ data }: { data: PageData }) {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (sessionStorage.getItem("storefront:cta-dismissed") === "1") {
        setDismissed(true);
        return;
      }
    } catch {
      /* no-op */
    }

    const onScroll = () => {
      setVisible(window.scrollY > 360);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (dismissed) return null;

  const lowestPrice = data.pricing_tiers.length
    ? Math.min(
        ...data.pricing_tiers.map(
          (t) => t.subscribe_price_cents ?? t.price_cents,
        ),
      )
    : null;

  return (
    <div
      aria-hidden={!visible}
      className={`fixed inset-x-0 bottom-0 z-50 border-t border-zinc-200 bg-white shadow-[0_-6px_16px_-8px_rgba(0,0,0,0.15)] transition-transform duration-200 md:hidden ${
        visible ? "translate-y-0" : "translate-y-full"
      }`}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-zinc-900">
            {data.product.title}
          </span>
          {lowestPrice != null && (
            <span className="text-xs text-zinc-500">
              From ${(lowestPrice / 100).toFixed(2)}
            </span>
          )}
        </div>
        <a
          href="#pricing"
          style={{ backgroundColor: "var(--storefront-primary)" }}
          className="inline-flex h-11 flex-shrink-0 items-center justify-center rounded-full px-5 text-sm font-semibold text-white"
        >
          Order now
        </a>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            try {
              sessionStorage.setItem("storefront:cta-dismissed", "1");
            } catch {
              /* no-op */
            }
            setDismissed(true);
          }}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-zinc-400 hover:text-zinc-700"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
