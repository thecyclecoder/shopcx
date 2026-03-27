import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import Link from "next/link";
import HelpSearch from "./help-search";
import TicketForm from "./ticket-form";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const admin = createAdminClient();
  const { data: workspace } = await admin.from("workspaces").select("name").eq("help_slug", slug).single();
  return {
    title: workspace ? `${workspace.name} Help Center` : "Help Center",
    description: workspace ? `Find answers and get support from ${workspace.name}` : "Help Center",
  };
}

export default async function HelpCenterPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ search?: string; category?: string }> }) {
  const { slug } = await params;
  const { search, category: categoryFilter } = await searchParams;
  const headersList = await headers();
  const host = headersList.get("host") || "";
  const isSubdomain = host.split(".").length >= 3 || !host.includes("shopcx.ai");
  const basePath = isSubdomain ? "" : `/help/${slug}`;
  const admin = createAdminClient();

  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name, help_slug, help_logo_url, help_primary_color")
    .eq("help_slug", slug)
    .single();

  if (!workspace) notFound();

  const { data: articles } = await admin
    .from("knowledge_base")
    .select("id, title, slug, category, excerpt, product_name, product_id, view_count, helpful_yes")
    .eq("workspace_id", workspace.id)
    .eq("published", true)
    .eq("active", true)
    .order("title");

  // Group by category
  const byCategory: Record<string, typeof articles> = {};
  for (const a of articles || []) {
    if (!byCategory[a.category]) byCategory[a.category] = [];
    byCategory[a.category]!.push(a);
  }

  // Search filter
  const searchQuery = search?.trim().toLowerCase();
  const searchResults = searchQuery
    ? (articles || []).filter(a =>
        a.title.toLowerCase().includes(searchQuery) ||
        (a.excerpt || "").toLowerCase().includes(searchQuery)
      )
    : null;

  // Get products with articles — for the "Learn more about our products" section
  const productIds = [...new Set((articles || []).filter(a => a.product_id).map(a => a.product_id!))];
  let productsWithArticles: { id: string; title: string; handle: string; image_url: string | null; description: string | null; articles: typeof articles }[] = [];
  if (productIds.length > 0) {
    const { data: products } = await admin
      .from("products")
      .select("id, title, handle, image_url, description")
      .in("id", productIds)
      .order("title");

    productsWithArticles = (products || []).map(p => ({
      ...p,
      articles: (articles || []).filter(a => a.product_id === p.id).slice(0, 5),
    })).filter(p => p.articles.length > 0);
  }

  const productNames = [...new Set((articles || []).filter(a => a.product_name).map(a => a.product_name!))];

  const CATEGORY_LABELS: Record<string, string> = {
    product: "Products",
    policy: "Policies",
    shipping: "Shipping & Delivery",
    billing: "Billing & Payments",
    subscription: "Subscriptions",
    general: "General",
    faq: "FAQ",
    troubleshooting: "Troubleshooting",
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Header */}
      <header className="bg-white border-b border-zinc-200 px-6 py-8 text-center">
        <img src={workspace.help_logo_url || "https://shopcx.ai/logo.svg"} alt={workspace.name} className="mx-auto mb-4 h-12 w-auto" />
        <h1 className="text-3xl font-bold text-zinc-900">{workspace.name} Help Center</h1>
        <p className="mt-2 text-zinc-500">Find answers, browse articles, or contact our support team</p>
        <div className="mt-6 max-w-lg mx-auto">
          <HelpSearch slug={slug} basePath={basePath} />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Learn more about our products */}
        {!searchResults && !categoryFilter && productsWithArticles.length > 0 && (
          <div className="mb-10">
            <h2 className="text-xl font-bold text-zinc-900">Learn more about our products</h2>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {productsWithArticles.map(p => (
                <div key={p.id} className="overflow-hidden rounded-xl border border-zinc-200 bg-white transition-shadow hover:shadow-md">
                  {p.image_url && (
                    <div className="aspect-square overflow-hidden bg-zinc-100">
                      <img src={p.image_url} alt={p.title} className="h-full w-full object-cover" />
                    </div>
                  )}
                  <div className="p-4">
                    <h3 className="text-sm font-bold text-zinc-900">{p.title}</h3>
                    {p.description && (
                      <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{p.description}</p>
                    )}
                    <ul className="mt-3 space-y-1">
                      {(p.articles || []).map(a => (
                        <li key={a.id}>
                          <Link href={`${basePath}/${a.slug}`} className="text-xs text-indigo-600 hover:underline line-clamp-1">
                            {a.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                    {(articles || []).filter(a => a.product_id === p.id).length > 5 && (
                      <Link href={`${basePath}/?category=product`} className="mt-2 inline-block text-xs font-medium text-indigo-600 hover:underline">
                        View all articles →
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Search results */}
        {searchResults && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-zinc-900">
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for &ldquo;{search}&rdquo;
            </h2>
            {searchResults.length === 0 ? (
              <p className="mt-4 text-sm text-zinc-500">No articles found. Try a different search term or browse the categories below.</p>
            ) : (
              <div className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
                {searchResults.map(a => (
                  <Link key={a.id} href={`${basePath}/${a.slug}`} className="block px-4 py-3 hover:bg-zinc-50 transition-colors">
                    <p className="text-sm font-medium text-zinc-900">{a.title}</p>
                    {a.excerpt && <p className="mt-0.5 text-xs text-zinc-500 line-clamp-2">{a.excerpt}</p>}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Category page — when a category is selected */}
        {categoryFilter && byCategory[categoryFilter] ? (
          <div className="mb-8">
            <div className="flex items-center gap-3">
              <Link href={basePath || "/"} className="text-sm text-indigo-600 hover:underline">&larr; All Categories</Link>
            </div>
            <h2 className="mt-3 text-lg font-semibold text-zinc-900">{CATEGORY_LABELS[categoryFilter] || categoryFilter}</h2>
            <p className="mt-1 text-sm text-zinc-500">{byCategory[categoryFilter]?.length || 0} articles</p>
            <div className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
              {(byCategory[categoryFilter] || []).map(a => (
                <Link key={a.id} href={`${basePath}/${a.slug}`} className="block px-4 py-3 hover:bg-zinc-50 transition-colors">
                  <p className="text-sm font-medium text-zinc-900">{a.title}</p>
                  {a.excerpt && <p className="mt-0.5 text-xs text-zinc-500 line-clamp-2">{a.excerpt}</p>}
                </Link>
              ))}
            </div>
          </div>
        ) : !searchResults && (
        <>
        {/* Categories */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {Object.entries(byCategory).map(([category, categoryArticles]) => (
            <Link key={category} href={`${basePath}/?category=${category}`} className="rounded-lg border border-zinc-200 bg-white p-4 hover:border-indigo-300 transition-colors">
              <h2 className="text-sm font-semibold text-zinc-900">{CATEGORY_LABELS[category] || category}</h2>
              <p className="mt-1 text-xs text-zinc-400">{categoryArticles?.length || 0} articles</p>
              <ul className="mt-3 space-y-1">
                {(categoryArticles || []).slice(0, 3).map(a => (
                  <li key={a.id} className="text-sm text-indigo-600 truncate">
                    {a.title}
                  </li>
                ))}
                {(categoryArticles?.length || 0) > 3 && (
                  <li className="text-xs text-zinc-400">+{(categoryArticles?.length || 0) - 3} more</li>
                )}
              </ul>
            </Link>
          ))}
        </div>

        {/* Products section */}
        {productNames.length > 0 && (
          <div className="mt-8">
            <h2 className="text-lg font-semibold text-zinc-900">By Product</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {productNames.map(name => (
                <Link
                  key={name}
                  href={`/help/${slug}?product=${encodeURIComponent(name)}`}
                  className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-700 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
                >
                  {name}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Most helpful articles */}
        {(articles || []).some(a => (a.helpful_yes || 0) > 0) && (
          <div className="mt-8">
            <h2 className="text-lg font-semibold text-zinc-900">Most Helpful</h2>
            <div className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
              {[...(articles || [])].filter(a => (a.helpful_yes || 0) > 0).sort((a, b) => (b.helpful_yes || 0) - (a.helpful_yes || 0)).slice(0, 10).map(a => (
                <Link key={a.id} href={`${basePath}/${a.slug}`} className="flex items-center justify-between px-4 py-3 hover:bg-zinc-50 transition-colors">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900">{a.title}</p>
                    {a.excerpt && <p className="mt-0.5 text-xs text-zinc-500 line-clamp-1">{a.excerpt}</p>}
                  </div>
                  <span className="ml-3 shrink-0 text-xs text-emerald-600">{(a.helpful_yes || 0).toLocaleString()} found helpful</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Most viewed articles */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-zinc-900">Most Viewed</h2>
          <div className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
            {[...(articles || [])].sort((a, b) => (b.view_count || 0) - (a.view_count || 0)).slice(0, 20).map(a => (
              <Link key={a.id} href={`${basePath}/${a.slug}`} className="block px-4 py-3 hover:bg-zinc-50 transition-colors">
                <p className="text-sm font-medium text-zinc-900">{a.title}</p>
                {a.excerpt && <p className="mt-0.5 text-xs text-zinc-500 line-clamp-2">{a.excerpt}</p>}
              </Link>
            ))}
          </div>
        </div>
        </>
        )}

        {/* Contact / Ticket form */}
        <div id="contact" className="mt-12">
          <h2 className="text-lg font-semibold text-zinc-900">Can&apos;t find what you&apos;re looking for?</h2>
          <p className="mt-1 text-sm text-zinc-500">Send us a message and we&apos;ll get back to you.</p>
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-6">
            <TicketForm slug={slug} categories={Object.keys(byCategory)} />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-200 bg-white px-6 py-4 text-center text-xs text-zinc-400">
        Powered by <a href="https://shopcx.ai" className="text-indigo-500 hover:underline">ShopCX.ai</a>
      </footer>

      {/* Live Chat Widget */}
      <script src="https://shopcx.ai/widget.js" data-workspace={workspace.id} async />
    </div>
  );
}
