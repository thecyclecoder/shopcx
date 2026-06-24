"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// Contextual sidebar takeover (director-profile IA): a complex section page registers its own sub-nav, which
// REPLACES the main app sidebar (with a Back row) while you're inside it. The page feeds this via setNav on
// mount and clears it on unmount; the Sidebar consumes it. Sections deep-link via the `?s=<key>` query.

export interface SectionNavItem {
  key: string; // the ?s= value
  label: string;
  icon?: string; // optional heroicon path
}
export interface SectionNav {
  title: string; // the takeover header (e.g. the director's name)
  basePath: string; // the page these sections live on (sections are basePath?s=key)
  backHref: string; // where the ← Back row returns to (the main-nav context)
  backLabel: string;
  sections: SectionNavItem[];
}

interface Ctx {
  nav: SectionNav | null;
  setNav: (n: SectionNav | null) => void;
}

const SectionNavContext = createContext<Ctx>({ nav: null, setNav: () => {} });

export function SectionNavProvider({ children }: { children: ReactNode }) {
  const [nav, setNav] = useState<SectionNav | null>(null);
  return <SectionNavContext.Provider value={{ nav, setNav }}>{children}</SectionNavContext.Provider>;
}

export const useSectionNav = () => useContext(SectionNavContext);
