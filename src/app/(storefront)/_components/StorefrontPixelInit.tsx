"use client";

/**
 * Initializes the storefront pixel client for the current PDP and
 * wires the three top-of-funnel events:
 *
 *   pdp_view      — fires once on mount.
 *   pdp_engaged   — fires once on first of: any CTA click on the
 *                   page / scroll past 50% of document / 30s on page.
 *   pack_selected — delegated click handler on the document; reads
 *                   data-* attributes off the price-table Select
 *                   anchor (set in PriceTableSection + Bundle
 *                   variants), so no edits needed to those sections.
 *
 * Placed inside the storefront PDP layout below the ActiveMember +
 * PricingMode providers but above any rendered section. Doesn't
 * render any UI — pure side effects.
 */

import { useEffect } from "react";
import { initPixel, track } from "@/lib/storefront-pixel";

interface Props {
  workspaceId: string;
  productId: string;
  productHandle: string;
  customerId?: string | null;
}

export function StorefrontPixelInit({
  workspaceId,
  productId,
  productHandle,
  customerId,
}: Props) {
  useEffect(() => {
    initPixel({ workspaceId, customerId: customerId || null });

    // ── pdp_view (always fires once) ──────────────────────────────
    track("pdp_view", {
      product_id: productId,
      product_handle: productHandle,
    });

    // ── pdp_engaged (first of three triggers) ─────────────────────
    let engaged = false;
    const fireEngaged = (trigger: string) => {
      if (engaged) return;
      engaged = true;
      track("pdp_engaged", { trigger, product_id: productId });
      cleanupEngagement();
    };

    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      // Any link click / button click counts. We're not being
      // selective — the goal is to detect "did the user do anything
      // meaningful with this page" not specifically "did they
      // engage with X surface."
      const isInteractive = target.closest("a, button, [role='button']");
      if (isInteractive) fireEngaged("click");
    };

    const onScroll = () => {
      const scrollY = window.scrollY;
      const viewportH = window.innerHeight;
      const docH = document.documentElement.scrollHeight;
      // 50% of the way through the SCROLLABLE area, not 50% of
      // viewport. Short PDPs (no scroll) won't trigger this; the
      // 30s timer covers them.
      if (docH > viewportH && (scrollY + viewportH) / docH >= 0.5) {
        fireEngaged("scroll_50");
      }
    };

    const dwellTimer = window.setTimeout(() => fireEngaged("dwell_30s"), 30_000);

    document.addEventListener("click", onClick, { capture: true });
    window.addEventListener("scroll", onScroll, { passive: true });

    function cleanupEngagement() {
      document.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(dwellTimer);
    }

    // ── pack_selected (delegated click on price-table CTAs) ───────
    // PriceTableSection (`#pricing`) and BundlePriceTableSection
    // (`#bundle-pricing`) both render ShopCTAs with data attributes
    // we read here. Delegation keeps those components untouched.
    const onPriceCtaClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const anchor = target.closest("a[href^='#buy-'], a[href^='#buy-bundle-']") as HTMLAnchorElement | null;
      if (!anchor) return;

      const ds = anchor.dataset;
      const isBundle = anchor.getAttribute("href")?.startsWith("#buy-bundle-");
      const payload: Record<string, unknown> = {
        product_id: productId,
        bundle: !!isBundle,
        mode: ds.mode || "subscribe",
        frequency_days: ds.frequencyDays ? Number(ds.frequencyDays) : null,
      };
      if (isBundle) {
        payload.bundle_size = ds.bundleSize ? Number(ds.bundleSize) : null;
        payload.primary_variant_id = ds.primaryVariantId || null;
        payload.primary_quantity = ds.primaryQuantity ? Number(ds.primaryQuantity) : null;
        payload.upsell_variant_id = ds.upsellVariantId || null;
        payload.upsell_quantity = ds.upsellQuantity ? Number(ds.upsellQuantity) : null;
      } else {
        payload.variant_id = ds.variantId || null;
      }

      track("pack_selected", payload);
    };

    document.addEventListener("click", onPriceCtaClick, { capture: true });

    return () => {
      cleanupEngagement();
      document.removeEventListener("click", onPriceCtaClick, { capture: true });
    };
    // We re-init only when the product or workspace changes (e.g.
    // client-side nav between PDPs). customerId changing alone
    // doesn't need a re-init — identify() handles that case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, productId, productHandle]);

  return null;
}
