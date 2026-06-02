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
  hosts: Set<string>;         // exact storefront/shopify hosts as configured
  brandRoots: Set<string>;    // last-two-labels of each, for cross-subdomain match
}

// Extract the last two labels of a host. Crude but covers the .com / .co / .net
// case the user faces here. Handles bare hosts cleanly; no eTLD library needed
// because workspace storefront domains in practice never use a multi-part TLD
// (.co.uk etc) — if that ever happens we add psl.
function registrableRoot(host: string): string {
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  return labels.slice(-2).join(".");
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
  let host = url.host.toLowerCase().replace(/^www\./, "");

  // Unwrap Facebook/Instagram link-shim URLs. Post attachments come
  // back wrapped as l.facebook.com/l.php?u=<encoded destination> (and
  // l.instagram.com on the IG side). Without unwrapping, the matcher
  // sees l.facebook.com which isn't a workspace host AND isn't in
  // SHORTLINK_HOSTS, so it never reaches the real product URL.
  // Maya Agha's ad post on the Superfoods page (ticket 1d0dc052)
  // surfaced this — `superfoodscompany.com/products/superfood-tabs`
  // was hidden behind l.facebook.com and went unmatched.
  if ((host === "l.facebook.com" || host === "l.instagram.com" || host === "lm.facebook.com") && url.pathname === "/l.php") {
    const wrapped = url.searchParams.get("u");
    if (wrapped) {
      try {
        url = new URL(wrapped);
        host = url.host.toLowerCase().replace(/^www\./, "");
      } catch { /* fall through with original url */ }
    }
  }

  // Direct match against our storefront / shopify domain, OR same
  // registrable root (matches superfoodscompany.com against a workspace
  // configured with shop.superfoodscompany.com and vice versa).
  if (hosts.hosts.has(host) || hosts.brandRoots.has(registrableRoot(host))) {
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
    .select("storefront_domain, shopify_domain, shopify_myshopify_domain, ad_destination_domains")
    .eq("id", workspaceId)
    .single();

  const hosts = new Set<string>();
  if (data?.storefront_domain) hosts.add(stripHost(data.storefront_domain as string));
  if (data?.shopify_domain) hosts.add(stripHost(data.shopify_domain as string));
  if (data?.shopify_myshopify_domain) hosts.add(stripHost(data.shopify_myshopify_domain as string));
  // Admin-curated list of additional domains the workspace runs ads on.
  // Lets ads that link to a different domain than the storefront still
  // resolve to products. Configured at Settings → Integrations → Meta.
  for (const d of (data?.ad_destination_domains as string[] | null) || []) {
    if (d) hosts.add(stripHost(d));
  }

  const brandRoots = new Set<string>();
  for (const h of hosts) brandRoots.add(registrableRoot(h));

  return { hosts, brandRoots };
}

function stripHost(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

/**
 * Haiku-based product match from a post's caption/message body.
 *
 * Use case: organic posts whose caption mentions the product by name
 * but don't link to it ("Where are our Peach Mango fans at? ... Stay
 * hydrated with Superfood Tabs ..."). The URL-based matcher returns
 * null on these; Haiku reads the caption and picks from the workspace
 * catalog.
 *
 * Returns the products.id of the best match, or null when nothing
 * obvious. Never hallucinates — the model is told to return "none"
 * when no product is clearly referenced.
 *
 * Cost: ~1k input tokens, <50 output. ~$0.0001/call. Result is cached
 * on meta_post_cache.matched_product_id, so subsequent comments on
 * the same post are a local DB read.
 */
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_TIMEOUT_MS = 6000;

export async function matchPostToProductViaAI(
  admin: Admin,
  workspaceId: string,
  postMessage: string,
): Promise<string | null> {
  if (!postMessage?.trim()) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  // Load the catalog (id + handle + title). Skip shipping-protection /
  // utility SKUs — they're never the subject of an organic post.
  const { data: products } = await admin
    .from("products")
    .select("id, title, handle")
    .eq("workspace_id", workspaceId);
  if (!products?.length) return null;
  const eligible = products.filter(p => {
    const h = (p.handle as string || "").toLowerCase();
    return !h.includes("shipping") && !h.includes("addon");
  });
  if (!eligible.length) return null;

  const catalog = eligible
    .map(p => `- id=${p.id} | handle=${p.handle} | title=${p.title}`)
    .join("\n");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 80,
        system:
          `You match a social-media post caption to a product from a small catalog. ` +
          `Read the caption and identify which catalog product (if any) is being shown or talked about. ` +
          `Match on explicit product names, recognized variants (flavors, SKU keywords), and brand-specific terms. ` +
          `If the caption doesn't clearly reference one of the catalog products, reply with "none". ` +
          `Reply with ONLY the product id (UUID) or the literal word "none". ` +
          `No prose, no preface, no explanation.`,
        messages: [{
          role: "user",
          content:
            `Catalog:\n${catalog}\n\n` +
            `Post caption:\n${postMessage.slice(0, 2000)}\n\n` +
            `Which product id? (or "none")`,
        }],
      }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { content?: Array<{ text?: string }> };
    const raw = (json.content?.[0]?.text || "").trim();
    if (!raw || raw.toLowerCase() === "none") return null;

    // Pull the first UUID-shaped substring (model occasionally
    // wraps the id with extra punctuation or context).
    const m = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!m) return null;
    const candidate = m[0].toLowerCase();
    // Confirm the id is actually in the catalog (no hallucinated UUIDs).
    return eligible.find(p => (p.id as string).toLowerCase() === candidate)?.id ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
