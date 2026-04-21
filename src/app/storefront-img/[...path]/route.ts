import type { NextRequest } from "next/server";

/**
 * Edge image proxy — /storefront-img/{bucket}/{objectPath...}
 *
 * Streams Supabase Storage public objects through Vercel's edge,
 * replacing Supabase's `Cache-Control: no-cache` with headers that
 * actually let Vercel's CDN hold the response.
 *
 * Critical: Next.js 16 Route Handlers with dynamic segments are
 * dynamic-by-default, which means Vercel won't cache the response
 * based on Cache-Control: s-maxage alone. The Vercel-specific
 * `CDN-Cache-Control` header is the escape hatch — it forces edge
 * CDN caching regardless of runtime designation. We set all three
 * cache headers so we hit every code path:
 *
 *   - Cache-Control        → browser + any intermediate proxy
 *   - Vercel-CDN-Cache-Control → Vercel's edge CDN (takes precedence)
 *   - CDN-Cache-Control    → generic CDN directive
 *
 * After the first request to a given variant URL anywhere in the
 * world, subsequent requests to the same Vercel edge POP return in
 * single-digit ms without ever touching Supabase again.
 */

export const runtime = "edge";
// revalidate=false hints Next's Data Cache layer that the underlying
// fetch result is long-lived; paired with CDN-Cache-Control, Vercel
// also holds the Route Handler response at the edge.
export const revalidate = 31536000;

const CLIENT_CACHE = "public, max-age=31536000, immutable";
const EDGE_CACHE = "public, max-age=31536000, immutable";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const segs = path || [];
  if (segs.length < 2) {
    return new Response("Bad request", { status: 400 });
  }

  const [bucket, ...rest] = segs;
  if (bucket !== "product-media") {
    return new Response("Bucket not allowed", { status: 403 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return new Response("Not configured", { status: 500 });

  const objectPath = rest.map((s) => encodeURIComponent(s)).join("/");
  const upstream = `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;

  const etag = request.headers.get("if-none-match");
  const ifModified = request.headers.get("if-modified-since");

  const originRes = await fetch(upstream, {
    headers: {
      ...(etag ? { "If-None-Match": etag } : {}),
      ...(ifModified ? { "If-Modified-Since": ifModified } : {}),
    },
    cache: "force-cache",
    next: { revalidate: 31536000 },
  });

  const cacheHeaders: Record<string, string> = {
    "Cache-Control": CLIENT_CACHE,
    "Vercel-CDN-Cache-Control": EDGE_CACHE,
    "CDN-Cache-Control": EDGE_CACHE,
  };

  if (originRes.status === 304) {
    return new Response(null, {
      status: 304,
      headers: cacheHeaders,
    });
  }

  if (!originRes.ok) {
    return new Response(originRes.statusText || "Not found", {
      status: originRes.status,
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }

  const headers = new Headers(cacheHeaders);
  const contentType = originRes.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const originEtag = originRes.headers.get("etag");
  if (originEtag) headers.set("ETag", originEtag);

  // Note: no Vary header. Accept-Encoding variation is handled by
  // Vercel's CDN implicitly, and a manual Vary can fragment the cache
  // in ways that produce apparent MISS on every request.

  return new Response(originRes.body, { status: 200, headers });
}
