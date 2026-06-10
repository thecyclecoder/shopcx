import Link from "next/link";
import { redirect } from "next/navigation";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Storefront → Blog dashboard.
 *
 * Read-only view of the `posts` object that powers the public storefront
 * blog (/blog). Lists every post with its grouping, resource flag, product
 * links, published state, and quick links to view the rendered article
 * (preview URL) — the same posts the portal Resources section surfaces.
 *
 * See specs/blog-resources.md. Server component — queries via the admin
 * client off the active workspace (RLS on `posts` is service-role only).
 */

export const dynamic = "force-dynamic";

const GROUPING_LABELS: Record<string, string> = {
  recipes: "Recipes",
  how_it_works: "How It Works",
  how_to_use: "How To Use",
  science: "The Science",
  general: "General",
};

interface PostRow {
  id: string;
  handle: string | null;
  title: string;
  grouping: string | null;
  is_resource: boolean;
  published: boolean;
  published_at: string | null;
  featured_image_url: string | null;
}

export default async function StorefrontBlogPage() {
  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) redirect("/workspace/select");

  const admin = createAdminClient();

  const [{ data: ws }, { data: posts }, { data: links }] = await Promise.all([
    admin
      .from("workspaces")
      .select("storefront_slug")
      .eq("id", workspaceId)
      .maybeSingle(),
    admin
      .from("posts")
      .select(
        "id, handle, title, grouping, is_resource, published, published_at, featured_image_url",
      )
      .eq("workspace_id", workspaceId)
      .order("published_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    admin
      .from("post_products")
      .select("post_id")
      .eq("workspace_id", workspaceId),
  ]);

  const rows = (posts || []) as PostRow[];
  const slug = (ws as { storefront_slug?: string | null } | null)?.storefront_slug || null;

  const productCount = new Map<string, number>();
  for (const l of links || []) {
    productCount.set(l.post_id, (productCount.get(l.post_id) || 0) + 1);
  }

  const total = rows.length;
  const publishedCount = rows.filter((p) => p.published).length;
  const resourceCount = rows.filter((p) => p.is_resource).length;

  const byGrouping = new Map<string, number>();
  for (const p of rows) {
    const key = p.grouping || "—";
    byGrouping.set(key, (byGrouping.get(key) || 0) + 1);
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Blog</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Posts powering the public storefront blog at <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs">/blog</code>.
            Imported from the Superfood Scoop and AI-classified into groupings.
          </p>
        </div>
        {slug && (
          <Link
            href={`/store/${slug}/blog`}
            target="_blank"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
          >
            View live blog
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" /></svg>
          </Link>
        )}
      </div>

      {/* Summary stats */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total posts" value={total} />
        <Stat label="Published" value={publishedCount} />
        <Stat label="Product resources" value={resourceCount} />
        <Stat label="Groupings" value={byGrouping.size} />
      </div>

      {/* Posts table */}
      <div className="mt-8 overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3 font-medium">Post</th>
              <th className="px-4 py-3 font-medium">Grouping</th>
              <th className="px-4 py-3 font-medium">Products</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Published</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-zinc-500">
                  No posts yet. They&rsquo;re imported from the Shopify blog — see the blog-resources spec.
                </td>
              </tr>
            ) : (
              rows.map((p) => (
                <tr key={p.id} className="hover:bg-zinc-50/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {p.featured_image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.featured_image_url} alt="" className="h-10 w-14 shrink-0 rounded object-cover" />
                      ) : (
                        <div className="h-10 w-14 shrink-0 rounded bg-zinc-100" />
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-medium text-zinc-900">{p.title}</div>
                        {p.handle && <div className="truncate text-xs text-zinc-400">/{p.handle}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {p.grouping ? (
                      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        {GROUPING_LABELS[p.grouping] || p.grouping}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{productCount.get(p.id) || 0}</td>
                  <td className="px-4 py-3">
                    {p.published ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Published
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500">
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" /> Draft
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {p.published_at ? new Date(p.published_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {slug && p.handle && (
                      <Link
                        href={`/store/${slug}/blog/${p.handle}`}
                        target="_blank"
                        className="text-sm font-medium text-emerald-700 hover:text-emerald-900"
                      >
                        View
                      </Link>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3">
      <div className="text-2xl font-semibold text-zinc-900">{value}</div>
      <div className="mt-0.5 text-xs text-zinc-500">{label}</div>
    </div>
  );
}
