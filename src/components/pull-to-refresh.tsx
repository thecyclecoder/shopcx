"use client";

import { useRef, useState, useCallback, useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

const THRESHOLD = 80;
const MAX_PULL = 120;

export default function PullToRefresh({ children }: { children: ReactNode }) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const startY = useRef(0);
  const isDragging = useRef(false);

  const canPull = useCallback(() => {
    const el = containerRef.current;
    if (!el) return false;
    return el.scrollTop <= 0;
  }, []);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!canPull()) return;
    startY.current = e.touches[0].clientY;
    isDragging.current = true;
  }, [canPull]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDragging.current || refreshing) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy > 0 && canPull()) {
      const distance = Math.min(dy * 0.5, MAX_PULL);
      setPullDistance(distance);
      setPulling(true);
      if (distance > 10) e.preventDefault();
    } else {
      setPulling(false);
      setPullDistance(0);
    }
  }, [canPull, refreshing]);

  const handleTouchEnd = useCallback(() => {
    isDragging.current = false;
    if (pullDistance >= THRESHOLD && !refreshing) {
      setRefreshing(true);
      setPullDistance(THRESHOLD);
      router.refresh();
      // Increment key to force remount all children — re-runs all useEffects/fetches
      setRefreshKey(k => k + 1);
      setTimeout(() => {
        setRefreshing(false);
        setPulling(false);
        setPullDistance(0);
      }, 800);
    } else {
      setPulling(false);
      setPullDistance(0);
    }
  }, [pullDistance, refreshing, router]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  const progress = Math.min(pullDistance / THRESHOLD, 1);

  return (
    <div ref={containerRef} className="relative h-full overflow-y-auto scrollbar-hidden">
      {/* Pull indicator */}
      {pulling && (
        <div
          className="pointer-events-none absolute left-0 right-0 z-50 flex items-center justify-center"
          style={{ top: 0, height: `${pullDistance}px` }}
        >
          <div className={`transition-transform ${refreshing ? "animate-spin" : ""}`}>
            <svg
              className="h-6 w-6 text-indigo-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transform: `rotate(${progress * 360}deg)`, opacity: progress }}
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          </div>
        </div>
      )}
      {/* Content shifted down during pull — key forces full remount on refresh */}
      <div key={refreshKey} style={{ transform: pulling ? `translateY(${pullDistance}px)` : "none", transition: pulling ? "none" : "transform 0.2s ease" }}>
        {children}
      </div>
    </div>
  );
}
