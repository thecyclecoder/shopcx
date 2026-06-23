/**
 * Active-experiment MANIFEST for the PDP edge-served A/B
 * (docs/brain/specs/pdp-edge-served-experiments.md).
 *
 * The edge middleware can't afford a Supabase round-trip per request, so the set
 * of running/promoted PDP experiments is published to a low-latency edge read:
 *   • **Vercel Edge Config** when provisioned (the optimal owner step) — sub-second
 *     propagation, no deploy, no per-request DB hit.
 *   • A **cached JSON blob** fallback (`GET /api/storefront/experiment-manifest`,
 *     short s-maxage) the middleware fetches + module-caches when Edge Config isn't
 *     wired yet.
 *
 * The optimizer re-publishes the manifest on every experiment STATE CHANGE
 * (`materializeCampaign` stand-up, promote, kill, rollback) via
 * [[experiment-cache]] so the edge always assigns from the current arm set.
 *
 * This module is intentionally **edge-safe**: it imports no `next/cache` and no
 * runtime Supabase client (the admin client is passed IN), so `src/proxy.ts`
 * (the edge middleware) can import the pure assignment helpers without dragging a
 * server-only bundle into the edge runtime.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Cache tag + path of the JSON-blob fallback route (purged on state change). */
export const EXPERIMENT_MANIFEST_TAG = "storefront-experiment-manifest";
export const EXPERIMENT_MANIFEST_PATH = "/api/storefront/experiment-manifest";
/** Edge Config key the manifest is published under (when Edge Config is provisioned). */
export const EXPERIMENT_MANIFEST_EDGE_KEY = "storefront_experiment_manifest";

/** Mirrors `CONSERVATIVE_EXPLORE_SHARE` in [[experiments]] — conservative reserves
 *  the rest of the non-holdout band for control until M3 calibrates the LTV proxy. */
const CONSERVATIVE_EXPLORE_SHARE = 0.34;

export interface ManifestVariant {
  id: string;
  is_control: boolean;
}

export interface ManifestExperiment {
  id: string;
  status: "running" | "promoted";
  holdout_pct: number;
  promoted_variant_id: string | null;
  variants: ManifestVariant[];
}

export interface ManifestEntry {
  experiments: ManifestExperiment[];
}

/** Keyed by `${storefrontSlug}/${productHandle}` — the two things the middleware
 *  can derive from the request URL (custom-domain single-segment PDP path). */
export type ExperimentManifest = Record<string, ManifestEntry>;

export function manifestKey(storefrontSlug: string, productHandle: string): string {
  return `${storefrontSlug}/${productHandle}`;
}

export interface ManifestAssignment {
  experimentId: string;
  variantId: string;
  isControl: boolean;
  isHoldout: boolean;
}

/**
 * Deterministically assign a precomputed `unit` (in [0,1), the visitor×experiment
 * hash the edge already computed) to an arm of a manifest experiment. This MIRRORS
 * `assignVariant` in [[experiments]] exactly (same holdout band → promoted → running
 * explore/control split with the conservative reserve) so the edge assignment and
 * any server-side check agree. Returns null only for a malformed experiment (no
 * control arm).
 */
export function assignFromManifest(
  unit: number,
  exp: ManifestExperiment,
  opts: { conservative?: boolean } = {},
): ManifestAssignment | null {
  const control = exp.variants.find((v) => v.is_control) ?? null;
  if (!control) return null;

  const holdout = Math.min(Math.max(exp.holdout_pct ?? 0, 0), 1);
  // Holdout band — reserved first, never reallocated.
  if (unit < holdout) {
    return { experimentId: exp.id, variantId: control.id, isControl: true, isHoldout: true };
  }

  // Promoted: the winner serves all non-holdout traffic.
  if (exp.status === "promoted" && exp.promoted_variant_id) {
    const winner = exp.variants.find((v) => v.id === exp.promoted_variant_id) ?? control;
    return { experimentId: exp.id, variantId: winner.id, isControl: winner.is_control, isHoldout: false };
  }

  const arms = exp.variants.filter((v) => !v.is_control);
  if (arms.length === 0) {
    return { experimentId: exp.id, variantId: control.id, isControl: true, isHoldout: false };
  }

  // Renormalize within the non-holdout band, then split explore vs control.
  const r = holdout < 1 ? (unit - holdout) / (1 - holdout) : 0;
  const exploreShare = opts.conservative ? CONSERVATIVE_EXPLORE_SHARE : 1;
  if (r >= exploreShare) {
    return { experimentId: exp.id, variantId: control.id, isControl: true, isHoldout: false };
  }
  const idx = Math.min(arms.length - 1, Math.floor((r / exploreShare) * arms.length));
  return { experimentId: exp.id, variantId: arms[idx].id, isControl: false, isHoldout: false };
}

/**
 * Build the active-experiment manifest from the DB: every running/promoted PDP
 * experiment, keyed by `${storefrontSlug}/${productHandle}`. Best-effort — returns
 * `{}` on any failure (tables absent, query error) so the edge degrades to "no
 * experiment = the cached real PDP".
 */
export async function buildExperimentManifest(admin: Admin): Promise<ExperimentManifest> {
  try {
    const { data: exps } = await admin
      .from("storefront_experiments")
      .select("id, product_id, status, holdout_pct, promoted_variant_id")
      .eq("lander_type", "pdp")
      .in("status", ["running", "promoted"]);
    if (!exps?.length) return {};

    const productIds = [...new Set(exps.map((e) => e.product_id as string))];
    const expIds = exps.map((e) => e.id as string);
    const [{ data: products }, { data: variants }] = await Promise.all([
      admin.from("products").select("id, handle, workspace_id").in("id", productIds),
      admin
        .from("storefront_experiment_variants")
        .select("id, experiment_id, is_control")
        .in("experiment_id", expIds),
    ]);

    const wsIds = [...new Set((products ?? []).map((p) => p.workspace_id as string))];
    const { data: workspaces } = await admin
      .from("workspaces")
      .select("id, storefront_slug")
      .in("id", wsIds);

    const slugByWs = new Map<string, string | null>(
      (workspaces ?? []).map((w) => [w.id as string, (w.storefront_slug as string | null) ?? null]),
    );
    const productById = new Map(
      (products ?? []).map((p) => [p.id as string, p as { id: string; handle: string | null; workspace_id: string }]),
    );
    const variantsByExp = new Map<string, ManifestVariant[]>();
    for (const v of variants ?? []) {
      const arr = variantsByExp.get(v.experiment_id as string) ?? [];
      arr.push({ id: v.id as string, is_control: !!v.is_control });
      variantsByExp.set(v.experiment_id as string, arr);
    }

    const manifest: ExperimentManifest = {};
    for (const e of exps) {
      const product = productById.get(e.product_id as string);
      if (!product) continue;
      const slug = slugByWs.get(product.workspace_id);
      if (!slug || !product.handle) continue;
      const vlist = variantsByExp.get(e.id as string) ?? [];
      if (!vlist.some((v) => v.is_control)) continue; // need a control arm to assign against

      const key = manifestKey(slug, product.handle);
      const entry = manifest[key] ?? { experiments: [] };
      entry.experiments.push({
        id: e.id as string,
        status: e.status as "running" | "promoted",
        holdout_pct: (e.holdout_pct as number | null) ?? 0,
        promoted_variant_id: (e.promoted_variant_id as string | null) ?? null,
        variants: vlist,
      });
      manifest[key] = entry;
    }
    return manifest;
  } catch {
    return {};
  }
}

/** True when Edge Config + a write token are provisioned — the optimal owner step. */
export function isEdgeConfigWriteConfigured(): boolean {
  return !!(process.env.EDGE_CONFIG && process.env.VERCEL_API_TOKEN && process.env.EDGE_CONFIG_ID);
}

export interface PublishResult {
  ok: boolean;
  sink: "edge-config" | "blob-fallback";
  surfaces: number;
  detail: string;
}

/**
 * Publish the freshly-built manifest to the edge. With Edge Config provisioned this
 * PATCHes the Edge Config item (sub-second, no deploy). Without it this is a no-op
 * push — the `/api/storefront/experiment-manifest` blob route is the source the
 * middleware fetches, and the caller ([[experiment-cache]]) purges its short-lived
 * cache so the new arm set is live within seconds. Best-effort: never throws.
 */
export async function publishExperimentManifest(admin: Admin): Promise<PublishResult> {
  const manifest = await buildExperimentManifest(admin);
  const surfaces = Object.keys(manifest).length;

  if (isEdgeConfigWriteConfigured()) {
    try {
      const res = await fetch(`https://api.vercel.com/v1/edge-config/${process.env.EDGE_CONFIG_ID}/items`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.VERCEL_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [{ operation: "upsert", key: EXPERIMENT_MANIFEST_EDGE_KEY, value: manifest }],
        }),
      });
      if (!res.ok) {
        return { ok: false, sink: "edge-config", surfaces, detail: `edge-config PATCH ${res.status}: ${await res.text()}` };
      }
      return { ok: true, sink: "edge-config", surfaces, detail: `published ${surfaces} surface(s) to Edge Config` };
    } catch (err) {
      return { ok: false, sink: "edge-config", surfaces, detail: err instanceof Error ? err.message : "edge-config publish failed" };
    }
  }

  // Fallback: nothing to push — the blob route rebuilds on demand and the caller
  // purges its cache tag/path. Provision Edge Config for fetch-free edge reads.
  return {
    ok: true,
    sink: "blob-fallback",
    surfaces,
    detail: `Edge Config not provisioned — serving the cached ${EXPERIMENT_MANIFEST_PATH} blob (${surfaces} surface(s)). Provision Vercel Edge Config (EDGE_CONFIG + EDGE_CONFIG_ID + VERCEL_API_TOKEN) for sub-second, fetch-free edge reads.`,
  };
}
