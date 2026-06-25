import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components (Next 16): enables the `'use cache'` directive so the
  // PDP can cache per `?_sxv=<variantId>` arm. Without this the page reads
  // searchParams and renders dynamically on every request, defeating the
  // pdp-edge-served-experiments per-arm cache contract.
  cacheComponents: true,
  // Prevent 308 trailing-slash redirects — Shopify app proxy follows 3xx redirects,
  // which breaks the proxy flow (redirects to storefront instead of proxying to backend)
  skipTrailingSlashRedirect: true,
  // Keep the Remotion Lambda client external (not webpack-bundled) so Vercel's
  // file tracer includes it in the serverless function's node_modules — the
  // Inngest render step dynamic-imports it to call AWS Lambda. Without this the
  // function throws "Cannot find package '@remotion/lambda'" at runtime.
  serverExternalPackages: ["@remotion/lambda", "@remotion/lambda-client", "ffmpeg-static"],
  // The /dashboard/roadmap server component reads docs/brain/specs (+ lifecycles) at
  // request time. Vercel's file tracer prunes files nothing imports, so include the
  // brain markdown explicitly or the route renders empty on its own data in production.
  outputFileTracingIncludes: {
    // The goal/function layer reads docs/brain/{goals,functions} too — trace them into every
    // roadmap route that resolves the taxonomy (board, map, spec/goal/function detail). Vercel
    // prunes docs/brain otherwise. See docs/brain/specs/goal-decomposition-engine.md.
    "/dashboard/roadmap": ["./docs/brain/specs/**/*.md", "./docs/brain/lifecycles/**/*.md", "./docs/brain/archive.md", "./docs/brain/archive.d/**/*.md", "./docs/brain/goals/**/*.md", "./docs/brain/functions/**/*.md"],
    "/dashboard/roadmap/[slug]": ["./docs/brain/specs/**/*.md", "./docs/brain/goals/**/*.md", "./docs/brain/functions/**/*.md"],
    "/dashboard/roadmap/map": ["./docs/brain/specs/**/*.md", "./docs/brain/goals/**/*.md", "./docs/brain/functions/**/*.md"],
    "/dashboard/roadmap/goals": ["./docs/brain/specs/**/*.md", "./docs/brain/goals/**/*.md"],
    "/dashboard/roadmap/goals/[slug]": ["./docs/brain/specs/**/*.md", "./docs/brain/goals/**/*.md", "./docs/brain/functions/**/*.md"],
    "/dashboard/roadmap/functions/[slug]": ["./docs/brain/specs/**/*.md", "./docs/brain/goals/**/*.md", "./docs/brain/functions/**/*.md"],
    // The Developer → Spec Tests page (spec-test-agent) reads specs + archive.d to list shipped-unverified
    // specs (getRoadmap / listArchivedSlugs); the board card chip needs them too (already covered above).
    "/dashboard/developer/spec-tests": ["./docs/brain/specs/**/*.md", "./docs/brain/archive.d/**/*.md"],
    "/dashboard/brain": ["./docs/brain/**/*.md"],
    "/dashboard/brain/[...slug]": ["./docs/brain/**/*.md"],
    // The authoring chat injects the brain index (getBrainTree → walks docs/brain) into
    // its Opus system prompt for grounding; trace the markdown into its bundle.
    "/api/roadmap/chat": ["./docs/brain/**/*.md"],
    // The build dispatch POST runs the spec-blockers enqueue gate (queueRoadmapBuild → getSpecBlockers →
    // getRoadmap reads docs/brain/specs at request time). Trace the specs in or the gate sees zero blockers
    // in prod and silently passes. See docs/brain/specs/spec-blockers.md.
    "/api/roadmap/build": ["./docs/brain/specs/**/*.md"],
    // The Slack Roadmap Console renders the board/detail from the brain markdown (getRoadmap /
    // getSpec) inside the slash-command + Inngest-watcher bundles. Trace the specs in or they
    // render empty in prod. See docs/brain/specs/slack-roadmap-console-run-the-build-console-from-slack.md.
    "/api/slack/events": ["./docs/brain/specs/**/*.md"],
    // The interactions handler builds the App Home roadmap view (slack-home → getRoadmap) after a
    // queued build, so it reads the brain specs too. See docs/brain/specs/slack-roadmap-home.md.
    "/api/slack/interactions": ["./docs/brain/specs/**/*.md"],
    // slack-roadmap-notify reads specs; brain-index-refresh regenerates archive.md (← archive.d/) and
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
