# PDP edge-served experiments — variant at the edge, cached per arm ⏳

**Owner:** [[../functions/platform]] · **Parent:** the P2 of [[pdp-experiment-wiring]] (P1 shipped: PDP experiments apply, dynamic-when-testing). · **Why:** P1 makes a tested PDP **fully dynamic** (no ISR cache) — fine for now, but the PDP is the hot, high-traffic page. Edge-served A/B keeps it **edge-cached per variant** (fast *and* tested) instead of paying server render on every request. The owner's pattern: assign the variant at the **Vercel edge**, cache-key by it.

## The 5 pieces
1. **Active-experiment manifest in Edge Config.** Edge middleware can't afford a Supabase round-trip per request — publish the running experiments (per `product × lander`: `variant_id`s, weights, `holdout_pct`, `promoted_variant_id`) to **Vercel Edge Config** (low-latency edge KV). The optimizer **re-publishes the manifest** on every experiment state change (`materializeCampaign` start, promote, kill, rollback) — so the edge always has the current assignment set without a DB call. (If Edge Config isn't wired, a periodically-refreshed cached JSON blob the middleware fetches is the fallback.)
2. **Edge middleware** (`middleware.ts`, matched to the PDP route): read the manifest for this product/lander; **sticky-assign** by a deterministic hash of the visitor (the `sid` cookie) × experiment id, holdout-aware (same logic as `assignVariant`); set a `sx_variant=<experimentId>:<variantId>|holdout` cookie if absent. Internal/bot (`sx_internal`) → no assignment.
3. **Cache-keyed-by-variant.** The middleware **rewrites** the request to a variant-keyed internal URL (e.g. add `?_sxv=<variantId>`), so each arm is a **distinct cacheable render** — control = the real PDP (its existing cache), each variant its own edge-cached entry. (Next App Router: rewrite + the param participates in the cache key; or a `Vary`-by-cookie cache tag.)
4. **Page reads the assigned variant** (from the rewrite param / cookie) instead of assigning inline; applies the variant patch over `media_by_slot["hero"]` (reuse P1's apply); **stays cacheable** (no per-request `cookies()` assignment in the page — the edge already did it). Exposure still emits for the assigned arm (internal/bot excluded), reusing the pixel path.
5. **Cache purge on content change** — when a variant's hero is (re)approved/regenerated (the [[optimizer-hero-preview-gate]] flow) or an experiment promotes/ends, **purge that variant's cached PDP render** (revalidateTag / path) so the new content serves; on experiment end, drop the variant cookie/rewrite.

## Verification
- `curl` the PDP with two different `sx_variant` cookie values → **different hero image** per arm in the HTML, each with `x-vercel-cache: HIT` after warm-up (cached **per variant**, not one shared render, not `MISS`-every-time).
- A fresh PDP visit (no cookie) → `Set-Cookie: sx_variant=…` from the **middleware** (edge assignment), sticky on reload.
- An internal/bot visit (`sx_internal=1`) → no assignment, no exposure.
- Start/stop/promote an experiment → the **Edge Config manifest updates** within seconds (no deploy) and the edge assignment reflects it; a re-approved hero → the variant's cached render **purges** and serves the new image.
- The [[storefront-test-detail-page|test detail page]]'s PDP arm increments from real edge-assigned traffic; numbers match the bandit source.
- Negative: with **no** running PDP experiment, the PDP serves its normal cached render (no middleware rewrite, no per-request cost); killing an experiment reverts everyone to the cached real PDP.

## Phase 1 — Edge Config manifest + middleware assign/rewrite + cache-per-variant + purge ⏳
Publish the active-experiment manifest to Edge Config (optimizer re-publishes on state change); `middleware.ts` edge-assigns the sticky `sx_variant` + rewrites to a variant-keyed cacheable URL; the PDP reads the assigned arm + caches per variant; purge on content change / experiment end. Brain: [[pdp-experiment-wiring]] · [[storefront-optimizer-agent]] · [[storefront-experiment-bandit-framework]] · [[optimizer-hero-preview-gate]] · [[../integrations/vercel]] (Edge Config).
