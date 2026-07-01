# libraries/experiment-manifest

The **edge read-side** of the storefront experiment framework: the active-experiment MANIFEST that lets the Vercel edge middleware sticky-assign a PDP variant without a per-request DB hit, plus the cache plumbing that keeps it fresh. Shipped Phase 1 of the edge-served PDP A/B feature (the durable architecture behind [[../specs/pdp-experiment-wiring]] Phase 2).

**Files:** `src/lib/storefront/experiment-manifest.ts` (edge-safe: pure helpers + DB build + Edge Config publish — no `next/cache`, no runtime Supabase) · `src/lib/storefront/experiment-cache.ts` (server-only: `next/cache` purge). Tables [[../tables/storefront_experiments]] + [[../tables/storefront_experiment_variants]] · Blob route `src/app/api/storefront/experiment-manifest/route.ts` · Edge reader `src/lib/supabase/middleware.ts` · Render caller `src/app/(storefront)/store/[workspace]/[slug]/page.tsx` · Integration [[../integrations/vercel]] (Edge Config).

## The manifest

`ExperimentManifest = Record<"<storefrontSlug>/<productHandle>", { experiments: ManifestExperiment[] }>` — keyed by the two things the middleware can derive from the request URL (custom-domain single-segment PDP path). Each `ManifestExperiment` carries `{ id, status (running|promoted), holdout_pct, promoted_variant_id, variants: [{ id, is_control }] }` — exactly what the edge needs to run the same banding as `assignVariant`. Only running/promoted **PDP** experiments are published (other lander types render server-side, not via the edge).

## Exports — `experiment-manifest.ts`

### `assignFromManifest(unit, exp, opts?)` → `ManifestAssignment | null`
Assigns a precomputed `unit` (the visitor×experiment hash the edge already computed) to an arm. **Mirrors `assignVariant` in [[storefront-experiments]] exactly**: holdout band `[0, holdout_pct)` → control (`isHoldout`); `promoted` → the winner serves all non-holdout; `running` → explore arms split the non-holdout band with `opts.conservative` reserving `CONSERVATIVE_EXPLORE_SHARE` (0.34) for explore. Returns `{ experimentId, variantId, isControl, isHoldout }`; null only for a malformed experiment (no control arm).

### `buildExperimentManifest(admin)` → `ExperimentManifest`
DB build: running/promoted PDP experiments × their variants × product handle × workspace `storefront_slug`, assembled into the keyed map. Best-effort → `{}` on any failure.

### `publishExperimentManifest(admin)` → `PublishResult`
Publishes to the edge. With Edge Config provisioned (`EDGE_CONFIG` + `EDGE_CONFIG_ID` + `VERCEL_API_TOKEN`) it PATCHes the Edge Config item (`storefront_experiment_manifest` key) — sub-second, no deploy. Without it, a no-op push — the blob route is the source; the caller purges its cache. `isEdgeConfigWriteConfigured()` reports which path is live.

### Also: `manifestKey`, `EXPERIMENT_MANIFEST_TAG` / `_PATH` / `_EDGE_KEY` constants, types `ManifestVariant` / `ManifestExperiment` / `ManifestEntry` / `ManifestAssignment` / `PublishResult`.

## Exports — `experiment-cache.ts`

### `republishExperimentManifest(admin, productIds?)` → `void`
Called on every experiment **state change** (`materializeCampaign` stand-up, promote, kill, rollback — see [[storefront-optimizer-agent]], [[storefront-experiment-refresh]]). Re-publishes the manifest, purges the blob route (`revalidateTag(EXPERIMENT_MANIFEST_TAG, "max")` + `revalidatePath`), and purges each product's PDP render (`/store/{slug}/{handle}`) so the new arm serves immediately. Best-effort: `revalidate*` is a no-op outside a Next server context (e.g. the build-box worker that calls `materializeCampaign` as a node script), and the short-TTL blob covers that case within seconds.

## The blob fallback route

`GET /api/storefront/experiment-manifest` (public, under the `/api/storefront` prefix) returns the manifest JSON, cached two ways: `unstable_cache` tagged `EXPERIMENT_MANIFEST_TAG` (purged on state change) + `Cache-Control: s-maxage=15, stale-while-revalidate=60`. The middleware fetches it same-origin and module-caches it for 15s, so the hot path never pays a DB round-trip.

## Edge assignment (middleware)

`src/lib/supabase/middleware.ts`, in the custom-domain single-segment storefront-rewrite branch: `resolvePdpEdgeAssignment` reads the manifest (Edge Config when provisioned, else the blob), reuses a valid `sx_variant` cookie or assigns a fresh arm via `hashUnitEdge` (Web Crypto SHA-256, first 4 bytes / 2³² — matches `hashToUnit`) → `assignFromManifest`, sets `sx_variant=<experimentId>:<variantId>[:h]`, and rewrites **served** arms to `?_sxv=<variantId>` (control/holdout serve the real cached PDP). `sx_internal=1` → opt out entirely; `?variant=` / `?sx_preview=` requests are left to the page.

**Cache-key canonicalization (before assignment).** The rewrite calls `keepOnlyCacheParams(url)` FIRST, which strips every query param except the cache-relevant whitelist `CACHE_RELEVANT_PARAMS = {variant, angle, sx_preview}` (the params the page reads server-side); `_sxv` is added AFTER. This is the fix for the ad-tracking-param cache-fragmentation bug: Meta clicks arrive with a unique per-click `fbclid` (plus `utm_*` / `gclid` / `fbc` / `fbp`), and because the origin URL is what keys the render cache, every visitor was a distinct origin URL → a per-`fbclid` **dynamic** render that never served the prerendered PDP shell. It's a REWRITE, so the browser URL keeps the tracking params intact and the client pixel still reads them from `window.location` (utm attribution flows from the pixel POST → `storefront_sessions`, not the server render). Net: a bare Meta click now collapses to the prerendered shell (CDN HIT), and experiment arms collapse to one origin URL per `(slug, variant, angle, _sxv)`. Whitelist must equal the page's `searchParams` type (`{ variant?, angle?, sx_preview?, _sxv? }`) — adding a server-read param means adding it to `CACHE_RELEVANT_PARAMS`.

## Gotchas
- **Edge-safe split is load-bearing.** `experiment-manifest.ts` imports no `next/cache` and no runtime Supabase (admin is passed in; the createAdminClient import is `import type`, erased) so the edge bundle stays clean. Server-only purge lives in `experiment-cache.ts`. Don't merge them.
- **Exposure is client-side.** The edge-assigned arm's `experiment_exposure` is emitted by the pixel reading the `sx_variant` cookie (`StorefrontPixelInit`), NOT server-rendered — that's what keeps control/holdout (no `_sxv`) cacheable yet still logged. Internal/bot drop happens at the pixel write.
- **`_sxv` is guarded.** `loadEdgeAssignedPdpHero` ([[storefront-experiments]]) verifies the variant belongs to THIS product's active PDP experiment, so a forged `_sxv` can't inject an arbitrary hero.
- **Edge Config is the optimal owner step.** Until it's provisioned the blob fallback adds one same-origin fetch per 15s per edge instance. See [[../integrations/vercel]].
