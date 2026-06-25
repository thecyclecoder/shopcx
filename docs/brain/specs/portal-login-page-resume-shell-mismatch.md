# Portal login page: wrap LoginClient in a host element so PPR resume shell matches

**Owner:** [[../functions/retention]] · **Parent:** [[../functions/retention]] § Churn prevention & win-back — the portal is the account/subscription surface; a CSR fallback degrades the login UX · **Verdict:** real-bug
**Repair-root-cause:** `src/app/portal/[slug]/login/loginclient.tsx (wrap the returned suspense in a stable div classname=portal-login-root host element so the page-level metadata boundary becomes a sibling slot rather than displacing the div the prerender baked; cross-reference the operational-rules.md ppr rule and add a one-line comment matching the pattern in widget/[workspaceid]/layout.tsx)::real-bug`
**Repair-signature:** `vercel:3a1643d5eaeafc2f`

Eliminate the Vercel 'Expected the resume to render <div> in this slot but instead it rendered <__next_metadata_boundary__>' error (digest 34312922) emitted on /portal/[slug]/login, so the page resumes from the prerendered shell instead of bailing to client rendering — keeping the metadata boundary plumbing consistent with the operational rule documented for layouts that export metadata.

## Problem (from Control Tower signature `vercel:3a1643d5eaeafc2f`)
src/app/portal/[slug]/login/page.tsx exports an async generateMetadata in addition to the layout's. With cacheComponents:true and PPR resume, the page-level <__next_metadata_boundary__> Next 16 inserts into the page subtree lands in the same slot the prerender baked a <div>, because LoginClient root-renders a bare <Suspense fallback={...}> with no parent host element. React detects the tree-shape mismatch and falls back to client rendering, emitting the digest-34312922 error to Vercel's error feed. The same root cause and fix are already documented in docs/brain/operational-rules.md (widget/help layouts) and the htmlLimitedBots:/(?!)/ next.config.ts hardening — that config fix only neutralizes the bot-UA branch divergence, not a page-level metadata boundary slotting into a <div>.

**Likely target:** `src/app/portal/[slug]/login/LoginClient.tsx (wrap the returned <Suspense> in a stable <div className="portal-login-root"> host element so the page-level metadata boundary becomes a sibling slot rather than displacing the <div> the prerender baked; cross-reference the operational-rules.md PPR rule and add a one-line comment matching the pattern in widget/[workspaceId]/layout.tsx)`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:3a1643d5eaeafc2f`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:3a1643d5eaeafc2f` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
