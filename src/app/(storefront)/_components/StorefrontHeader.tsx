"use client";

import { useEffect, useState } from "react";
import { ChatOverlay } from "./ChatOverlay";

interface StorefrontHeaderProps {
  workspaceId: string;
  productId: string;        // internal UUID
  productHandle: string;
  productTitle: string;
  headerText?: string | null;       // custom wordmark; falls back to productTitle
  headerColor?: string | null;      // hex
  headerWeight?: string | null;     // numeric weight like "700" — must be a preloaded weight on the workspace font
}

/**
 * Fixed top header for the storefront PDP.
 *
 * - Product-branded: shows the product title as the wordmark, not the
 *   company name. Customer is here for the product.
 * - Hamburger button (left) — menu items wired up later.
 * - Chat icon (right) — opens the chat widget overlay with this product's
 *   context preloaded (KB articles surface featured-first; if the customer
 *   starts a live chat, Sonnet sees the product they're on).
 *
 * Header is transparent at the top and gains a white background after
 * the user scrolls past the hero — keeps the hero visual clean while
 * staying readable as they go down the page.
 */
export function StorefrontHeader({
  workspaceId,
  productId,
  productHandle,
  productTitle,
  headerText,
  headerColor,
  headerWeight,
}: StorefrontHeaderProps) {
  const wordmark = (headerText && headerText.trim()) || productTitle;
  const wordmarkStyle: React.CSSProperties = {
    color: headerColor || undefined,
    fontWeight: headerWeight ? Number(headerWeight) : 700,
    letterSpacing: 0,
  };
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <header
        className={`fixed inset-x-0 top-0 z-40 transition-colors duration-200 ${
          scrolled ? "bg-white/95 backdrop-blur shadow-sm" : "bg-transparent"
        }`}
      >
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 md:h-16 md:px-8">
          {/* Hamburger */}
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
            className="-ml-1 flex h-10 w-10 items-center justify-center rounded-md text-zinc-900 transition hover:bg-zinc-100"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </svg>
          </button>

          {/* Product wordmark — custom text/color/weight, no letter-spacing
              so it matches the merchant's packaging. Centered on mobile,
              left-aligned on desktop. */}
          <div className="absolute left-1/2 -translate-x-1/2 md:static md:translate-x-0">
            <span className="block text-base md:text-lg" style={wordmarkStyle}>
              {wordmark}
            </span>
          </div>

          {/* Chat icon */}
          <button
            type="button"
            aria-label="Open chat"
            onClick={() => setChatOpen(true)}
            className="-mr-1 flex h-10 w-10 items-center justify-center rounded-md text-zinc-900 transition hover:bg-zinc-100"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Spacer so hero content doesn't sit underneath the header */}
      <div aria-hidden className="h-14 md:h-16" />

      {/* Hamburger drawer (placeholder content for now — menu wiring later) */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40"
          onClick={() => setMenuOpen(false)}
          role="button"
          aria-label="Close menu"
        >
          <div
            className="absolute inset-y-0 left-0 w-72 max-w-[80%] bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm font-semibold uppercase tracking-wider">Menu</span>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-zinc-100"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="6" y1="18" x2="18" y2="6" />
                </svg>
              </button>
            </div>
            <p className="text-xs text-zinc-500">Menu items coming soon.</p>
          </div>
        </div>
      )}

      {chatOpen && (
        <ChatOverlay
          workspaceId={workspaceId}
          productId={productId}
          productHandle={productHandle}
          productTitle={productTitle}
          onClose={() => setChatOpen(false)}
        />
      )}
    </>
  );
}
