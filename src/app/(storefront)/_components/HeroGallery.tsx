"use client";

import { useState } from "react";
import type { MediaItem } from "../_lib/page-data";
import { PictureHero } from "./PictureHero";

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
}: {
  items: MediaItem[];
  altFallback: string;
  isBestseller: boolean;
  aspectW: number;
  aspectH: number;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const active = items[activeIdx] || items[0];
  const showStrip = items.length > 1;

  return (
    <>
      <div
        className="relative w-full aspect-[4/3] xl:aspect-auto"
      >
        <div
          style={{ aspectRatio: `${aspectW} / ${aspectH}` }}
          className="absolute inset-0 [&_picture]:absolute [&_picture]:inset-0 [&_img]:h-full [&_img]:w-full [&_img]:object-cover xl:relative xl:inset-auto xl:[&_picture]:relative xl:[&_picture]:inset-auto xl:[&_img]:h-full xl:[&_img]:w-full xl:[&_img]:object-contain"
        >
          {/* key forces React to remount the <picture> when active changes,
              so the new image's <source> srcset is read fresh — without
              this, browsers caching the prior decoded image can stick. */}
          <PictureHero
            key={active?.url || activeIdx}
            media={active || null}
            altFallback={altFallback}
            sizes="(min-width: 1280px) 60vw, 100vw"
            width={aspectW}
            height={aspectH}
          />
        </div>
        {isBestseller && (
          <span
            className="absolute right-3 top-3 z-10 inline-flex items-center rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-md xl:right-4 xl:top-12 xl:px-4 xl:py-2 xl:text-sm"
            aria-label="Best Seller"
          >
            Best Seller!
          </span>
        )}
      </div>

      {showStrip && (
        <div className="mt-4 flex w-full justify-center gap-2 px-4 xl:mt-6 xl:px-0">
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
        </div>
      )}
    </>
  );
}
