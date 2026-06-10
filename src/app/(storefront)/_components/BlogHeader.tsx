"use client";

import { useEffect, useState } from "react";

/**
 * Storefront blog header.
 *
 * Mirrors the PDP StorefrontHeader's chrome — fixed, transparent over the
 * hero, gains a white background after scroll — but swaps the product
 * wordmark for the WORKSPACE LOGO + a blog navigation menu. The logo links
 * to the blog home; topic tabs filter the index; a "Shop" button sends
 * visitors to the main brand site to convert.
 *
 * Topic tabs route to /blog?topic={key}. The index reads that param
 * client-side to set the active filter (the page itself stays SSG).
 */

export interface BlogNavTopic {
  key: string;
  label: string;
}

interface BlogHeaderProps {
  workspaceName: string;
  logoUrl: string | null;
  topics: BlogNavTopic[];
  /**
   * When true, highlight the tab matching the URL's `?topic=` param
   * (the index page). Off on the post page, where no tab is active.
   */
  followTopicParam?: boolean;
  /** Main-site URL for the Shop CTA. */
  shopUrl: string;
}

export function BlogHeader({
  workspaceName,
  logoUrl,
  topics,
  followTopicParam = false,
  shopUrl,
}: BlogHeaderProps) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Derived from the URL on the client so the static page isn't deopted by
  // useSearchParams. Null until mount → "All" highlighted initially.
  const [activeTopic, setActiveTopic] = useState<string | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!followTopicParam) return;
    const topic = new URLSearchParams(window.location.search).get("topic");
    setActiveTopic(topic && topics.some((t) => t.key === topic) ? topic : null);
  }, [followTopicParam, topics]);

  const wordmarkStyle: React.CSSProperties = {
    fontFamily: "var(--storefront-heading-font)",
    fontWeight: 800,
    letterSpacing: 0,
  };

  return (
    <>
      <header
        className={`fixed inset-x-0 top-0 z-40 transition-colors duration-200 ${
          scrolled || menuOpen
            ? "bg-white/95 shadow-sm backdrop-blur"
            : "bg-transparent"
        }`}
      >
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 md:h-16 md:px-8">
          {/* Logo / wordmark → blog home */}
          <a href="/blog" className="flex shrink-0 items-center gap-2" aria-label={`${workspaceName} blog home`}>
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt={`${workspaceName} logo`}
                className="h-7 w-auto md:h-8"
              />
            ) : (
              <span className="text-base text-zinc-900 md:text-lg" style={wordmarkStyle}>
                {workspaceName}
              </span>
            )}
          </a>

          {/* Desktop topic nav */}
          <nav className="hidden items-center gap-1 md:flex">
            <a
              href="/blog"
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                !activeTopic
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              }`}
            >
              All
            </a>
            {topics.map((t) => (
              <a
                key={t.key}
                href={`/blog?topic=${encodeURIComponent(t.key)}`}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                  activeTopic === t.key
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                }`}
              >
                {t.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            {/* Shop CTA → main brand site */}
            <a
              href={shopUrl}
              className="hidden rounded-full px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 sm:inline-flex"
              style={{ backgroundColor: "var(--storefront-accent)" }}
            >
              Shop
            </a>

            {/* Mobile menu toggle */}
            <button
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              className="-mr-1 flex h-10 w-10 items-center justify-center rounded-md text-zinc-900 transition hover:bg-zinc-100 md:hidden"
            >
              {menuOpen ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="6" y1="18" x2="18" y2="6" />
                </svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <line x1="4" y1="7" x2="20" y2="7" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="17" x2="20" y2="17" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Mobile dropdown nav */}
        {menuOpen && (
          <div className="border-t border-zinc-100 bg-white px-4 pb-4 pt-2 md:hidden">
            <a href="/blog" className="block rounded-md px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100">
              All articles
            </a>
            {topics.map((t) => (
              <a
                key={t.key}
                href={`/blog?topic=${encodeURIComponent(t.key)}`}
                className="block rounded-md px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100"
              >
                {t.label}
              </a>
            ))}
            <a
              href={shopUrl}
              className="mt-2 block rounded-full px-3 py-2 text-center text-sm font-semibold text-white"
              style={{ backgroundColor: "var(--storefront-accent)" }}
            >
              Shop
            </a>
          </div>
        )}
      </header>

      {/* Spacer so content clears the fixed header */}
      <div aria-hidden className="h-14 md:h-16" />
    </>
  );
}
