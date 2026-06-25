# PDP edge-served variant 'use cache' — unblock the build by stripping the cacheComponents-incompatible `export const dynamic` knobs

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/regression-agent]] · **Regression-of:** [[pdp-edge-served-variant-use-cache]]
**Regression-signature:** `regression:pdp-edge-served-variant-use-cache:d8a4a990a058`

The c620d402 fix for [[pdp-edge-served-variant-use-cache]] enables top-level `cacheComponents: true` in next.config.ts but leaves 39 `export const dynamic = "force-dynamic"` declarations across src/ — and Next 16's cacheComponents is incompatible with that route-segment knob. Every Vercel build since #607 has errored with 49× 'Route segment config "dynamic" is not compatible with nextConfig.cacheComponents', so the per-`_sxv` cache helper never reaches prod and the [[pdp-edge-served-experiments]] verification check (x-vercel-cache: HIT after warm-up) still fails. Strip the legacy `dynamic` exports — they're redundant under cacheComponents (no `'use cache'` = dynamic by default) and the only thing standing between the shipped fix and prod.

## What regressed
Per-arm `x-vercel-cache: HIT` after warm-up on served-arm PDP URLs, AND the bare PDP's SSG-cached render — both still serve `MISS` + `cache-control: private, no-cache, no-store, max-age=0, must-revalidate` in prod because the c620d402 build has errored out on every Vercel deploy since it merged, so the `renderEdgeAssignedPdp` helper's `'use cache'` + cacheLife + cacheTag never ships and prod still runs the pre-fix code that does `await searchParams` at the page top.

## Offending change
Commit c620d402 / PR #607 'build: pdp-edge-served-variant-use-cache' — enabled `cacheComponents: true` in next.config.ts without migrating the 39 `export const dynamic = "force-dynamic"` declarations across src/app/dashboard/roadmap/**, src/app/(storefront)/checkout|customize|thank-you/page.tsx, and most src/app/api/**/route.ts — every one of which Next 16 now errors on as incompatible with cacheComponents.

## Phase 1 — restore it
Delete every `export const dynamic = "force-dynamic"` line from src/app/**/*.{ts,tsx} (39 files: 3 storefront pages, ~10 dashboard/roadmap+brain+developer pages, ~26 api/* route handlers — `grep -rEn 'export const dynamic\s*=' src/ --include=*.ts --include=*.tsx`). The behavior the export forced (no caching, per-request render) is the cacheComponents default for any segment that does NOT begin with `'use cache'`, so the deletions are semantically a no-op for runtime behavior — they only unblock the build. Leave the `renderEdgeAssignedPdp` helper (page.tsx:112–140) and its `'use cache'`/cacheLife/cacheTag intact, leave `export const revalidate = 3600` + `export const dynamicParams = true` on the storefront PDP (these knobs still control prerender + on-demand param expansion and are NOT what cacheComponents flags). Gate on `npx tsc --noEmit`, push, confirm the next Vercel deploy lands READY (not ERROR) on `vercel inspect`.
Gate on `npx tsc --noEmit`.

## Verification
- A fresh Vercel deploy after the fix lands as READY (not ERROR) — `vercel inspect <latest>` no longer shows 'Route segment config "dynamic" is not compatible with nextConfig.cacheComponents'.
- curl the served-arm URL `https://shop.superfoodscompany.com/{handle}` with two distinct sticky `sx_variant` cookies that map to different variants → a different hero `<img>` URL per arm AND, on the second curl of each variant URL after the first warm-up, `x-vercel-cache: HIT` with `cache-control` carrying `s-maxage` (not `private, no-cache, no-store`).
- Bare PDP with no `?variant=`, no `_sxv` and no running experiment → `x-vercel-cache: HIT` (cached SSG/`'use cache'` render, no per-request server compute).
- Re-run spec-test on [[pdp-edge-served-experiments]] AND [[pdp-edge-served-variant-use-cache]] → both previously-failing verification check(s) pass again (the original ✅ holds).
- Re-run spec-test on [[pdp-edge-served-variant-use-cache]] → expect its previously-failing verification check(s) pass again (the original ✅ holds).

> Authored by the box Regression Agent — a confirmed regression of [[pdp-edge-served-variant-use-cache]] (signature `regression:pdp-edge-served-variant-use-cache:d8a4a990a058`). The DevOps Director queues the build (auto-approve within its leash; pre-M4 the CEO queues it).
