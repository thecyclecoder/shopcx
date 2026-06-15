"use client";

/**
 * Sticky jump-nav for the advertorial / before-after landers. 18% of PDP visitors
 * jump straight to pricing (matching observed behavior), and the best closers
 * (ingredients) are starved of reach — so the lander gives a persistent shortcut
 * to both. Scrolls to the reused PDP sections by their `data-section` id (so the
 * reused IngredientsSection / PriceTableSection stay untouched). The "See pricing"
 * button carries `data-cta-kind="scroll_to_price"` so StorefrontChapterTracker's
 * jump-aware logic credits the jump correctly.
 */
function scrollToSection(selector: string) {
  const el = document.querySelector(selector);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function StickyJumpNav() {
  return (
    <nav className="sticky top-0 z-30 w-full border-b border-zinc-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-5 py-2.5 md:px-8">
        <button
          type="button"
          onClick={() => scrollToSection('[data-section="ingredients"]')}
          data-cta="nav_ingredients"
          data-cta-kind="scroll"
          className="text-sm font-semibold text-zinc-700 underline-offset-4 hover:underline"
        >
          Ingredients
        </button>
        <button
          type="button"
          onClick={() => scrollToSection("#pricing")}
          data-cta="nav_pricing"
          data-cta-kind="scroll_to_price"
          style={{ backgroundColor: "var(--storefront-primary)", fontFamily: "var(--storefront-heading-font)" }}
          className="rounded-full px-5 py-2 text-sm font-extrabold uppercase tracking-wide text-white shadow-sm transition hover:brightness-110"
        >
          See pricing
        </button>
      </div>
    </nav>
  );
}
