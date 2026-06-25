import { Suspense, type ReactNode } from "react";

// cacheComponents: the login page is a client component reading useSearchParams() — wrap it in a <Suspense>
// boundary so its prerender doesn't fail with "Uncached data accessed outside of <Suspense>".
export default function LoginLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
