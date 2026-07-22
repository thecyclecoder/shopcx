import { Suspense } from "react";

// cacheComponents wraps the dynamic reads on /dashboard/products/[id]/creative in a Suspense
// boundary — required whenever a server page touches uncached DB/auth data (docs/brain/reference/
// ui-conventions.md § cacheComponents). Fallback is null so the page keeps its own loading UX.
export default function CreativePanelLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
