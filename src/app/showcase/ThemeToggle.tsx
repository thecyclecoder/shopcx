"use client";

import { useSyncExternalStore } from "react";

// Self-contained dark/light toggle for the showcase section. Toggles the
// `.showcase-dark` class on the `.showcase-root` element and persists the
// choice in localStorage. The pre-paint inline script in layout.tsx sets the
// initial class, so this only handles user-driven changes (no flash).
//
// We read the current theme via useSyncExternalStore so the icon stays in sync
// with the DOM class without a setState-in-effect (which React flags). The store
// is the `.showcase-dark` class on the root element; we notify subscribers
// ourselves whenever the toggle flips it.

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function isDark(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.querySelector(".showcase-root")?.classList.contains("showcase-dark") ??
    false
  );
}

function setTheme(dark: boolean) {
  const root = document.querySelector(".showcase-root");
  if (!root) return;
  root.classList.toggle("showcase-dark", dark);
  try {
    localStorage.setItem("showcase-theme", dark ? "dark" : "light");
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function ThemeToggle() {
  // Server snapshot is `false` (light); the pre-paint script + first client
  // snapshot reconcile the real value without a visible flash.
  const dark = useSyncExternalStore(subscribe, isDark, () => false);

  return (
    <button
      type="button"
      className="sc-theme-btn"
      onClick={() => setTheme(!isDark())}
      aria-label="Toggle color theme"
      title="Toggle light / dark"
    >
      {dark ? (
        // sun
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        // moon
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
