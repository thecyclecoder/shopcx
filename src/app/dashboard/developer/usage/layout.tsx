/**
 * /dashboard/developer/usage layout — wraps the client page in Suspense so the
 * production build succeeds under `cacheComponents: true`. Even though the
 * current client page doesn't call useSearchParams / useParams / usePathname
 * directly, wrapping the whole segment keeps this route safe if a future edit
 * ever DOES read a dynamic client hook — matches the pattern the founder-pulse
 * spec used for /dashboard/developer/pulse's peer surfaces.
 */
import { Suspense } from "react";

export default function UsageLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
