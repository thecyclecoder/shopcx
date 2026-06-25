# PDP edge-served variant 'use cache' — unblock the build (round 3) by stripping the cacheComponents-incompatible `dynamicParams = true` knob the prior fix preserved

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/regression-agent]] · **Regression-of:** [[pdp-edge-served-variant-use-cache-strip-revalidate-runtime-k]]
**Regression-signature:** `regression:pdp-edge-served-variant-use-cache-strip-revalidate-runtime-k:74e973b1890d`

PR #614 stripped `revalidate` + `runtime = "edge"` but, by the prior spec's explicit instruction, KEPT `export const dynamicParams = true;` on the storefront PDP + blog index + blog post + links pages. Next 16's cacheComponents migration guide is explicit `dynamicParams` is ALSO incompatible — every post-fix Vercel production deploy is in Error at the same 4 files with `Route segment config "dynamicParams" is not compatible with nextConfig.cacheComponents. Please remove it.`, the `renderEdgeAssignedPdp` 'use cache' helper never reaches prod, and prod still serves MISS + private/no-store. Strip the 4 remaining `dynamicParams = true` exports (App Router defaults to `true` so behaviour is preserved), and the post-fix deploy lands READY, restoring per-arm + bare PDP HITs.

## What regressed
Per-arm `x-vercel-cache: HIT` after warm-up on served-arm PDP URLs AND the bare PDP's SSG/`'use cache'`-cached render — both still serve `MISS` + `cache-control: private, no-cache, no-store, max-age=0, must-revalidate` in prod (confirmed live on https://shop.superfoodscompany.com/ashwavana-zen-relax on two consecutive curls) because every post-fix Vercel production deploy errors with 'Route segment config "dynamicParams" is not compatible with `nextConfig.cacheComponents`. Please remove it.' at all 4 storefront pages, and the renderEdgeAssignedPdp 'use cache' helper never ships.

## Offending change
Commit 2f6d7e1b / PR #614 'build: pdp-edge-served-variant-use-cache-strip-revalidate-runtime-k' — stripped `revalidate` + `runtime = "edge"` everywhere per the prior spec, but the prior spec's text explicitly said to LEAVE `export const dynamicParams = true;` on the storefront PDP + sister storefront pages. Per node_modules/next/dist/docs/01-app/02-guides/migrating-to-cache-components.md `dynamicParams` is ALSO incompatible with cacheComponents.

## Phase 1 — restore it
Delete `export const dynamicParams = true;` in all 4 storefront pages — repo-wide grep `export const dynamicParams` returns ONLY these (the `maxDuration` exports on API routes are unrelated and unflagged): src/app/(storefront)/store/[workspace]/[slug]/page.tsx line 48, src/app/(storefront)/store/[workspace]/blog/page.tsx line 30, src/app/(storefront)/store/[workspace]/blog/[handle]/page.tsx line 39, src/app/(storefront)/store/[workspace]/links/page.tsx line 19. `dynamicParams` defaults to `true` in the App Router so removing the explicit export preserves behaviour exactly. The existing `'use cache'` blocks at [slug]/page.tsx:116, blog/page.tsx:77, blog/[handle]/page.tsx:114, links/page.tsx:37 keep all caching intact. Gate on `npx tsc --noEmit`, push, confirm the next Vercel production deploy lands READY on `vercel inspect`.
Gate on `npx tsc --noEmit`.

## Verification
- A fresh Vercel deploy after the fix lands as READY (not ERROR) — `vercel inspect <latest>` no longer shows 'Route segment config "dynamicParams" is not compatible with `nextConfig.cacheComponents`' (nor `revalidate`, `runtime`, `dynamic`).
- Repo-wide grep `export const dynamicParams` returns zero hits in src/.
- curl the served-arm URL `https://shop.superfoodscompany.com/{handle}` with two distinct sticky `sx_variant` cookies that map to different variants → a different hero `<img>` URL per arm AND, on the second curl of each variant URL after the first warm-up, `x-vercel-cache: HIT` with `cache-control` carrying `s-maxage` (not `private, no-cache, no-store`).
- Bare PDP with no `?variant=`, no `_sxv` and no running experiment → `x-vercel-cache: HIT` (cached SSG/`'use cache'` render, no per-request server compute).
- Re-run spec-test on [[pdp-edge-served-experiments]] AND [[pdp-edge-served-variant-use-cache]] → both previously-failing verification check(s) pass again (the original ✅ holds).
- Re-run spec-test on [[pdp-edge-served-variant-use-cache-strip-revalidate-runtime-k]] → its verification holds (the post-fix Vercel deploy is READY and `vercel inspect` shows no route-segment-config incompatibility errors).
- Re-run spec-test on [[pdp-edge-served-variant-use-cache-strip-revalidate-runtime-k]] → expect its previously-failing verification check(s) pass again (the original ✅ holds).

> Authored by the box Regression Agent — a confirmed regression of [[pdp-edge-served-variant-use-cache-strip-revalidate-runtime-k]] (signature `regression:pdp-edge-served-variant-use-cache-strip-revalidate-runtime-k:74e973b1890d`). The DevOps Director queues the build (auto-approve within its leash; pre-M4 the CEO queues it).
