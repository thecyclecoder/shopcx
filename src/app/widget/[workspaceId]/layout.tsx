import { Suspense, type ReactNode } from "react";

export const metadata = {
  title: "Chat — ShopCX",
};

// cacheComponents: the widget page is a client component reading dynamic params/state — wrap it in a
// <Suspense> boundary so its prerender doesn't fail with "Uncached data accessed outside of <Suspense>".
export default function WidgetLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
