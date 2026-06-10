/**
 * Storefront blog data loader.
 *
 * The blog renders the `posts` object (imported Shopify "Superfood Scoop"
 * articles — see specs/blog-resources.md). Two public surfaces:
 *
 *   /blog            → index of every published post (BlogList)
 *   /blog/{handle}   → a single article (BlogPost)
 *
 * Both are SSG'd off /store/[workspace]/blog[/handle] and reachable on the
 * custom domain at /blog[/handle] via the middleware rewrite — same static
 * delivery model as the PDP. All queries use the admin client; RLS on
 * `posts` is service-role + authenticated-read only, and the storefront is
 * anonymous, so we MUST read through the service role here (never client).
 *
 * Images in `content_html` already live on our storage (migrated off
 * Shopify during import), so the HTML is safe to render directly.
 */

import { createAdminClient } from "@/lib/supabase/admin";

/** Fixed grouping vocabulary (mirrors the AI classifier) → display label.
 *  Order here is the order topics appear in the blog nav + index tabs. */
export const BLOG_GROUPINGS: { key: string; label: string }[] = [
  { key: "recipes", label: "Recipes" },
  { key: "how_it_works", label: "How It Works" },
  { key: "how_to_use", label: "How To Use" },
  { key: "science", label: "The Science" },
  { key: "general", label: "More" },
];

export function groupingLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  return BLOG_GROUPINGS.find((g) => g.key === key)?.label ?? null;
}

export interface BlogWorkspace {
  id: string;
  name: string;
  storefront_slug: string | null;
  storefront_domain: string | null;
  support_email: string | null;
  design: {
    font_key: string | null;
    primary_color: string | null;
    accent_color: string | null;
    logo_url: string | null;
    favicon_url: string | null;
  };
}

export interface BlogPostCard {
  id: string;
  handle: string;
  title: string;
  excerpt: string | null;
  featured_image_url: string | null;
  grouping: string | null;
  published_at: string | null;
}

export interface BlogPostFull extends BlogPostCard {
  content_html: string | null;
  content_text: string | null;
  seo_title: string | null;
  seo_description: string | null;
  tags: string[];
  updated_at: string | null;
}

const WORKSPACE_COLS =
  "id, name, storefront_slug, storefront_domain, support_email, storefront_font, storefront_primary_color, storefront_accent_color, storefront_logo_url, storefront_favicon_url";

type WorkspaceRow = {
  id: string;
  name: string | null;
  storefront_slug: string | null;
  storefront_domain: string | null;
  support_email: string | null;
  storefront_font: string | null;
  storefront_primary_color: string | null;
  storefront_accent_color: string | null;
  storefront_logo_url: string | null;
  storefront_favicon_url: string | null;
};

function shapeWorkspace(ws: WorkspaceRow): BlogWorkspace {
  return {
    id: ws.id,
    name: ws.name || "",
    storefront_slug: ws.storefront_slug,
    storefront_domain: ws.storefront_domain,
    support_email: ws.support_email,
    design: {
      font_key: ws.storefront_font || null,
      primary_color: ws.storefront_primary_color || null,
      accent_color: ws.storefront_accent_color || null,
      logo_url: ws.storefront_logo_url || null,
      favicon_url: ws.storefront_favicon_url || null,
    },
  };
}

/** Resolve a workspace by its storefront slug. Returns null when unknown. */
export async function getBlogWorkspaceBySlug(
  slug: string,
): Promise<BlogWorkspace | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select(WORKSPACE_COLS)
    .eq("storefront_slug", slug)
    .maybeSingle();
  return data ? shapeWorkspace(data as WorkspaceRow) : null;
}

const CARD_COLS =
  "id, handle, title, excerpt, featured_image_url, grouping, published_at";

/**
 * Every published post for a workspace, newest first. The full set ships
 * in the index HTML (good for crawlers + LLMs); the client only toggles
 * topic-tab visibility, so there's no second fetch.
 */
export async function listBlogPosts(
  workspaceId: string,
): Promise<BlogPostCard[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("posts")
    .select(CARD_COLS)
    .eq("workspace_id", workspaceId)
    .eq("published", true)
    .not("handle", "is", null)
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  return (data || []) as BlogPostCard[];
}

/** One published post by handle. Null when missing/unpublished. */
export async function getBlogPost(
  workspaceId: string,
  handle: string,
): Promise<BlogPostFull | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("posts")
    .select(
      "id, handle, title, excerpt, featured_image_url, grouping, published_at, content_html, content_text, seo_title, seo_description, tags, updated_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("handle", handle)
    .eq("published", true)
    .maybeSingle();
  if (!data) return null;
  return { ...(data as BlogPostFull), tags: (data.tags as string[]) || [] };
}

/**
 * Related posts for the article footer: same grouping first, then any
 * other recent post, excluding the current one. Capped at `limit`.
 */
export async function listRelatedPosts(
  workspaceId: string,
  current: BlogPostFull,
  limit = 3,
): Promise<BlogPostCard[]> {
  const admin = createAdminClient();
  const out: BlogPostCard[] = [];
  const seen = new Set<string>([current.id]);

  if (current.grouping) {
    const { data } = await admin
      .from("posts")
      .select(CARD_COLS)
      .eq("workspace_id", workspaceId)
      .eq("published", true)
      .eq("grouping", current.grouping)
      .not("handle", "is", null)
      .neq("id", current.id)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    for (const p of (data || []) as BlogPostCard[]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
  }

  if (out.length < limit) {
    const { data } = await admin
      .from("posts")
      .select(CARD_COLS)
      .eq("workspace_id", workspaceId)
      .eq("published", true)
      .not("handle", "is", null)
      .neq("id", current.id)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(limit + 1);
    for (const p of (data || []) as BlogPostCard[]) {
      if (out.length >= limit) break;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
  }

  return out.slice(0, limit);
}

/**
 * Every (workspace_slug) that has at least one published post — drives
 * generateStaticParams for the blog index route.
 */
export async function listBlogWorkspaceParams(): Promise<
  Array<{ workspace: string }>
> {
  const admin = createAdminClient();
  const { data: workspaces } = await admin
    .from("workspaces")
    .select("id, storefront_slug")
    .not("storefront_slug", "is", null);

  const params: Array<{ workspace: string }> = [];
  for (const ws of workspaces || []) {
    if (!ws.storefront_slug) continue;
    const { count } = await admin
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", ws.id)
      .eq("published", true);
    if ((count || 0) > 0) params.push({ workspace: ws.storefront_slug });
  }
  return params;
}

/**
 * Every (workspace_slug, post_handle) pair to statically generate for the
 * post-detail route. Also reused by the sitemap.
 */
export async function listBlogPostParams(): Promise<
  Array<{ workspace: string; handle: string }>
> {
  const admin = createAdminClient();
  const { data: workspaces } = await admin
    .from("workspaces")
    .select("id, storefront_slug")
    .not("storefront_slug", "is", null);

  const params: Array<{ workspace: string; handle: string }> = [];
  for (const ws of workspaces || []) {
    if (!ws.storefront_slug) continue;
    const { data: posts } = await admin
      .from("posts")
      .select("handle")
      .eq("workspace_id", ws.id)
      .eq("published", true)
      .not("handle", "is", null);
    for (const p of posts || []) {
      if (!p.handle) continue;
      params.push({ workspace: ws.storefront_slug, handle: p.handle });
    }
  }
  return params;
}
