"use client";

import { useEffect, useState } from "react";

/**
 * Evergreen "Sale Ends in HH:MM:SS" countdown for the lander offer card. On first visit it stamps
 * a deadline (now + `seconds`) in localStorage and ticks down; on return it continues the same
 * deadline, and once expired it rolls to a fresh window so the urgency stays live without lying
 * about a fixed date. SSR-safe: renders a static fallback until mounted (no hydration mismatch).
 */
export function CountdownTimer({ seconds, storageKey = "lander-offer-deadline" }: { seconds: number; storageKey?: string }) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    const now = () => Math.floor(Date.now() / 1000);
    const read = () => {
      const raw = Number(window.localStorage.getItem(storageKey));
      let deadline = Number.isFinite(raw) && raw > now() ? raw : 0;
      if (!deadline) {
        deadline = now() + seconds;
        window.localStorage.setItem(storageKey, String(deadline));
      }
      return deadline;
    };
    let deadline = read();
    const tick = () => {
      let left = deadline - now();
      if (left <= 0) {
        deadline = now() + seconds;
        window.localStorage.setItem(storageKey, String(deadline));
        left = seconds;
      }
      setRemaining(left);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [seconds, storageKey]);

  const fmt = (total: number) => {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
  };

  return (
    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800 }}>
      {remaining === null ? fmt(seconds) : fmt(remaining)}
    </span>
  );
}
