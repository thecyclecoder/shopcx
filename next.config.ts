import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent 308 trailing-slash redirects — Shopify app proxy follows 3xx redirects,
  // which breaks the proxy flow (redirects to storefront instead of proxying to backend)
  skipTrailingSlashRedirect: true,
  // Keep the Remotion Lambda client external (not webpack-bundled) so Vercel's
  // file tracer includes it in the serverless function's node_modules — the
  // Inngest render step dynamic-imports it to call AWS Lambda. Without this the
  // function throws "Cannot find package '@remotion/lambda'" at runtime.
  serverExternalPackages: ["@remotion/lambda", "@remotion/lambda-client"],
  // The /dashboard/roadmap server component reads docs/brain/specs (+ lifecycles) at
  // request time. Vercel's file tracer prunes files nothing imports, so include the
  // brain markdown explicitly or the route renders empty on its own data in production.
  outputFileTracingIncludes: {
    "/dashboard/roadmap": ["./docs/brain/specs/**/*.md", "./docs/brain/lifecycles/**/*.md"],
    "/dashboard/roadmap/[slug]": ["./docs/brain/specs/**/*.md"],
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
