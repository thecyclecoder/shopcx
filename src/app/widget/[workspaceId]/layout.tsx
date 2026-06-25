import { Suspense, type ReactNode } from "react";

export const metadata = {
  title: "Chat — ShopCX",
};

// cacheComponents: the widget page is a client component reading dynamic params/state — wrap it in a
// <Suspense> boundary so its prerender doesn't fail with "Uncached data accessed outside of <Suspense>".
// The outer <div> is the host-element root: because this layout exports `metadata`, Next streams a
// <__next_metadata_boundary__> as a sibling of `{children}`. Without a stable host element wrapping both,
// the PPR resume sees the metadata boundary in the slot where it cached the page's root <div> and forces
// a full client re-render (Vercel digest 34312922 — 'Expected the resume to render <div> in this slot but
// instead it rendered <__next_metadata_boundary__>').
export default function WidgetLayout({ children }: { children: ReactNode }) {
  return (
    <div className="widget-root">
      <Suspense fallback={null}>{children}</Suspense>
    </div>
  );
}
