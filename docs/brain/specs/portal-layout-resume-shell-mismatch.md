# Portal mini-site root: wrap layout Suspense in a host element so PPR resume shell matches

**Owner:** [[../functions/retention]] · **Parent:** [[../functions/retention]] § Churn prevention & win-back — the portal home is the account/subscription surface; a CSR fallback degrades the logged-in experience. Sibling of [[../specs/portal-login-page-resume-shell-mismatch]]; extends operational-rules.md § 'Layouts that export metadata must wrap children in a host element' · **Verdict:** real-bug
**Repair-root-cause:** `src/app/portal/layout.tsx (wrap the returned suspense in a stable div classname=portal-root host element so the metadata boundary from the [slug] layout becomes a sibling slot rather than displacing the cached div; cross-reference operational-rules.md § layouts that export metadata must wrap children in a host element in an inline comment, matching the pattern in src/app/help/layout.tsx and src/app/widget/[workspaceid]/layout.tsx)::real-bug`
**Repair-signature:** `vercel:5942e69f6e405813`

Eliminate the Vercel 'Expected the resume to render <div> in this slot but instead it rendered <__next_metadata_boundary__>' error (digest 34312922) emitted on /portal/[slug], so the page resumes from the prerendered shell instead of bailing to client rendering — bringing the portal mini-site root in line with the help-layout / widget-layout / portal-login fixes already documented in operational-rules.md.

## Problem (from Control Tower signature `vercel:5942e69f6e405813`)
src/app/portal/layout.tsx returns a bare <Suspense fallback={null}>{children}</Suspense> with NO parent host element. The child segment src/app/portal/[slug]/layout.tsx exports an async generateMetadata, so under Next 16 cacheComponents:true + PPR resume the <__next_metadata_boundary__> Next streams for that metadata lands in the parent layout's child slot — exactly where the prerender baked the [slug] layout's root <div>. React detects the tree-shape mismatch and falls back to client rendering, emitting the digest-34312922 error to Vercel's error feed (signature vercel:5942e69f6e405813, surface path=/portal/[slug], host=portal.superfoodscompany.com). The same root cause + fix are already documented in operational-rules.md and shipped at src/app/help/layout.tsx, src/app/widget/[workspaceId]/layout.tsx, and src/app/portal/[slug]/login/LoginClient.tsx; the portal root layout was simply missed.

**Likely target:** `src/app/portal/layout.tsx (wrap the returned <Suspense> in a stable <div className="portal-root"> host element so the metadata boundary from the [slug] layout becomes a sibling slot rather than displacing the cached <div>; cross-reference operational-rules.md § 'Layouts that export metadata must wrap children in a host element' in an inline comment, matching the pattern in src/app/help/layout.tsx and src/app/widget/[workspaceId]/layout.tsx)`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:5942e69f6e405813`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:5942e69f6e405813` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
