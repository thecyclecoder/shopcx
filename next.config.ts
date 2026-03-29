import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent 308 trailing-slash redirects — Shopify app proxy follows 3xx redirects,
  // which breaks the proxy flow (redirects to storefront instead of proxying to backend)
  skipTrailingSlashRedirect: true,

  async rewrites() {
    return [
      // Shopify App Proxy target — /portal rewrites to /api/portal internally
      {
        source: "/portal",
        destination: "/api/portal",
      },
    ];
  },
};

export default nextConfig;
