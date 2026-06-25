import { connection } from "next/server";

/**
 * cacheComponents is ON (for the storefront's fast cached PDPs). The help-center / KB minisite pages read
 * uncached data (the workspace + article from the DB) and `headers()` at request time, so they must render
 * dynamically — without this, Cache Components tries to partial-prerender them and fails the build with
 * "Uncached data accessed outside of <Suspense>". connection() marks the whole /help subtree dynamic (the
 * idiomatic replacement for a force-dynamic), covering every help page in one place.
 */
export default async function HelpLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return children;
}
