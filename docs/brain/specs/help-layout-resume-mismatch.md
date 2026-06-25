# ✅ Fix /help/[slug]/[articleSlug] resume mismatch — wrap help layout in a host element so the metadata boundary doesn't collide with the page root

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/app/help/layout.tsx::real-bug`
**Repair-signature:** `vercel:babb63e4abbf5a59`

Stop /help/[slug]/[articleSlug] (and any sibling help-center route) from falling back to client rendering on every PPR resume by giving src/app/help/layout.tsx a stable host-element root, so Next's streamed <__next_metadata_boundary__> (injected because the help-article page exports generateMetadata) can't occupy the slot React expects the page's root <div> to fill. Mirrors the already-shipped widget-layout-resume-mismatch fix; restores SSR HTML for the KB minisite and stops the recurring Vercel error tile.

## Problem (from Control Tower signature `vercel:babb63e4abbf5a59`)
Vercel error digest 34312922 on /help/[slug]/[articleSlug] (host help.superfoodscompany.com, signature vercel:babb63e4abbf5a59): 'Expected the resume to render <div> in this slot but instead it rendered <__next_metadata_boundary__>'. src/app/help/layout.tsx returns bare `<Suspense fallback={null}>{children}</Suspense>` with no host-element root, while src/app/help/[slug]/[articleSlug]/page.tsx (and src/app/help/[slug]/page.tsx) export `async function generateMetadata`. Next 16 streams a `<__next_metadata_boundary__>` into the layout's child slot; with cacheComponents on, PPR resume sees the boundary where the prerender placed the page's `<div className='min-h-screen bg-zinc-50'>` root, mismatches the tree, and forces a full client re-render — exact same class as the folded widget-layout-resume-mismatch (operational-rules.md §82 'Layouts that export metadata must wrap children in a host element'; the rule's spirit covers child pages whose generateMetadata feeds the same layout slot). The (storefront)/layout.tsx and widget/[workspaceId]/layout.tsx fix wraps `<Suspense>` in a stable `<div>` so the metadata boundary has a sibling slot — help/layout.tsx needs the same treatment.

**Likely target:** `src/app/help/layout.tsx`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

Wrapped `src/app/help/layout.tsx` `<Suspense fallback={null}>{children}</Suspense>` in a stable host-element `<div className="help-root">`, mirroring `src/app/widget/[workspaceId]/layout.tsx` and `src/app/(storefront)/layout.tsx`. The metadata boundary streamed by Next 16 (because the help [slug] + [articleSlug] pages both export `generateMetadata`) now lives as a sibling of `<Suspense>` inside the stable `.help-root` host, so PPR resume no longer sees `<__next_metadata_boundary__>` where it expected the page's root `<div>`.

## Verification
- On help.superfoodscompany.com/<slug> (KB minisite root) → view-source contains the article cards + footer (SSR HTML, not a client shell), and the browser console shows no React resume mismatch warning.
- On help.superfoodscompany.com/<slug>/<articleSlug> (any published article) → view-source contains the article title + body, and no new error_events row appears with signature `vercel:babb63e4abbf5a59`.
- On Control Tower (/dashboard/control-tower) → the `vercel:babb63e4abbf5a59` tile stays green (no fresh loop_alert) after the next prod deploy.
- In Vercel logs for the help.superfoodscompany.com host → grep for digest `34312922` returns no new entries after the deploy that lands this PR.

> Authored by the box Repair Agent from Control Tower signature `vercel:babb63e4abbf5a59` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
