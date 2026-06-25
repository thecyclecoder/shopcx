# Fix /widget resume mismatch — wrap widget layout in a host element so metadata boundary doesn't collide with the page root

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `src/app/widget/[workspaceid]/layout.tsx::real-bug`
**Repair-signature:** `vercel:975c7f77eb7132e6`

Stop /widget/[workspaceId] from falling back to client rendering on every prerender resume by giving the widget layout a stable host-element root, so Next's streamed metadata boundary can't occupy the slot React expects the page's root <div> to fill.

## Problem (from Control Tower signature `vercel:975c7f77eb7132e6`)
Vercel error digest 34312922 on /widget/[workspaceId]: 'Expected the resume to render <div> in this slot but instead it rendered <__next_metadata_boundary__>'. src/app/widget/[workspaceId]/layout.tsx is the only layout in the tree that BOTH `export const metadata = { title: 'Chat — ShopCX' }` AND returns a bare `<Suspense fallback={null}>{children}</Suspense>` with no host-element root. Sibling layouts portal/layout.tsx and journey/layout.tsx use the same bare-Suspense pattern but DON'T export metadata, so they don't trip it; (storefront)/layout.tsx exports metadata but wraps children in a `<div>` so the metadata boundary has a stable sibling slot. Result: PPR/cacheComponents resume sees `<__next_metadata_boundary__>` where it cached a `<div>` from the client widget page, mismatches the tree, and forces a full client re-render — losing prerender benefits and emitting an error to the feed on every request.

**Likely target:** `src/app/widget/[workspaceId]/layout.tsx`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:975c7f77eb7132e6`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:975c7f77eb7132e6` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
