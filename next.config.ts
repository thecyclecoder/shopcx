import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components (Next 16): enables the `'use cache'` directive so the
  // PDP can cache per `?_sxv=<variantId>` arm. Without this the page reads
  // searchParams and renders dynamically on every request, defeating the
  // pdp-edge-served-experiments per-arm cache contract.
  cacheComponents: true,
  // Metadata-streaming for NON-bot UAs. With cacheComponents on, every prerendered
  // route is PPR and bakes the STREAMING metadata wrapper into its build-time shell:
  // <div hidden><MetadataBoundary/></div> (export runs with no UA, where Next hardcodes
  // serveStreamingMetadata=true). `/(?!)/` is a regex that never matches, so the runtime
  // shouldServeStreamingMetadata() returns true for every non-bot request → their resume
  // shell matches the prerendered shell.
  //
  // ⚠️ This does NOT cover HTML-limited bots. Next's app-page handler computes
  //   serveStreamingMetadata = botType && isRoutePPREnabled ? false : !ua ? true
  //     : shouldServeStreamingMetadata(ua, htmlLimitedBots)
  // and the leading `botType && isRoutePPREnabled` short-circuit forces the BLOCKING branch
  // (a bare <__next_metadata_boundary__>) for bots, IGNORING this htmlLimitedBots value. On
  // an ISR revalidate triggered by a bot crawl, the cached shell is poisoned to the blocking
  // shape; a later resume then throws "Expected the resume to render <div> … rendered
  // <__next_metadata_boundary__>" and React bails /store, /widget, /portal, /help to CSR.
  // htmlLimitedBots cannot fix that branch, and `dynamic`/`experimental_ppr` opt-outs are
  // rejected under cacheComponents. The actual fix neutralizes the bot UA at the edge in
  // src/proxy.ts so getBotType() returns undefined and bots take this same streaming branch.
  // See docs/brain/recipes/next16-metadata-boundary-csr-bail.md.
  htmlLimitedBots: /(?!)/,
  // Prevent 308 trailing-slash redirects — Shopify app proxy follows 3xx redirects,
  // which breaks the proxy flow (redirects to storefront instead of proxying to backend)
  skipTrailingSlashRedirect: true,
  // The storefront blueprint PDP gate calls `forbidden()` from `next/navigation`
  // (src/app/(storefront)/store/[workspace]/[slug]/page.tsx) to return a real 403
  // when a non-owner reaches a preview-only / not-yet-serving lander. That API is
  // gated behind Next's `experimental.authInterrupts` flag — without it, hitting
  // the gate throws a runtime error ("forbidden() is not enabled") and the page
  // 500s instead of rendering the intended 403. `scripts/_check-authinterrupts-when-forbidden-imported.ts`
  // (wired into `npm run predeploy`) fails the build if this flag is dropped while
  // any src/ file still imports `forbidden` from `next/navigation`.
  experimental: {
    authInterrupts: true,
  },
  // Keep the Remotion Lambda client external (not webpack-bundled) so Vercel's
  // file tracer includes it in the serverless function's node_modules — the
  // Inngest render step dynamic-imports it to call AWS Lambda. Without this the
  // function throws "Cannot find package '@remotion/lambda'" at runtime.
  serverExternalPackages: ["@remotion/lambda", "@remotion/lambda-client", "ffmpeg-static"],
  // The /dashboard/roadmap server component reads docs/brain (lifecycles, archive, functions) at
  // request time — specs AND goals come from Supabase now (spec-readers-from-db-retire-parser,
  // goal-readers-from-db-retire-parsegoal). Vercel's file tracer prunes files nothing imports, so
  // include the brain markdown explicitly or the route renders empty on its own data in production.
  outputFileTracingIncludes: {
    // The function layer still reads docs/brain/functions — trace it into every roadmap route that
    // resolves the taxonomy (board, map, spec/goal/function detail). Goals no longer read markdown
    // (goal-readers-from-db-retire-parsegoal). Vercel prunes docs/brain otherwise.
    "/dashboard/roadmap": ["./docs/brain/lifecycles/**/*.md", "./docs/brain/archive.md", "./docs/brain/archive.d/**/*.md", "./docs/brain/functions/**/*.md"],
    "/dashboard/roadmap/[slug]": ["./docs/brain/functions/**/*.md"],
    "/dashboard/roadmap/map": ["./docs/brain/functions/**/*.md"],
    "/dashboard/roadmap/goals/[slug]": ["./docs/brain/functions/**/*.md"],
    "/dashboard/roadmap/functions/[slug]": ["./docs/brain/functions/**/*.md"],
    // The Developer → Spec Tests page (spec-test-agent) reads archive.d to list shipped-unverified specs
    // (getRoadmap is DB-driven now — spec-readers-from-db-retire-parser; listArchivedSlugs still hits disk).
    "/dashboard/developer/spec-tests": ["./docs/brain/archive.d/**/*.md"],
    "/dashboard/brain": ["./docs/brain/**/*.md"],
    "/dashboard/brain/[...slug]": ["./docs/brain/**/*.md"],
    // The authoring chat injects the brain index (getBrainTree → walks docs/brain) into
    // its Opus system prompt for grounding; trace the markdown into its bundle.
    "/api/roadmap/chat": ["./docs/brain/**/*.md"],
    // brain-index-refresh regenerates archive.md (← archive.d/) and
    // the README folder counts (← the whole tree), so the cron bundle needs all of docs/brain.
    // The creative-finder-video pipeline spawns the bundled ffmpeg-static binary; Vercel's tracer
    // prunes the binary file otherwise, so include it explicitly (see creative-finder-video.md).
    "/api/inngest": ["./docs/brain/**/*.md", "./node_modules/ffmpeg-static/ffmpeg"],
  },
  // Note: we tried experimental.inlineCss — Next.js recommends it for
  // Tailwind — but on a page with 11 sections the inlined <style>
  // bloated to 162 KB, pushing the hero <img> from byte ~5K to byte
  // ~167K in the HTML. That delayed LCP more than the extra CSS
  // round-trip ever would. Keep CSS as a separate resource; it loads
  // in parallel with HTML and lets the browser discover the hero
  // during the first few KB of HTML streaming.

  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.shopify.com" },
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "**.supabase.in" },
    ],
    // Hold optimized variants at the edge for a year. Upload endpoint
    // writes new URLs on replace, so there's no "stale cache" risk —
    // changing the image changes the URL.
    minimumCacheTTL: 31536000,
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
