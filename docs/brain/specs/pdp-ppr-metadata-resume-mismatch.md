# Storefront PDP — eliminate Next 16 PPR metadata-boundary resume mismatch under bot UAs ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** real-bug
**Repair-root-cause:** `next.config.ts::real-bug`
**Repair-signature:** `vercel:f4af4729bb3b1f8c`

Stop the recurring 'Expected the resume to render <div> in this slot but instead it rendered <__next_metadata_boundary__>' error on /store/superfoods/[slug] and restore SSR (not CSR) HTML for bot crawlers, by forcing Next 16's MetadataWrapper to use the same blocking-metadata shell shape for every render so the PPR resume replay matches the build-time prerender.

## Problem (from Control Tower signature `vercel:f4af4729bb3b1f8c`)
The cached storefront PDP (src/app/(storefront)/store/[workspace]/[slug]/page.tsx) declares generateMetadata and runs under cacheComponents: true (PPR). Next's MetadataWrapper (node_modules/next/dist/lib/metadata/metadata.js:130-148) renders <div hidden><MetadataBoundary>…</MetadataBoundary></div> when serveStreamingMetadata is true and <MetadataBoundary>…</MetadataBoundary> directly when it is false. shouldServeStreamingMetadata (server/lib/streaming-metadata.js) flips based on the request UA matching HTML_LIMITED_BOT_UA_RE. The build-time prerender (no UA) takes the streaming branch and bakes a <div> into the shell; runtime requests from HTML-limited bots take the blocking branch and the resume tries to render <__next_metadata_boundary__> in that <div> slot, so React's replay throws and bails out to client-side rendering. Visitors still see a page, but bots get CSR (SEO regression) and the error feed has been logging this for hours.

**Likely target:** `next.config.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

Fix: set `htmlLimitedBots: /(?!)/` in `next.config.ts`. Next 16 normalises the user RegExp to its `.source` string at config load (`node_modules/next/dist/server/config.js:1308-1310`) and uses that string at both build (`export/index.js:411`) and runtime (`server/base-server.js:1041` → `shouldServeStreamingMetadata`). `(?!)` is a negative lookahead against the always-matching empty pattern, so `new RegExp("(?!)", "i").test(ua)` is false for every UA → `shouldServeStreamingMetadata` returns true for every request → `MetadataWrapper` always picks the streaming branch (`<div hidden><MetadataBoundary>…</MetadataBoundary></div>`), the same shell shape baked into the prerender. No more resume mismatch; HTML-limited bots get SSR HTML instead of CSR.

## Verification
- On a deploy preview / prod, `curl -A 'facebookexternalhit/1.1' https://shopcx.ai/store/superfoods/{any-published-slug}` → expect a 200 with the full SSR HTML body (hero `<picture>`, `<h1>`, product copy, `<meta name="description">`) and `x-vercel-cache: HIT` (or PRERENDER) — not a near-empty CSR shell.
- Same `curl` with `-A 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'`, `Twitterbot/1.0`, `LinkedInBot/1.0`, `Slackbot 1.0`, `Applebot/0.1` → same: SSR HTML, no CSR fallback.
- In Control Tower, the `vercel:f4af4729bb3b1f8c` signature tile → expect green; no new `error_events` rows or `loop_alert` entries for "Expected the resume to render <div> in this slot but instead it rendered <__next_metadata_boundary__>" after the deploy.
- Vercel function logs for `/store/[workspace]/[slug]` for ~1h post-deploy → expect zero occurrences of the resume-mismatch error string.
- Quick smoke: load `https://shopcx.ai/store/superfoods/{slug}` in a regular browser (no bot UA) → expect the page renders normally, `<head>` carries the right `<title>` / `<meta name="description">` / canonical / OG tags from `generateMetadata`, no regression in LCP.

> Authored by the box Repair Agent from Control Tower signature `vercel:f4af4729bb3b1f8c` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
