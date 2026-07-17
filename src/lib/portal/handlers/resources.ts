import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Portal route: product resources for the customer (spec: blog-resources).
 *
 *   - default: resources for the products the customer owns (subscriptions
 *     across linked accounts), grouped product → grouping (Recipes / How it
 *     works / How to use / Science).
 *   - ?q=...: search ALL published resources by title/content (discovery,
 *     including products they don't own yet).
 *
 * `resourcePost?id=` returns one post's HTML for the reader view.
 */

const GROUPING_LABELS: Record<string, string> = {
  recipes: "Recipes",
  how_it_works: "How it works",
  how_to_use: "How to use",
  science: "The science",
  general: "Guides",
};
const GROUPING_ORDER = ["how_it_works", "how_to_use", "recipes", "science", "general"];

async function linkedIds(admin: ReturnType<typeof createAdminClient>, workspaceId: string, customerId: string): Promise<string[]> {
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: g } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
  const ids = (g || []).map((r) => r.customer_id as string);
  if (!ids.includes(customerId)) ids.push(customerId);
  return ids;
}

type PostRow = { id: string; title: string; excerpt: string | null; featured_image_url: string | null; handle: string | null; grouping: string | null };

export const resources: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;
  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();
  const q = (url.searchParams.get("q") || "").trim();

  // ── Search mode: across ALL published resources ──────────────────
  if (q) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const { data: hits } = await admin
      .from("posts")
      .select("id, title, excerpt, featured_image_url, handle, grouping")
      .eq("workspace_id", auth.workspaceId)
      .eq("is_resource", true)
      .eq("published", true)
      .or(`title.ilike.${like},content_text.ilike.${like}`)
      .order("published_at", { ascending: false })
      .limit(40);
    return jsonOk({ ok: true, route, mode: "search", query: q, results: hits || [] });
  }

  // ── Default: the customer's owned products, grouped ──────────────
  const ids = await linkedIds(admin, auth.workspaceId, customer.id);
  // Resolve owned product_ids from their subscriptions' items (variant_id →
  // product_variants → product_id; items store UUID or shopify id).
  const { data: subs } = await admin
    .from("subscriptions")
    .select("items")
    .eq("workspace_id", auth.workspaceId)
    .in("customer_id", ids)
    .in("status", ["active", "paused"]);
  const variantRefs = new Set<string>();
  for (const s of subs || []) {
    for (const it of ((s.items as Array<{ variant_id?: unknown; product_id?: unknown }>) || [])) {
      if (it.product_id) variantRefs.add(`pid:${String(it.product_id)}`);
      else if (it.variant_id) variantRefs.add(String(it.variant_id));
    }
  }
  const directProductIds = new Set([...variantRefs].filter((r) => r.startsWith("pid:")).map((r) => r.slice(4)));
  const lookupRefs = [...variantRefs].filter((r) => !r.startsWith("pid:"));
  if (lookupRefs.length) {
    // items[].variant_id can be a UUID (product_variants.id) or a Shopify
    // numeric id (shopify_variant_id). Split by shape so a numeric id never
    // lands on the uuid `id` side (Postgres 22P02 → the whole query fails).
    const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    const refUuids = lookupRefs.filter(isUuid);
    const refShopify = lookupRefs.filter((s) => !isUuid(s));
    let vq = admin.from("product_variants").select("product_id");
    if (refUuids.length > 0 && refShopify.length > 0) {
      vq = vq.or(`id.in.(${refUuids.join(",")}),shopify_variant_id.in.(${refShopify.map((s) => `"${s}"`).join(",")})`);
    } else if (refUuids.length > 0) {
      vq = vq.in("id", refUuids);
    } else {
      vq = vq.in("shopify_variant_id", refShopify);
    }
    const { data: vrows } = await vq;
    for (const v of vrows || []) if (v.product_id) directProductIds.add(String(v.product_id));
  }
  const productIds = [...directProductIds];
  if (productIds.length === 0) return jsonOk({ ok: true, route, mode: "owned", products: [] });

  // Posts linked to those products.
  const { data: links } = await admin
    .from("post_products")
    .select("product_id, post:posts(id, title, excerpt, featured_image_url, handle, grouping, is_resource, published, published_at)")
    .eq("workspace_id", auth.workspaceId)
    .in("product_id", productIds);

  const { data: prods } = await admin.from("products").select("id, title").in("id", productIds);
  const productTitle = new Map((prods || []).map((p) => [p.id as string, p.title as string]));

  // Group product → grouping → posts.
  const byProduct = new Map<string, Map<string, PostRow[]>>();
  for (const l of links || []) {
    const post = l.post as unknown as (PostRow & { is_resource?: boolean; published?: boolean }) | null;
    if (!post || !post.is_resource || !post.published) continue;
    const pid = l.product_id as string;
    const grp = post.grouping || "general";
    if (!byProduct.has(pid)) byProduct.set(pid, new Map());
    const g = byProduct.get(pid)!;
    if (!g.has(grp)) g.set(grp, []);
    g.get(grp)!.push({ id: post.id, title: post.title, excerpt: post.excerpt, featured_image_url: post.featured_image_url, handle: post.handle, grouping: grp });
  }

  const products = [...byProduct.entries()].map(([pid, groups]) => ({
    id: pid,
    title: productTitle.get(pid) || "Product",
    groupings: GROUPING_ORDER
      .filter((g) => groups.has(g))
      .map((g) => ({ grouping: g, label: GROUPING_LABELS[g] || g, posts: groups.get(g)! })),
  })).filter((p) => p.groupings.length > 0)
    .sort((a, b) => a.title.localeCompare(b.title));

  return jsonOk({ ok: true, route, mode: "owned", products });
};

export const resourcePost: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const id = url.searchParams.get("id");
  if (!id) return jsonErr({ error: "missing_id" }, 400);
  const admin = createAdminClient();
  const { data: post } = await admin
    .from("posts")
    .select("id, title, content_html, featured_image_url, published_at, grouping")
    .eq("workspace_id", auth.workspaceId)
    .eq("id", id)
    .eq("is_resource", true)
    .eq("published", true)
    .maybeSingle();
  if (!post) return jsonErr({ error: "not_found" }, 404);
  return jsonOk({ ok: true, route, post });
};
