"use client";

import { useState } from "react";
import type { MediaItem, SupplementFacts } from "../_lib/page-data";
import { PictureHero } from "./PictureHero";
import { SupplementFactsPanel } from "./SupplementFactsPanel";

/**
 * Hero image gallery — main image + square thumbnail strip below.
 *
 * The first uploaded image (display_order=0) defines the FRAME aspect
 * ratio. Every other gallery item renders inside that same frame using
 * object-fit: contain, so different upload sizes still show at a
 * uniform render size without cropping. Thumbnails are square with
 * object-fit: cover so they read as a uniform strip even if the
 * source images have different aspects.
 *
 * No arrows — clicking a thumbnail selects that image. Keyboard:
 * thumbnails are real <button>s so Tab + Enter work natively.
 */
export function HeroGallery({
  items,
  altFallback,
  isBestseller,
  aspectW,
  aspectH,
  supplementFacts,
}: {
  items: MediaItem[];
  altFallback: string;
  isBestseller: boolean;
  aspectW: number;
  aspectH: number;
  /**
   * When provided, an extra "Supplement Facts" slide is appended to
   * the gallery — rendered as CSS-styled HTML instead of an image so
   * it stays sharp at any size and updates live with the admin's
   * supplement_facts edits.
   */
  supplementFacts?: SupplementFacts | null;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  // Synthetic facts slot lives at items.length when present. We treat
  // it as an extra index so the existing strip math + state still
  // works.
  const factsIdx = supplementFacts ? items.length : -1;
  const totalSlides = items.length + (supplementFacts ? 1 : 0);
  const showingFacts = activeIdx === factsIdx;
  const active = items[activeIdx] || items[0];
  const showStrip = totalSlides > 1;

  return (
    <>
      <div
        className="relative w-full aspect-[4/3] xl:aspect-auto"
      >
        <div
          style={{ aspectRatio: `${aspectW} / ${aspectH}` }}
          className="absolute inset-0 [&_picture]:absolute [&_picture]:inset-0 [&_img]:h-full [&_img]:w-full [&_img]:object-cover xl:relative xl:inset-auto xl:[&_picture]:relative xl:[&_picture]:inset-auto xl:[&_img]:h-full xl:[&_img]:w-full xl:[&_img]:object-contain"
        >
          {showingFacts && supplementFacts ? (
            <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-zinc-50 p-4 xl:relative xl:inset-auto xl:bg-transparent xl:p-0">
              <SupplementFactsPanel facts={supplementFacts} />
            </div>
          ) : (
            // key forces React to remount the <picture> when active changes,
            // so the new image's <source> srcset is read fresh — without
            // this, browsers caching the prior decoded image can stick.
            <PictureHero
              key={active?.url || activeIdx}
              media={active || null}
              altFallback={altFallback}
              sizes="(min-width: 1280px) 60vw, 100vw"
              width={aspectW}
              height={aspectH}
            />
          )}
        </div>
        {isBestseller && !showingFacts && (
          <span
            className="absolute right-3 top-3 z-10 inline-flex items-center rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-md xl:right-4 xl:top-12 xl:px-4 xl:py-2 xl:text-sm"
            aria-label="Best Seller"
          >
            Best Seller!
          </span>
        )}
      </div>

      {showStrip && (
        <div className="mt-4 flex w-full justify-center gap-2 px-5 xl:mt-6 xl:px-0">
          {items.map((item, i) => {
            const url = item.webp_480_url || item.avif_480_url || item.url || "";
            const isActive = i === activeIdx;
            return (
              <button
                key={item.url || i}
                type="button"
                onClick={() => setActiveIdx(i)}
                aria-label={`Show image ${i + 1}`}
                aria-pressed={isActive}
                style={isActive ? { borderColor: "var(--storefront-primary)" } : undefined}
                className={`relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border-2 bg-white transition-all xl:h-20 xl:w-20 ${
                  isActive
                    ? "shadow-md"
                    : "border-zinc-200 opacity-70 hover:opacity-100"
                }`}
              >
                {url ? (
                  <img
                    src={url}
                    alt={item.alt_text || `Thumbnail ${i + 1}`}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="h-full w-full bg-zinc-100" />
                )}
              </button>
            );
          })}
          {supplementFacts && (
            <button
              type="button"
              onClick={() => setActiveIdx(factsIdx)}
              aria-label="Show supplement facts"
              aria-pressed={showingFacts}
              style={
                showingFacts
                  ? { borderColor: "var(--storefront-primary)" }
                  : undefined
              }
              className={`relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border-2 bg-white transition-all xl:h-20 xl:w-20 ${
                showingFacts
                  ? "shadow-md"
                  : "border-zinc-200 opacity-70 hover:opacity-100"
              }`}
            >
              {/* HTML thumbnail — miniature of the facts panel: a small
                  "Supplement Facts" header with a few thin lines. Reads
                  as "facts panel" at thumbnail size without needing to
                  rasterize the full component. */}
              <div className="flex h-full w-full flex-col items-stretch bg-white p-1 text-black">
                <div className="text-[7px] font-extrabold leading-tight">
                  Supp. Facts
                </div>
                <div className="mt-0.5 border-t border-black/80" />
                <div className="mt-0.5 h-0.5 w-full bg-black/30" />
                <div className="mt-0.5 h-0.5 w-2/3 bg-black/30" />
                <div className="mt-0.5 h-0.5 w-3/4 bg-black/30" />
                <div className="mt-0.5 h-0.5 w-1/2 bg-black/30" />
                <div className="mt-0.5 border-t-2 border-black/80" />
              </div>
            </button>
          )}
        </div>
      )}
    </>
  );
}
