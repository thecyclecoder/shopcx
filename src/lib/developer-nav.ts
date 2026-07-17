/**
 * The Developer portal nav — the single source of truth for the developer-area sub-navigation,
 * shared by the sidebar takeover ([[src/app/dashboard/sidebar.tsx]]) and the Overview page
 * ([[src/app/dashboard/developer/page.tsx]]).
 *
 * "Developer" is not a collapsible section in the main tree — it's a PORTAL (the same UX as a
 * director profile): clicking it lands on the Overview (`/dashboard/developer`), and while you're
 * anywhere in these routes the sidebar swaps the main tree for this sub-nav. The surfaces are
 * organized into GROUPS (Org · Development · Resources) — defined once in `DEVELOPER_GROUPS`; the
 * flat `DEVELOPER_NAV` is derived for membership/active tests. Add a surface to a group and it shows
 * in BOTH the takeover (under its heading) and the Overview cards — no second list.
 *
 * Pure data (no imports) → safe to import from a client component or a server component.
 */

export const DEVELOPER_OVERVIEW_HREF = "/dashboard/developer";

/** The founder-pulse read-only context-reconstitution surface (founder-pulse spec Phase 3).
 *  Rendered directly beneath the Overview link in the developer sidebar takeover — separate
 *  from `DEVELOPER_GROUPS` because it is the founder's "where was I?" home, not a group member. */
export const DEVELOPER_PULSE_HREF = "/dashboard/developer/pulse";

/** Heroicon path for the Pulse link — a stylized pulse waveform. */
export const DEVELOPER_PULSE_ICON =
  "M3.75 12h3l2.25-6 4.5 12 2.25-6h4.5";

/** The fleet-usage cockpit — 4 Max + Codex account cards + departments + API $ (fleet-usage-
 *  cockpit spec Phase 3). Rendered directly BELOW Pulse in the developer sidebar takeover —
 *  same peer treatment as Pulse (not a `DEVELOPER_GROUPS` member) so the founder's compute-
 *  cost view sits at the top of the portal alongside their context view. */
export const DEVELOPER_USAGE_HREF = "/dashboard/developer/usage";

/** Heroicon path for the Usage link — a stylized bar-chart / meter. */
export const DEVELOPER_USAGE_ICON =
  "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z";

/** A "needs you" count key — the sidebar/Overview look these up to render a live badge. */
export type DeveloperBadgeKey = "approvals" | "security" | "regressions" | "humanQA" | "branches";

export interface DeveloperNavItem {
  href: string;
  label: string;
  /** heroicon SVG path. */
  icon: string;
  /** one-line description for the Overview card. */
  desc: string;
  /** which live count (if any) drives this item's badge. */
  badge?: DeveloperBadgeKey;
}

export interface DeveloperNavGroup {
  heading: string;
  items: DeveloperNavItem[];
}

/** The developer surfaces, grouped + in sidebar order. Excludes the Overview itself (portal home). */
export const DEVELOPER_GROUPS: DeveloperNavGroup[] = [
  {
    heading: "Org",
    items: [
      {
        href: "/dashboard/agents",
        label: "Message Board",
        icon: "M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155",
        desc: "The #directors team board",
      },
      {
        href: "/dashboard/agents/org-chart",
        label: "Org Chart",
        icon: "M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.159.69.159 1.006 0z",
        desc: "CEO → Directors → Agents, live from the brain",
      },
      {
        href: "/dashboard/agents/directors",
        label: "Directors",
        icon: "M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z",
        desc: "Every director seat + its status",
      },
      {
        href: "/dashboard/agents/workers",
        label: "Agents",
        icon: "M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085",
        desc: "Every box worker lane",
      },
    ],
  },
  {
    heading: "Development",
    items: [
      {
        href: "/dashboard/roadmap/goals",
        label: "Goals",
        icon: "M3 3v1.5M3 21v-6m0 0l2.77-.693a9 9 0 016.208.682l.108.054a9 9 0 006.086.71l3.114-.732a48.524 48.524 0 01-.005-10.499l-3.11.732a9 9 0 01-6.085-.711l-.108-.054a9 9 0 00-6.208-.682L3 4.5M3 15V4.5",
        desc: "Company goals, BHAGs & their milestones",
      },
      {
        href: "/dashboard/roadmap",
        label: "Pipeline",
        icon: "M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125z",
        desc: "The spec workflow: review → build → test → ship",
      },
      {
        href: "/dashboard/roadmap/box",
        label: "Build box",
        icon: "M21.75 17.25v-.228a4.5 4.5 0 00-.12-1.03l-2.268-9.64a3.375 3.375 0 00-3.285-2.602H7.923a3.375 3.375 0 00-3.285 2.602l-2.268 9.64a4.5 4.5 0 00-.12 1.03v.228m19.5 0a3 3 0 01-3 3H5.25a3 3 0 01-3-3m19.5 0a3 3 0 00-3-3H5.25a3 3 0 00-3 3m16.5 0h.008v.008h-.008v-.008zm-3 0h.008v.008h-.008v-.008z",
        desc: "The headless build worker & its job queue",
      },
      {
        href: "/dashboard/developer/control-tower",
        label: "Control Tower",
        icon: "M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25",
        desc: "Live health of every autonomous agent loop",
      },
      {
        href: "/dashboard/developer/approvals",
        label: "Approvals",
        icon: "M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.249-8.25-3.286z",
        desc: "Every approval — decide what's escalated to the CEO",
        badge: "approvals",
      },
      {
        href: "/dashboard/roadmap/map",
        label: "Taxonomy map",
        icon: "M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.159.69.159 1.006 0z",
        desc: "The product / spec taxonomy graph",
      },
      {
        href: "/dashboard/developer/messages",
        label: "Message Center",
        icon: "M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z",
        desc: "Agent messages & the #directors board",
      },
      {
        href: "/dashboard/developer/spec-tests",
        label: "Spec Tests",
        icon: "M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
        desc: "Deterministic spec verification (spec-check-runner)",
      },
      {
        href: "/dashboard/developer/spec-tests/human-queue",
        label: "Human QA (optional)",
        icon: "M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z",
        desc: "Optional human checks waiting on you",
        badge: "humanQA",
      },
      {
        href: "/dashboard/developer/regressions",
        label: "Regressions",
        icon: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z",
        desc: "Shipped specs failing their own spec-test",
        badge: "regressions",
      },
      {
        href: "/dashboard/developer/security-tests",
        label: "Security tests",
        icon: "M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z",
        desc: "Vault's security reviews on every build",
        badge: "security",
      },
      {
        href: "/dashboard/branches",
        label: "Branches",
        icon: "M6 3v12m0 0a3 3 0 103 3m-3-3a3 3 0 013 3m6-15a3 3 0 11-3 3m3-3v6a6 6 0 01-6 6m0 0v3",
        desc: "Open claude/* pull requests",
        badge: "branches",
      },
    ],
  },
  {
    heading: "Resources",
    items: [
      {
        href: "/dashboard/brain",
        label: "Brain",
        icon: "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25",
        desc: "The system map — every table, library & flow",
      },
    ],
  },
];

/** Flat list of every developer surface (derived) — for membership + active-state helpers. */
export const DEVELOPER_NAV: DeveloperNavItem[] = DEVELOPER_GROUPS.flatMap((g) => g.items);

/** The Overview (portal home) heroicon — a 2×2 grid of cards. */
export const DEVELOPER_OVERVIEW_ICON =
  "M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 8.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z";

/** The "Developer" portal icon in the main tree (angle brackets). */
export const DEVELOPER_PORTAL_ICON = "M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5";

/** Is `pathname` inside the Developer portal? (any sub-surface, or the Overview itself, or Pulse or Usage). */
export function isInDeveloperPortal(pathname: string): boolean {
  if (pathname === DEVELOPER_OVERVIEW_HREF || pathname.startsWith(DEVELOPER_OVERVIEW_HREF + "/")) return true;
  if (pathname === DEVELOPER_PULSE_HREF || pathname.startsWith(DEVELOPER_PULSE_HREF + "/")) return true;
  if (pathname === DEVELOPER_USAGE_HREF || pathname.startsWith(DEVELOPER_USAGE_HREF + "/")) return true;
  return DEVELOPER_NAV.some((i) => pathname === i.href || pathname.startsWith(i.href + "/"));
}

/** Most-specific-wins active test for a developer href (so /dashboard/roadmap doesn't light up on
 * /dashboard/roadmap/box). `allHrefs` = the sibling hrefs to disambiguate against. */
export function isDeveloperHrefActive(pathname: string, href: string, allHrefs: string[]): boolean {
  if (pathname === href) return true;
  if (!pathname.startsWith(href + "/")) return false;
  return !allHrefs.some((o) => o.length > href.length && (pathname === o || pathname.startsWith(o + "/")));
}
