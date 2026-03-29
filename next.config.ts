import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // Shopify App Proxy target — must NOT be under /api/ to avoid 308 redirects
      {
        source: "/portal",
        destination: "/api/portal",
      },
    ];
  },
};

export default nextConfig;
