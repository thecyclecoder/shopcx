# Recipe: enable `experimental.authInterrupts` so `forbidden()` returns a real 403

> "The Amazing Coffee storefront hit a blueprint lander visibility gate and 500'd with Next.js complaining that `forbidden()` is not enabled." — vercel signature `vercel:68f6fc9180f7730f`

Next 16's `forbidden()` and `unauthorized()` interrupts from `next/navigation` are behind an experimental flag. Every non-owner request that trips a gated storefront route (draft / rolled-back / owner-preview-only blueprint lander) crashes at runtime until the flag is set. It's a **config-level rail** — not a code bug — that tsc cannot catch on its own (both the flag-on and flag-off states type-check identically).

## The fix

Add `experimental.authInterrupts: true` to [[../../next.config.ts]]. Preserve every other key (`cacheComponents`, `htmlLimitedBots`, `skipTrailingSlashRedirect`, `serverExternalPackages`, `outputFileTracingIncludes`, `images`) exactly as they were — this flag composes with them, it doesn't replace them.

```ts
const nextConfig: NextConfig = {
  cacheComponents: true,
  // ...existing keys...
  experimental: {
    authInterrupts: true,
  },
  images: { /* ... */ },
};
```

That's it. The three `forbidden()` call sites in [[../../src/app/(storefront)/store/[workspace]/[slug]/page.tsx]] (the owner-vs-public visibility gate — preview mode, unmapped funnel type, and lander-type-not-yet-serving) now render a real 403 interrupt instead of throwing.

## The gate the flag protects

`src/app/(storefront)/store/[workspace]/[slug]/page.tsx` at ~L304-325 has two disjoint gates around the blueprint PDP:

- `?preview=1` → owner-only. Non-owner → `forbidden()`.
- No preview flag → public **iff** the paired `storefront_experiments` row is SERVING (`running` / `promoted`). Every other status (draft / killed / rolled_back) → owner-only, non-owner → `forbidden()`.
- Unmapped `funnel_type` → owner-only by default (a lander_type the optimizer can't wire is by definition never serving).

Without `experimental.authInterrupts`, all three call sites throw the `forbidden() is not enabled` runtime error, so the gate that was supposed to return 403 returns 500 instead — private landers leak an error page to the world, and the intended block still isn't honored (the request is dropped, not gated).

## The guard that prevents regression

`scripts/_check-authinterrupts-when-forbidden-imported.ts` runs in `npm run predeploy` (chained after the last `check:*` step, before deploy). It:

1. Walks `src/` and flags every file with `import { ..., forbidden, ... } from "next/navigation"`.
2. If any importer exists, greps `next.config.ts` for `experimental: { ... authInterrupts: true ... }`.
3. Exits non-zero with the list of importers + a copy-pasteable fix if the flag is missing.

`scripts/_check-authinterrupts-when-forbidden-imported.test.ts` (three `node --test` cases) pins:

- The extractor finds the `experimental` block.
- The predicate accepts the current `next.config.ts` (green baseline).
- The predicate **rejects** an `experimental` block that omits `authInterrupts` (the failing-state pin — the exact shape the pre-fix repo was in).

Together they mean a future edit that drops the flag while the storefront PDP gate still calls `forbidden()` fails the predeploy rail — no runtime "forbidden() is not enabled" on production traffic.

## Why not `notFound()` instead

The gate is intentionally a 403 — the founder needs the owner-preview URL to render for themselves while the same URL 403s for the public. Converting to `notFound()` would collapse both cases to 404 and break the owner's ability to verify a promoted lander's URL end-to-end from their own browser. Enabling the config flag is the load-bearing fix; the code path was already correct.

## Related

- [[next16-metadata-boundary-csr-bail.md]] — another Next 16 config-shape rail (metadata boundary shape divergence under PPR + bot UAs).
- [[next16-empty-generate-static-params-preview-build.md]] — the `generateStaticParams` + preview-build interaction under `cacheComponents`.
