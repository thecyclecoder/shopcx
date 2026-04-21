import type { NextRequest } from "next/server";

/**
 * Edge image proxy — /storefront-img/{bucket}/{objectPath...}
 *
 * Streams Supabase Storage public objects through Vercel's edge, but
 * rewrites the Cache-Control header so the response is actually
 * cacheable by Vercel's CDN. Supabase currently serves public bucket
 * objects with `Cache-Control: no-cache`, which kills edge caching
 * even though the content is genuinely immutable (every upload gets
 * a unique timestamped filename).
 *
 * The proxy adds:
 *   Cache-Control: public, max-age=31536000, immutable, s-maxage=31536000
 *
 * After the first request to a given variant URL anywhere in the
 * world, subsequent requests to the same Vercel edge POP return in
 * single-digit milliseconds without ever touching Supabase again.
 *
 * Runtime: edge. Adds ~5-10ms vs direct Supabase, but gains universal
 * edge caching, which is a net 300-400ms win on warm cache hits.
 */

export const runtime = "edge";

// Hold on the Vercel edge for a year.
const PUBLIC_CACHE = "public, max-age=31536000, immutable, s-maxage=31536000";

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
    // Allowlist — don't let this become a generic Supabase proxy.
    return new Response("Bucket not allowed", { status: 403 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return new Response("Not configured", { status: 500 });

  const objectPath = rest.map((s) => encodeURIComponent(s)).join("/");
  const upstream = `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;

  // Forward If-None-Match so conditional requests can short-circuit.
  const etag = request.headers.get("if-none-match");
  const ifModified = request.headers.get("if-modified-since");

  const originRes = await fetch(upstream, {
    headers: {
      ...(etag ? { "If-None-Match": etag } : {}),
      ...(ifModified ? { "If-Modified-Since": ifModified } : {}),
    },
    // Explicitly ask the runtime to cache aggressively — this hints
    // Vercel's fetch layer that the response is long-lived.
    cache: "force-cache",
    next: { revalidate: 31536000 },
  });

  if (originRes.status === 304) {
    const headers = new Headers();
    headers.set("Cache-Control", PUBLIC_CACHE);
    return new Response(null, { status: 304, headers });
  }

  if (!originRes.ok) {
    // Don't cache errors.
    return new Response(originRes.statusText || "Not found", {
      status: originRes.status,
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }

  const headers = new Headers();
  const contentType = originRes.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const contentLength = originRes.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);
  const originEtag = originRes.headers.get("etag");
  if (originEtag) headers.set("ETag", originEtag);

  // Override whatever Supabase said.
  headers.set("Cache-Control", PUBLIC_CACHE);
  // Help CDN intermediaries key correctly.
  headers.set("Vary", "Accept-Encoding");

  return new Response(originRes.body, { status: 200, headers });
}
