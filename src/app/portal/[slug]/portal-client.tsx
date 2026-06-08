"use client";

/**
 * Portal mini-site shell — the visual + navigational layout.
 *
 * Desktop:
 *   ┌──────────────────┬──────────────────────────────┐
 *   │ logo             │                              │
 *   │                  │  active section              │
 *   │ Subscriptions ●  │                              │
 *   │ Orders           │                              │
 *   │ Payment Methods  │                              │
 *   │ Support          │                              │
 *   │ Account          │                              │
 *   │                  │                              │
 *   │ Sign out         │                              │
 *   └──────────────────┴──────────────────────────────┘
 *
 * Mobile (≤768): sidebar collapses to a hamburger drawer; the rest
 * fills the viewport. Section header carries the active section name
 * so the customer always knows where they are.
 *
 * Section routing is state-based for v1 — URL doesn't change as the
 * customer navigates between Subscriptions / Orders / etc. Keeps the
 * page light (no router thrashing) and lets us iterate fast. We'll
 * add ?section=... query support later for shareability.
 */

import { useState } from "react";
import type { PortalSubscription, PortalOrder } from "./page";
import { SubscriptionsSection } from "./_sections/SubscriptionsSection";
import { AccountSection } from "./_sections/AccountSection";
import { OrdersSection } from "./_sections/OrdersSection";
import { RewardsSection } from "./_sections/RewardsSection";
import { HomeSection } from "./_sections/HomeSection";
import { ResourcesSection } from "./_sections/ResourcesSection";
import { SupportSection } from "./_sections/SupportSection";
import { PaymentMethodsSection } from "./_sections/PaymentMethodsSection";
import { SubscriptionDetailScreen } from "./_sections/SubscriptionDetailScreen";

interface Props {
  slug: string;
  initialSection?: SectionId;
  /** When set, the Subscriptions section renders the detail view for
   *  this subscriptions.id instead of the list. URL bar shows
   *  /subscriptions/{id} thanks to the middleware rewrite. */
  detailSubscriptionId?: string | null;
  workspace: {
    id: string;
    name: string;
    logoUrl: string;
    primaryColor: string;
  };
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    linkedIds: string[];
  };
  subscriptions: PortalSubscription[];
  orders: PortalOrder[];
}

type SectionId = "home" | "subscriptions" | "orders" | "rewards" | "payment_methods" | "support" | "account" | "resources";

// Each section's URL-bar slug. We rewrite these in middleware so the
// customer never sees the /portal/{slug} prefix.
const SECTION_PATHS: Record<SectionId, string> = {
  home: "/",
  subscriptions: "/subscriptions",
  orders: "/orders",
  rewards: "/rewards",
  payment_methods: "/payment-methods",
  support: "/support",
  account: "/account",
  resources: "/resources",
};

const NAV_ITEMS: Array<{ id: SectionId; label: string; icon: string }> = [
  { id: "home", label: "Home", icon: "M3 12l9-9 9 9v9a2 2 0 01-2 2h-3v-7H10v7H7a2 2 0 01-2-2v-9z" },
  { id: "subscriptions", label: "Subscriptions", icon: "M6 2a1 1 0 011-1h6a1 1 0 011 1v1h3a1 1 0 011 1v3.5l-1.5 9.5A2 2 0 0114.5 18h-9A2 2 0 013.5 16L2 6.5V3a1 1 0 011-1h3V2zm2 1v0H6V4h2V3zm4 0H8v1h4V3zm4 2H4l1.4 9.07A1 1 0 006.4 15h7.2a1 1 0 001-.93L16 5z" },
  { id: "orders", label: "Orders", icon: "M3 3h2l1 12h12l1-9H6m0 0L5 3m1 12a1 1 0 102 0 1 1 0 00-2 0zm10 0a1 1 0 102 0 1 1 0 00-2 0z" },
  { id: "rewards", label: "Rewards", icon: "M20 12v9H4v-9M2 7h20v5H2V7zm10 0v14m0-14C12 4 9 2 7.5 3.5S6 7 12 7zm0 0c0-3 3-5 4.5-3.5S18 7 12 7z" },
  { id: "payment_methods", label: "Payment Methods", icon: "M2 5a2 2 0 012-2h16a2 2 0 012 2v14a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm0 4h20m-14 4h6m-6 3h4" },
  { id: "support", label: "Support", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm-1 14h2v2h-2v-2zm0-10h2v8h-2V6z" },
  { id: "resources", label: "Resources", icon: "M4 6h16v12H4V6zm2 2v8h12V8H6zm2 2h8v1H8v-1zm0 3h8v1H8v-1z" },
  { id: "account", label: "Account", icon: "M12 12a5 5 0 100-10 5 5 0 000 10zM2 22a10 10 0 0120 0H2z" },
];

export default function PortalClient(props: Props) {
  const [section, setSectionState] = useState<SectionId>(props.initialSection || "home");
  // Update both state AND the URL bar without triggering a Next.js
  // server roundtrip. Middleware rewrites the section path internally
  // so links into specific sections (refresh, share, back button)
  // hit the right page on cold-load.
  function setSection(s: SectionId) {
    setSectionState(s);
    try {
      const path = SECTION_PATHS[s];
      if (typeof window !== "undefined") {
        window.history.pushState({}, "", path);
      }
    } catch { /* ignore */ }
  }
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const greeting = props.customer.firstName
    ? `Hi ${props.customer.firstName}`
    : "Welcome";

  const navList = NAV_ITEMS.map((item) => (
    <button
      key={item.id}
      type="button"
      onClick={() => {
        setSection(item.id);
        setMobileNavOpen(false);
      }}
      className={
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition " +
        (section === item.id
          ? "bg-zinc-100 text-zinc-900"
          : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900")
      }
      style={section === item.id ? { color: "var(--portal-primary)" } : undefined}
    >
      <svg className="h-5 w-5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d={item.icon} />
      </svg>
      <span className="flex-1">{item.label}</span>
    </button>
  ));

  return (
    <div className="min-h-screen lg:flex">
      {/* Sidebar — desktop fixed, mobile drawer */}
      <aside
        className={
          "z-30 w-72 flex-shrink-0 border-r border-zinc-200 bg-white " +
          "lg:sticky lg:top-0 lg:h-screen " +
          (mobileNavOpen
            ? "fixed inset-y-0 left-0 shadow-2xl"
            : "hidden lg:block")
        }
      >
        <div className="flex h-20 items-center justify-between border-b border-zinc-200 px-5">
          {props.workspace.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={transformLogoUrl(props.workspace.logoUrl, 256)}
              alt={props.workspace.name}
              className="h-16 w-auto"
            />
          ) : (
            <span className="text-xl font-semibold text-zinc-900">{props.workspace.name}</span>
          )}
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close menu"
            className="lg:hidden -mr-2 p-2 text-zinc-500 hover:text-zinc-900"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav className="flex flex-col gap-1 p-3">{navList}</nav>

        <div className="border-t border-zinc-200 p-3">
          <a
            href="/logout"
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Sign out
          </a>
        </div>
      </aside>

      {/* Click-outside backdrop for mobile drawer */}
      {mobileNavOpen && (
        <button
          type="button"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close menu"
          className="fixed inset-0 z-20 bg-black/30 lg:hidden"
        />
      )}

      {/* Main column */}
      <main className="min-w-0 flex-1">
        {/* Top bar — mobile hamburger + section title */}
        <header className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b border-zinc-200 bg-white px-4 sm:px-6 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open menu"
            className="-ml-2 p-2 text-zinc-700"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1 className="text-base font-semibold text-zinc-900">
            {NAV_ITEMS.find((n) => n.id === section)?.label}
          </h1>
        </header>

        <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
          {/* Desktop section header — hidden on mobile (top bar shows it).
              Suppressed on the subscription detail screen since that
              screen renders its own header + breadcrumb. */}
          {!(section === "subscriptions" && props.detailSubscriptionId) && (
            <div className="mb-6 hidden lg:block">
              <p className="text-sm text-zinc-500">{greeting}</p>
              <h1 className="mt-1 text-3xl font-bold text-zinc-900">
                {NAV_ITEMS.find((n) => n.id === section)?.label}
              </h1>
            </div>
          )}

          {section === "home" && (
            <HomeSection
              firstName={props.customer.firstName}
              subscriptions={props.subscriptions}
              orders={props.orders}
              primaryColor={props.workspace.primaryColor}
              onNavigate={setSection}
            />
          )}
          {section === "subscriptions" && (
            props.detailSubscriptionId ? (
              <SubscriptionDetailScreen
                subscriptionId={props.detailSubscriptionId}
                workspace={props.workspace}
              />
            ) : (
              <SubscriptionsSection
                subscriptions={props.subscriptions}
                workspace={props.workspace}
              />
            )
          )}
          {section === "orders" && (
            <OrdersSection orders={props.orders} primaryColor={props.workspace.primaryColor} />
          )}
          {section === "rewards" && (
            <RewardsSection primaryColor={props.workspace.primaryColor} firstName={props.customer.firstName} />
          )}
          {section === "payment_methods" && (
            <PaymentMethodsSection primaryColor={props.workspace.primaryColor} />
          )}
          {section === "support" && (
            <SupportSection primaryColor={props.workspace.primaryColor} />
          )}
          {section === "resources" && (
            <ResourcesSection subscriptions={props.subscriptions} />
          )}
          {section === "account" && (
            <AccountSection
              customer={{
                firstName: props.customer.firstName,
                lastName: props.customer.lastName,
                email: props.customer.email,
                phone: props.customer.phone,
              }}
              primaryColor={props.workspace.primaryColor}
            />
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * Rewrite a Supabase Storage URL through the render endpoint for
 * server-side resize + WebP→PNG conversion. Mirrors the same helper
 * the storefront uses on its logos.
 */
function transformLogoUrl(url: string, heightPx: number): string {
  if (!url.includes("supabase.co/storage/v1/object/public/")) return url;
  const base = url.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}height=${heightPx * 2}&resize=contain`;
}
