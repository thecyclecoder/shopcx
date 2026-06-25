# Storefront PDP — eliminate Next 16 PPR metadata-boundary resume mismatch under bot UAs

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `next.config.ts::real-bug`
**Repair-signature:** `vercel:f4af4729bb3b1f8c`

Stop the recurring 'Expected the resume to render <div> in this slot but instead it rendered <__next_metadata_boundary__>' error on /store/superfoods/[slug] and restore SSR (not CSR) HTML for bot crawlers, by forcing Next 16's MetadataWrapper to use the same blocking-metadata shell shape for every render so the PPR resume replay matches the build-time prerender.

## Problem (from Control Tower signature `vercel:f4af4729bb3b1f8c`)
The cached storefront PDP (src/app/(storefront)/store/[workspace]/[slug]/page.tsx) declares generateMetadata and runs under cacheComponents: true (PPR). Next's MetadataWrapper (node_modules/next/dist/lib/metadata/metadata.js:130-148) renders <div hidden><MetadataBoundary>…</MetadataBoundary></div> when serveStreamingMetadata is true and <MetadataBoundary>…</MetadataBoundary> directly when it is false. shouldServeStreamingMetadata (server/lib/streaming-metadata.js) flips based on the request UA matching HTML_LIMITED_BOT_UA_RE. The build-time prerender (no UA) takes the streaming branch and bakes a <div> into the shell; runtime requests from HTML-limited bots take the blocking branch and the resume tries to render <__next_metadata_boundary__> in that <div> slot, so React's replay throws and bails out to client-side rendering. Visitors still see a page, but bots get CSR (SEO regression) and the error feed has been logging this for hours.

**Likely target:** `next.config.ts`

## Phase 1 — close it
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-trigger the originating condition (signature `vercel:f4af4729bb3b1f8c`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `vercel:f4af4729bb3b1f8c` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
