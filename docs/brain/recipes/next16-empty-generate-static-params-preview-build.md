# Recipe: stop the Next 16 EmptyGenerateStaticParamsError on storefront preview builds

> "Production (main) deploys clean, but every `claude/build-*` spec-build PREVIEW fails Vercel with `[Error [EmptyGenerateStaticParamsError]: When using Cache Components, all generateStaticParams functions must return at least one result…]` → `Failed to collect page data for /store/[workspace]/blog` → `Command "npm run build" exited 1`. The preview-test-promote PM flow can't run because the preview never builds."

This is a **build-time** failure on the three storefront SSG routes:

- `/store/[workspace]/[slug]` (PDP) — params from `listPublishedProducts()` in [[../../src/app/(storefront)/_lib/page-data.ts]]
- `/store/[workspace]/blog` — params from `listBlogWorkspaceParams()` in [[../../src/app/(storefront)/_lib/blog-data.ts]]
- `/store/[workspace]/blog/[handle]` — params from `listBlogPostParams()` (same file)

## Root cause (verified against the Next 16.2.9 source)

`cacheComponents: true` (in `next.config.ts`, required for the PDP's per-arm `'use cache'`) implicitly turns on PPR for every prerenderable app route. Under PPR, an empty `generateStaticParams` is a **hard build error** — `next/dist/esm/build/static-paths/app.js` throws `throwEmptyGenerateStaticParamsError()` when the returned `result.length === 0 && isRoutePPREnabled`. The rationale (per Next docs): a non-empty sample param lets the build validate the route doesn't illegally access `cookies()`/`headers()`/`searchParams` at runtime.

**Why preview fails but production succeeds — and why it is NOT an env-var problem.** Vercel **Preview** and **Production** carry the *identical* Supabase build-time env vars: `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` both point at the SAME project (`urjbhjbygyxffrfkarqn.supabase.co`) with the SAME service-role key on both targets. There is **no separate preview/staging DB** — previews already read prod. The failure is that the build-time DB query in `generateStaticParams` returns **empty** on the preview build (a transient query failure / cold egress / data-state race) where production's last successful build saw rows. With Cache Components, that empty array is fatal. So it is **data-state dependent, not env-dependent** — any build (preview or prod) that happens to see zero rows will fail.

## The fix (graceful-degrade the params, not the env)

Each helper now returns **at least one param**, falling back to a single `__placeholder__` sentinel when the query is empty:

```ts
// (storefront)/_lib/blog-data.ts
export const STOREFRONT_PARAM_PLACEHOLDER = "__placeholder__";
// listBlogWorkspaceParams / listBlogPostParams / (page-data) listPublishedProducts:
return params.length > 0 ? params : [{ workspace: "__placeholder__", /* slug|handle */ }];
```

The sentinel doesn't resolve to a real workspace/post/product, so the page's existing `notFound()` guard (`getBlogWorkspaceBySlug` / `getBlogPost` / `getPageData` all return `null` via `maybeSingle()` for an unknown slug) renders a clean **build-time 404** — a valid prerender that satisfies the `length >= 1` requirement without illegally reading runtime APIs (the bare/placeholder code paths read neither cookies/headers nor searchParams). Real product/post paths render on **first request via ISR** (`dynamicParams` defaults to `true`; no route opts out). So the preview both **builds** AND stays **functional** for spec-testing — when the DB does have rows the placeholder branch is never taken and production is byte-for-byte unaffected.

## Do NOT

- Do **not** "fix" this by adding/pointing preview env vars at a different DB — the env is already correct and shared with prod. Pointing previews at a *separate* empty DB would re-introduce the empty-params failure AND make spec-tests run against dataless previews.
- Do **not** return `[]` "to make it ISR" (the pre-Cache-Components idiom) — under `cacheComponents` that is the exact thing that throws.
- Do **not** reach for `export const dynamic = 'force-static'` / `dynamicParams` opt-outs — they're rejected/ineffective under `cacheComponents` for these routes, and the placeholder pattern is the documented Next 16 approach (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md` § With Cache Components).

## Write-risk note (previews read PROD data)

Because preview and production share the same service-role Supabase creds, **a preview deployment's runtime code writes to the production DB.** Build-time `generateStaticParams` is read-only (low risk), but any spec-test that exercises a *mutating* storefront/runtime path on a preview URL mutates prod. This is a pre-existing condition, not introduced by this fix — flag it when designing spec-tests that POST/mutate against a preview.
