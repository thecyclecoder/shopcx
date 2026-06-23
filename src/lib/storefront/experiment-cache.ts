/**
 * Server-only cache plumbing for the PDP edge-served A/B
 * (docs/brain/specs/pdp-edge-served-experiments.md).
 *
 * Kept SEPARATE from [[experiment-manifest]] because this imports `next/cache`
 * (server-only, not edge-safe). The edge middleware imports the pure assignment
 * helpers from experiment-manifest.ts; only server callers (the optimizer, the M1
 * refresh) import this.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  publishExperimentManifest,
  EXPERIMENT_MANIFEST_TAG,
  EXPERIMENT_MANIFEST_PATH,
} from "./experiment-manifest";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Re-publish the active-experiment manifest to the edge + purge the affected PDP
 * render(s). Called on every experiment state change (stand-up, promote, kill,
 * rollback) and when an approved hero goes live — so the edge always assigns from
 * the current arm set and the variant-keyed PDP cache drops its stale render.
 *
 * Best-effort by design: `revalidatePath`/`revalidateTag` are no-ops (or throw,
 * caught) outside a Next.js server context — e.g. the build-box worker that calls
 * `materializeCampaign` as a plain node script — and the short-TTL blob route still
 * picks up the change within seconds. Never throws into the optimizer's decision path.
 */
export async function republishExperimentManifest(admin: Admin, productIds: string[] = []): Promise<void> {
  try {
    await publishExperimentManifest(admin);
  } catch {
    /* publish is best-effort */
  }
  // Purge the JSON-blob fallback so the middleware refetches the new manifest.
  try {
    // Next 16: the second arg ("max") purges the tag across static + dynamic caches.
    revalidateTag(EXPERIMENT_MANIFEST_TAG, "max");
  } catch {
    /* not in a Next server context */
  }
  try {
    revalidatePath(EXPERIMENT_MANIFEST_PATH);
  } catch {
    /* not in a Next server context */
  }

  // Purge the affected products' PDP renders (each variant-keyed entry) so the new
  // hero/arm serves immediately instead of waiting out the ISR window.
  if (productIds.length) {
    try {
      const { data: products } = await admin
        .from("products")
        .select("id, handle, workspace_id")
        .in("id", [...new Set(productIds)]);
      const wsIds = [...new Set((products ?? []).map((p) => p.workspace_id as string))];
      const { data: workspaces } = await admin
        .from("workspaces")
        .select("id, storefront_slug")
        .in("id", wsIds);
      const slugByWs = new Map<string, string | null>(
        (workspaces ?? []).map((w) => [w.id as string, (w.storefront_slug as string | null) ?? null]),
      );
      for (const p of products ?? []) {
        const slug = slugByWs.get(p.workspace_id as string);
        if (!slug || !p.handle) continue;
        try {
          revalidatePath(`/store/${slug}/${p.handle}`);
        } catch {
          /* not in a Next server context */
        }
      }
    } catch {
      /* purge is best-effort */
    }
  }
}
