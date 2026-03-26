import { notFound } from "next/navigation";
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

export default async function HelpCenterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const admin = createAdminClient();

  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name, help_slug")
    .eq("help_slug", slug)
    .single();

  if (!workspace) notFound();

  const { data: articles } = await admin
    .from("knowledge_base")
    .select("id, title, slug, category, excerpt, product_name")
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

  // Get products
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
        <h1 className="text-3xl font-bold text-zinc-900">{workspace.name} Help Center</h1>
        <p className="mt-2 text-zinc-500">Find answers, browse articles, or contact our support team</p>
        <div className="mt-6 max-w-lg mx-auto">
          <HelpSearch slug={slug} />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Categories */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {Object.entries(byCategory).map(([category, categoryArticles]) => (
            <div key={category} className="rounded-lg border border-zinc-200 bg-white p-4 hover:border-indigo-300 transition-colors">
              <h2 className="text-sm font-semibold text-zinc-900">{CATEGORY_LABELS[category] || category}</h2>
              <p className="mt-1 text-xs text-zinc-400">{categoryArticles?.length || 0} articles</p>
              <ul className="mt-3 space-y-1">
                {(categoryArticles || []).slice(0, 5).map(a => (
                  <li key={a.id}>
                    <Link href={`/help/${slug}/${a.slug}`} className="text-sm text-indigo-600 hover:underline">
                      {a.title}
                    </Link>
                  </li>
                ))}
                {(categoryArticles?.length || 0) > 5 && (
                  <li className="text-xs text-zinc-400">+{(categoryArticles?.length || 0) - 5} more</li>
                )}
              </ul>
            </div>
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

        {/* All articles */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-zinc-900">All Articles</h2>
          <div className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
            {(articles || []).map(a => (
              <Link key={a.id} href={`/help/${slug}/${a.slug}`} className="block px-4 py-3 hover:bg-zinc-50 transition-colors">
                <p className="text-sm font-medium text-zinc-900">{a.title}</p>
                {a.excerpt && <p className="mt-0.5 text-xs text-zinc-500 line-clamp-2">{a.excerpt}</p>}
              </Link>
            ))}
          </div>
        </div>

        {/* Contact / Ticket form */}
        <div className="mt-12">
          <h2 className="text-lg font-semibold text-zinc-900">Can&apos;t find what you&apos;re looking for?</h2>
          <p className="mt-1 text-sm text-zinc-500">Send us a message and we&apos;ll get back to you.</p>
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-6">
            <TicketForm slug={slug} categories={Object.keys(byCategory)} />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-200 bg-white px-6 py-4 text-center text-xs text-zinc-400">
        Powered by <a href="https://shopcx.ai" className="text-indigo-500 hover:underline">ShopCX.AI</a>
      </footer>
    </div>
  );
}
