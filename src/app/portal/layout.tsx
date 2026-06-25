import { connection } from "next/server";

/**
 * cacheComponents is ON (for the storefront's fast cached PDPs). The customer portal pages read uncached,
 * per-customer data (the workspace + the authed customer's subscriptions/orders from the DB) at request
 * time — they can't be prerendered. Without this, Cache Components fails the build with "Uncached data
 * accessed outside of <Suspense>". connection() marks the whole /portal subtree dynamic, covering every
 * portal page in one place.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return children;
}
