"use client";

import { useEffect, useMemo } from "react";

interface Props {
  workspaceId: string;
  productId: string;
  productHandle: string;
  productTitle: string;
  onClose: () => void;
}

/**
 * Iframe overlay that hosts the existing /widget/{workspaceId} page with
 * product context preloaded as query params. Mobile = full-screen sheet,
 * desktop = bottom-right floating panel — same layout the legacy
 * widget.js bubble uses on third-party sites.
 *
 * Product context passed:
 *   - pid:    internal product UUID (Shopify-deprecation-friendly; the
 *             widget's articles API resolves UUIDs to shopify_product_id)
 *   - handle: product handle (fallback if pid lookup misses)
 *   - title:  product title (purely for the page_context label Sonnet sees)
 *   - path:   the customer's pathname when they opened chat
 */
export function ChatOverlay({
  workspaceId,
  productId,
  productHandle,
  productTitle,
  onClose,
}: Props) {
  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (productId) params.set("pid", productId);
    if (productHandle) params.set("handle", productHandle);
    if (productTitle) params.set("title", productTitle);
    if (typeof window !== "undefined") params.set("path", window.location.pathname);
    return `/widget/${workspaceId}?${params.toString()}`;
  }, [workspaceId, productId, productHandle, productTitle]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-end bg-black/30 p-0 md:items-end md:p-4">
      <div
        role="presentation"
        onClick={onClose}
        className="absolute inset-0"
        aria-label="Close chat"
      />
      <div className="relative flex h-full w-full max-w-full flex-col overflow-hidden bg-white shadow-2xl md:h-[600px] md:max-h-[calc(100vh-32px)] md:w-[400px] md:rounded-2xl">
        <button
          type="button"
          aria-label="Close chat"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-zinc-700 shadow hover:bg-white"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="6" y1="18" x2="18" y2="6" />
          </svg>
        </button>
        <iframe
          src={url}
          title="Chat"
          allow="clipboard-read; clipboard-write"
          className="h-full w-full border-0"
        />
      </div>
    </div>
  );
}
