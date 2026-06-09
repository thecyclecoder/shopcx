"use client";

/**
 * Chapter / scroll / CTA instrumentation for the storefront PDP.
 *
 * One foundation, three payoffs (storefront-mvp spec Phase 2): the smart
 * popup (Phase 4), chapter-performance analytics, and the Meta pixel
 * stream (Phase 3) all read these events.
 *
 * Resolves the spec's open question (`<Chapter>` wrapper vs. HOC): we
 * neither wrap nor HOC. Every in-flow section already renders
 * `<section data-section="…">`, so we just OBSERVE those nodes — zero
 * edits to any section, and it works with the `dynamic()`-imported ones
 * (PriceTable/Bundle/Reviews/FAQ) because the observer scans the live
 * DOM after hydration. `data-chapter-index` is stamped at runtime by
 * DOM order, so there's no hand-maintained index to drift.
 *
 * Emits:
 *   chapter_view   — a section was ≥50% visible for ≥1s (filters fast
 *                    scroll-pasts). Once per chapter per page. Jump-aware:
 *                    chapters flown past during a programmatic
 *                    scroll-to-price are suppressed; the pricing chapter's
 *                    view carries `origin_chapter` + `arrived_via_jump`.
 *   chapter_dwell  — accumulated active-time per chapter, flushed on exit.
 *   scroll_depth   — max depth %, direction reversals (yo-yo / compare).
 *   cta_click      — any `[data-cta]` click, tagged with kind + the
 *                    origin chapter (`closest('[data-section]')`).
 *
 * `add_to_cart` is emitted at the pack_selected → /customize moment in
 * StorefrontPixelInit (that transition IS the add-to-cart), not here.
 *
 * Pure side effects — renders no UI. Mounted once per PDP in render-page.
 */

import { useEffect } from "react";
import { track } from "@/lib/storefront-pixel";

const VIEW_VISIBLE_RATIO = 0.5; // ≥50% in viewport counts as "in view"
const VIEW_DWELL_MS = 1000; // must hold for ≥1s to count as a real view
const PRICING_CHAPTER = "pricing";

interface Props {
  productId: string;
}

export function StorefrontChapterTracker({ productId }: Props) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // ── Build the chapter list from the live DOM (post-hydration) ──
    // dynamic() sections may mount a tick after us, so re-scan on a
    // microtask + once more after a short delay to catch late chunks.
    const chapterIndex = new Map<Element, number>();
    const chapterId = new Map<Element, string>();

    const indexChapters = () => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-section]"));
      nodes.forEach((el, i) => {
        el.dataset.chapterIndex = String(i);
        chapterIndex.set(el, i);
        chapterId.set(el, el.dataset.section || `chapter_${i}`);
        if (!observed.has(el)) {
          observer.observe(el);
          observed.add(el);
        }
      });
    };

    // ── chapter_view + active-chapter + dwell ─────────────────────
    const observed = new Set<Element>();
    const ratios = new Map<Element, number>();
    const viewArmTimers = new Map<Element, number>();
    const firedView = new Set<string>(); // chapter ids that already emitted chapter_view
    const dwellMs = new Map<string, number>(); // chapter id → accumulated active ms

    let activeChapter: string | null = null;
    let activeSince = 0;

    // Jump state: set when a scroll-to-price CTA is clicked. While active,
    // chapter_view is suppressed (the customer is flying past, not reading)
    // until the pricing chapter lands — which fires with origin context.
    let jumpActive = false;
    let jumpOrigin: string | null = null;

    const now = () => (typeof performance !== "undefined" ? performance.now() : 0);

    const accrueDwell = () => {
      if (activeChapter && activeSince) {
        const elapsed = now() - activeSince;
        if (elapsed > 0) dwellMs.set(activeChapter, (dwellMs.get(activeChapter) || 0) + elapsed);
      }
    };

    const recomputeActive = () => {
      // Active = the most-visible section currently ≥50% in view.
      let best: Element | null = null;
      let bestRatio = VIEW_VISIBLE_RATIO;
      for (const [el, r] of ratios) {
        if (r >= bestRatio) {
          best = el;
          bestRatio = r;
        }
      }
      const nextId = best ? chapterId.get(best) || null : null;
      if (nextId !== activeChapter) {
        accrueDwell();
        activeChapter = nextId;
        activeSince = now();
      }
    };

    const armView = (el: Element) => {
      const id = chapterId.get(el);
      if (!id || firedView.has(id) || viewArmTimers.has(el)) return;
      const t = window.setTimeout(() => {
        viewArmTimers.delete(el);
        if ((ratios.get(el) || 0) < VIEW_VISIBLE_RATIO || firedView.has(id)) return;

        // Jump-aware: while flying to pricing, suppress views for the
        // chapters passed. The pricing chapter itself ends the jump and
        // fires with where the customer came from.
        if (jumpActive && id !== PRICING_CHAPTER) return;

        firedView.add(id);
        const meta: Record<string, unknown> = {
          product_id: productId,
          chapter: id,
          chapter_index: chapterIndex.get(el) ?? null,
        };
        if (jumpActive && id === PRICING_CHAPTER) {
          meta.arrived_via_jump = true;
          meta.origin_chapter = jumpOrigin;
          jumpActive = false;
          jumpOrigin = null;
        }
        track("chapter_view", meta);
      }, VIEW_DWELL_MS);
      viewArmTimers.set(el, t);
    };

    const disarmView = (el: Element) => {
      const t = viewArmTimers.get(el);
      if (t) {
        window.clearTimeout(t);
        viewArmTimers.delete(el);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(entry.target, entry.intersectionRatio);
          if (entry.intersectionRatio >= VIEW_VISIBLE_RATIO) armView(entry.target);
          else disarmView(entry.target);
        }
        recomputeActive();
      },
      { threshold: [0, 0.25, VIEW_VISIBLE_RATIO, 0.75, 1] },
    );

    indexChapters();
    const reindexTimer = window.setTimeout(indexChapters, 1500);

    // ── scroll_depth (max %, reversals) ───────────────────────────
    let maxDepthPct = 0;
    let lastScrollY = window.scrollY;
    let lastDir: "down" | "up" | null = null;
    let reversals = 0;

    const onScroll = () => {
      const y = window.scrollY;
      const viewportH = window.innerHeight;
      const docH = document.documentElement.scrollHeight;
      if (docH > viewportH) {
        const pct = Math.min(100, Math.round(((y + viewportH) / docH) * 100));
        if (pct > maxDepthPct) maxDepthPct = pct;
      }
      const dir = y > lastScrollY ? "down" : y < lastScrollY ? "up" : lastDir;
      if (dir && lastDir && dir !== lastDir) reversals++;
      if (dir) lastDir = dir;
      lastScrollY = y;
    };

    // ── cta_click (any [data-cta]) + jump trigger ─────────────────
    const onCtaClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const cta = target.closest("[data-cta]") as HTMLElement | null;
      if (!cta) return;

      const kind = cta.dataset.ctaKind || "unknown";
      const chapterEl = cta.closest("[data-section]") as HTMLElement | null;
      const originChapter = chapterEl?.dataset.section || null;

      track("cta_click", {
        product_id: productId,
        cta: cta.dataset.cta || null,
        cta_kind: kind,
        chapter: originChapter,
        chapter_index: chapterEl?.dataset.chapterIndex ? Number(chapterEl.dataset.chapterIndex) : null,
      });

      // A scroll-to-price CTA means "this chapter persuaded them to go to
      // pricing." Arm jump-awareness so the chapters scrolled past don't
      // count as genuine views.
      if (kind === "scroll_to_price" && originChapter !== PRICING_CHAPTER) {
        jumpActive = true;
        jumpOrigin = originChapter;
        // Safety valve: if pricing never registers (e.g. user scrolls back
        // up), clear the jump after 4s so normal view tracking resumes.
        window.setTimeout(() => {
          jumpActive = false;
          jumpOrigin = null;
        }, 4000);
      }
    };

    // ── flush dwell + scroll_depth on the way out ─────────────────
    let flushed = false;
    const flushExit = () => {
      if (flushed) return;
      flushed = true;
      accrueDwell();
      for (const [id, ms] of dwellMs) {
        if (ms >= 250) {
          track("chapter_dwell", { product_id: productId, chapter: id, dwell_ms: Math.round(ms) });
        }
      }
      track("scroll_depth", { product_id: productId, max_depth_pct: maxDepthPct, reversals });
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("click", onCtaClick, { capture: true });
    window.addEventListener("pagehide", flushExit);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushExit();
    });

    return () => {
      observer.disconnect();
      window.clearTimeout(reindexTimer);
      for (const t of viewArmTimers.values()) window.clearTimeout(t);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("click", onCtaClick, { capture: true });
      window.removeEventListener("pagehide", flushExit);
    };
  }, [productId]);

  return null;
}
