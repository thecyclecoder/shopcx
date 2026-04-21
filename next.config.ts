import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent 308 trailing-slash redirects — Shopify app proxy follows 3xx redirects,
  // which breaks the proxy flow (redirects to storefront instead of proxying to backend)
  skipTrailingSlashRedirect: true,
  experimental: {
    // Inline CSS as <style> in <head> instead of emitting <link rel=
    // stylesheet>. Eliminates a render-blocking round trip for first-
    // time visitors — critical for the storefront LCP. Trade-off: no
    // cached stylesheet for returning visitors, but landing-page
    // traffic is overwhelmingly first-time so it's a net win.
    inlineCss: true,
  },
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
