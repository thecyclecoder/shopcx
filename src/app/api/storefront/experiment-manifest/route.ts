import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildExperimentManifest, EXPERIMENT_MANIFEST_TAG } from "@/lib/storefront/experiment-manifest";

/**
 * The active-experiment MANIFEST blob the edge middleware fetches when Vercel Edge
 * Config isn't provisioned (the cached-JSON-blob fallback of
 * docs/brain/specs/pdp-edge-served-experiments.md).
 *
 * Returns `{ "<storefrontSlug>/<handle>": { experiments: [...] } }` for every
 * running/promoted PDP experiment. Cached two ways so the middleware never pays a
 * DB round-trip on the hot path:
 *   • `unstable_cache` (tagged) — the optimizer purges `EXPERIMENT_MANIFEST_TAG` on
 *     every experiment state change, so a stand-up/promote/kill/rollback propagates
 *     within seconds without a deploy.
 *   • a short `s-maxage` so the Vercel CDN + the middleware's own module cache stay
 *     warm between purges.
 *
 * Public (under the `/api/storefront` public prefix) — it only exposes variant ids
 * + holdout, already inferable from the served HTML.
 */
export const dynamic = "force-dynamic";

const getCachedManifest = unstable_cache(
  async () => buildExperimentManifest(createAdminClient()),
  ["storefront-experiment-manifest"],
  { tags: [EXPERIMENT_MANIFEST_TAG], revalidate: 15 },
);

export async function GET() {
  const manifest = await getCachedManifest();
  return NextResponse.json(manifest, {
    headers: {
      "cache-control": "public, s-maxage=15, stale-while-revalidate=60",
    },
  });
}
