"use client";

import { useEffect, useState } from "react";
import { seasonalBannerText } from "@/lib/seasonal-banner";

/**
 * Fixed-height promo banner whose text is resolved CLIENT-SIDE from the visitor's own date,
 * so an edge-cached lander always shows the right occasion (see [[../../../lib/seasonal-banner]]).
 *
 * SSR renders a season-NEUTRAL fallback (so the banner is never empty and never wrong for a
 * cached page); `useEffect` upgrades it to the date-accurate occasion after mount. The wrapper
 * height is fixed, so the swap causes zero layout shift (CLS).
 */
export function SeasonalBanner({ discount, base }: { discount: string; base: string }) {
  // Neutral fallback for SSR / pre-hydration — no specific season, so a cached page is never wrong.
  const fallback = `Limited-Time Sale Ends Soon — ${discount} ${base}`.replace(/\s+/g, " ").trim();
  const [text, setText] = useState(fallback);
  useEffect(() => {
    setText(seasonalBannerText({ discount, base }));
  }, [discount, base]);
  return <div className="bp-hero__promo">{text}</div>;
}
