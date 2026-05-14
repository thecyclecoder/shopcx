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

interface CtaPayload {
  bundle: boolean;
  mode: "subscribe" | "onetime";
  frequency_days: number | null;
  line_items: Array<{ shopify_variant_id: string; quantity: number }>;
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

    // ── pack_selected → cart create → /customize ─────────────────
    // Delegated click on the Select CTAs that PriceTableSection and
    // BundlePriceTableSection already render. We read the data-*
    // attributes off the anchor, fire pack_selected, POST to /api/cart
    // with the resolved line items, then navigate to /customize. The
    // anchor's native href (#buy-... / #buy-bundle-...) is suppressed
    // — it was always a placeholder waiting for the cart pipeline.
    const onPriceCtaClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const anchor = target.closest("a[href^='#buy-'], a[href^='#buy-bundle-']") as HTMLAnchorElement | null;
      if (!anchor) return;

      const ds = anchor.dataset;
      const isBundle = anchor.getAttribute("href")?.startsWith("#buy-bundle-");
      const mode = (ds.mode === "onetime" ? "onetime" : "subscribe") as "subscribe" | "onetime";
      const freqDays = ds.frequencyDays ? Number(ds.frequencyDays) : null;

      const cta: CtaPayload = {
        bundle: !!isBundle,
        mode,
        frequency_days: freqDays,
        line_items: [],
      };

      if (isBundle) {
        if (ds.primaryVariantId && ds.primaryQuantity) {
          cta.line_items.push({
            shopify_variant_id: ds.primaryVariantId,
            quantity: Number(ds.primaryQuantity) || 1,
          });
        }
        if (ds.upsellVariantId && ds.upsellQuantity) {
          cta.line_items.push({
            shopify_variant_id: ds.upsellVariantId,
            quantity: Number(ds.upsellQuantity) || 1,
          });
        }
      } else {
        // Single tier: the PriceTable encodes variant_id only; tier
        // qty is derived from the existing tier display, NOT on the
        // data attribute today. Default to 1 — the bundle path is the
        // common multi-pack flow. Future: add a data-quantity attr
        // on the Select CTA so single-tier multi-pack adds the right
        // qty straight from the click.
        if (ds.variantId) {
          cta.line_items.push({
            shopify_variant_id: ds.variantId,
            quantity: Number(ds.tierQuantity) || 1,
          });
        }
      }

      const trackPayload: Record<string, unknown> = {
        product_id: productId,
        bundle: cta.bundle,
        mode: cta.mode,
        frequency_days: cta.frequency_days,
      };
      if (isBundle) {
        trackPayload.bundle_size = ds.bundleSize ? Number(ds.bundleSize) : null;
        trackPayload.primary_variant_id = ds.primaryVariantId || null;
        trackPayload.upsell_variant_id = ds.upsellVariantId || null;
      } else {
        trackPayload.variant_id = ds.variantId || null;
      }
      track("pack_selected", trackPayload);

      // Block default anchor scroll, take over navigation.
      e.preventDefault();
      e.stopPropagation();

      if (cta.line_items.length === 0) return;

      // POST to /api/cart, then navigate. Errors keep the customer
      // on the PDP and surface to console — no toast UI yet.
      void fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          workspace_id: workspaceId,
          anonymous_id: undefined, // server reads from cookie/session — we don't expose it here
          line_items: cta.line_items,
          mode: cta.mode,
          frequency_days: cta.frequency_days,
        }),
      })
        .then(async (res) => {
          if (!res.ok) {
            console.error("cart create failed:", res.status, await res.text());
            return;
          }
          const json = (await res.json()) as { cart?: { token: string } };
          const token = json.cart?.token;
          window.location.href = token ? `/customize?token=${token}` : "/customize";
        })
        .catch((err) => {
          console.error("cart create error:", err);
        });
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
