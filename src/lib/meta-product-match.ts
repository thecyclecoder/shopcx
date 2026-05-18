/**
 * Match URLs found in a Meta post / ad to a `products` row by handle.
 *
 * Strategy:
 *   1. Direct match — if the host is the workspace's storefront domain
 *      (or `shopify_domain`), extract the path's first segment and look
 *      it up as `products.handle`.
 *   2. Known shortlink hosts (bit.ly, linktr.ee, lnk.bio, sprfd.co) →
 *      follow ONE redirect with a short timeout and try again. We don't
 *      chain — multi-hop shortlinks are rare and the cost grows fast.
 *   3. First match wins. No match → null.
 *
 * Designed to be cheap: no DB writes, no Graph API calls. The caller
 * (post cache hydrator) is the one that persists the result.
 */

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

const SHORTLINK_HOSTS = new Set([
  "bit.ly",
  "linktr.ee",
  "lnk.bio",
  "sprfd.co",
  "buff.ly",
  "ow.ly",
  "tinyurl.com",
  "rebrand.ly",
  "t.co",
  "lnk.to",
]);

// Vendor paths to ignore when looking for a product handle. Without this
// list, /collections/all or /pages/about would try to match against
// products.handle and waste a query.
const NON_PRODUCT_PREFIXES = new Set([
  "collections",
  "pages",
  "blogs",
  "cart",
  "account",
  "policies",
  "search",
  "challenge",
]);

interface WorkspaceHosts {
  hosts: Set<string>;
}

/**
 * Resolve any URL → matched products.id, or null.
 *
 * @param admin       service-role client
 * @param workspaceId workspace scope for product lookups
 * @param urls        candidate URLs pulled from post body + attachments
 */
export async function resolvePostProductMatch(
  admin: Admin,
  workspaceId: string,
  urls: string[],
): Promise<string | null> {
  if (!urls.length) return null;

  const hosts = await loadWorkspaceHosts(admin, workspaceId);

  for (const raw of urls) {
    const matched = await tryUrl(admin, workspaceId, hosts, raw, /* allowRedirect */ true);
    if (matched) return matched;
  }
  return null;
}

async function tryUrl(
  admin: Admin,
  workspaceId: string,
  hosts: WorkspaceHosts,
  raw: string,
  allowRedirect: boolean,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase().replace(/^www\./, "");

  // Direct match against our storefront / shopify domain.
  if (hosts.hosts.has(host)) {
    const handle = extractProductHandle(url.pathname);
    if (!handle) return null;
    const { data: product } = await admin
      .from("products")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("handle", handle)
      .maybeSingle();
    return product?.id ?? null;
  }

  // Shortlinks — follow ONCE.
  if (allowRedirect && SHORTLINK_HOSTS.has(host)) {
    const resolved = await followRedirect(raw);
    if (resolved && resolved !== raw) {
      return tryUrl(admin, workspaceId, hosts, resolved, /* allowRedirect */ false);
    }
  }

  return null;
}

/**
 * Pull the canonical product handle out of a Shopify-style path:
 *   /products/amazing-coffee          → 'amazing-coffee'
 *   /products/amazing-coffee?ref=fb   → 'amazing-coffee'
 *   /amazing-coffee                   → 'amazing-coffee' (Hydrogen-style)
 *   /collections/all                  → null
 *   /pages/about                      → null
 */
function extractProductHandle(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (!segments.length) return null;

  // Shopify form: /products/<handle>
  if (segments[0] === "products" && segments[1]) {
    return segments[1].split(/[?#]/)[0];
  }

  // Hydrogen / direct form: /<handle> — only accept if first segment
  // doesn't look like a section path.
  const first = segments[0];
  if (NON_PRODUCT_PREFIXES.has(first)) return null;
  return first.split(/[?#]/)[0];
}

/**
 * Best-effort HEAD on a shortlink to find the redirect target.
 * 5s timeout, single hop. Falls back to GET if HEAD isn't allowed.
 */
async function followRedirect(href: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    let res = await fetch(href, { method: "HEAD", redirect: "manual", signal: controller.signal });
    // Some shortener hosts return 200 on HEAD with the Location absent;
    // re-run as GET for those.
    if (![301, 302, 307, 308].includes(res.status)) {
      res = await fetch(href, { method: "GET", redirect: "manual", signal: controller.signal });
    }
    const loc = res.headers.get("location");
    return loc || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadWorkspaceHosts(admin: Admin, workspaceId: string): Promise<WorkspaceHosts> {
  const { data } = await admin
    .from("workspaces")
    .select("storefront_domain, shopify_domain")
    .eq("id", workspaceId)
    .single();

  const set = new Set<string>();
  if (data?.storefront_domain) set.add(stripHost(data.storefront_domain as string));
  if (data?.shopify_domain) set.add(stripHost(data.shopify_domain as string));
  return { hosts: set };
}

function stripHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}
