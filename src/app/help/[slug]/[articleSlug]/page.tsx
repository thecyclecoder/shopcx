import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import Link from "next/link";
import type { Metadata } from "next";

export async function generateMetadata({ params }: { params: Promise<{ slug: string; articleSlug: string }> }): Promise<Metadata> {
  const { slug, articleSlug } = await params;
  const admin = createAdminClient();

  const { data: workspace } = await admin.from("workspaces").select("id, name").eq("help_slug", slug).single();
  if (!workspace) return {};

  const { data: article } = await admin
    .from("knowledge_base")
    .select("title, excerpt, content")
    .eq("workspace_id", workspace.id)
    .eq("slug", articleSlug)
    .eq("published", true)
    .single();

  if (!article) return {};

  return {
    title: `${article.title} | ${workspace.name} Help Center`,
    description: article.excerpt || article.content.slice(0, 160),
    openGraph: {
      title: article.title,
      description: article.excerpt || article.content.slice(0, 160),
      type: "article",
    },
  };
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string; articleSlug: string }> }) {
  const { slug, articleSlug } = await params;
  const admin = createAdminClient();

  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name, help_slug, help_logo_url, help_primary_color")
    .eq("help_slug", slug)
    .single();

  if (!workspace) notFound();

  // Try direct slug match, then try with en-US prefix stripped (for old Gorgias URLs)
  let { data: article } = await admin
    .from("knowledge_base")
    .select("*")
    .eq("workspace_id", workspace.id)
    .eq("slug", articleSlug)
    .eq("published", true)
    .single();

  // Fallback: try matching by partial slug (old URLs may have extra prefixes)
  if (!article) {
    const { data: fuzzy } = await admin
      .from("knowledge_base")
      .select("*")
      .eq("workspace_id", workspace.id)
      .eq("published", true)
      .ilike("slug", `%${articleSlug}%`)
      .limit(1)
      .single();
    article = fuzzy;
  }

  if (!article) notFound();

  // Increment view count (fire and forget)
  admin.from("knowledge_base").update({ view_count: (article.view_count || 0) + 1 }).eq("id", article.id).then(() => {});

  // Get related articles in same category
  const { data: related } = await admin
    .from("knowledge_base")
    .select("id, title, slug, excerpt")
    .eq("workspace_id", workspace.id)
    .eq("category", article.category)
    .eq("published", true)
    .neq("id", article.id)
    .limit(5);

  // FAQ structured data for SEO/LLM
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: article.title,
        acceptedAnswer: {
          "@type": "Answer",
          text: article.content.slice(0, 2000),
        },
      },
    ],
  };

  // Article structured data
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    description: article.excerpt || article.content.slice(0, 160),
    datePublished: article.created_at,
    dateModified: article.updated_at,
    publisher: {
      "@type": "Organization",
      name: workspace.name,
    },
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Structured data for SEO + LLM */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }} />

      {/* Header */}
      <header className="border-b border-zinc-200 bg-white px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <Link href={`/help/${slug}`}>
            <img src={workspace.help_logo_url || "https://shopcx.ai/logo.svg"} alt={workspace.name} className="h-8 w-auto" />
          </Link>
          <Link href={`/help/${slug}`} className="text-sm text-indigo-600 hover:underline">
            &larr; {workspace.name} Help Center
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-xs text-zinc-400">
          <Link href={`/help/${slug}`} className="hover:text-zinc-600">Help Center</Link>
          <span>&rsaquo;</span>
          <span className="capitalize">{article.category}</span>
          {article.product_name && (
            <>
              <span>&rsaquo;</span>
              <span>{article.product_name}</span>
            </>
          )}
        </nav>

        {/* Article */}
        <article className="mt-6">
          <h1 className="text-2xl font-bold text-zinc-900">{article.title}</h1>
          <p className="mt-2 text-xs text-zinc-400">
            Last updated {new Date(article.updated_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
          </p>

          <div className="prose mt-6 max-w-none text-zinc-800 [&_*]:!text-zinc-800 [&_a]:!text-indigo-600 [&_h1]:!text-zinc-900 [&_h2]:!text-zinc-900 [&_h3]:!text-zinc-900 [&_strong]:!text-zinc-900">
            {article.content_html ? (
              <div dangerouslySetInnerHTML={{ __html: article.content_html }} />
            ) : (
              (article.content as string).split("\n\n").map((para: string, i: number) => (
                <p key={i}>{para}</p>
              ))
            )}
          </div>
        </article>

        {/* Related articles */}
        {related && related.length > 0 && (
          <div className="mt-12 border-t border-zinc-200 pt-8">
            <h2 className="text-lg font-semibold text-zinc-900">Related Articles</h2>
            <div className="mt-4 space-y-2">
              {related.map(r => (
                <Link key={r.id} href={`/help/${slug}/${r.slug}`} className="block rounded-lg border border-zinc-200 bg-white px-4 py-3 hover:border-indigo-300 transition-colors">
                  <p className="text-sm font-medium text-zinc-900">{r.title}</p>
                  {r.excerpt && <p className="mt-0.5 text-xs text-zinc-500 line-clamp-1">{r.excerpt}</p>}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Contact CTA */}
        <div className="mt-12 rounded-lg border border-zinc-200 bg-white p-6 text-center">
          <p className="text-sm text-zinc-600">Still need help?</p>
          <Link href={`/help/${slug}#contact`} className="mt-2 inline-block rounded-md px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: workspace.help_primary_color || "#4f46e5" }}>
            Contact Support
          </Link>
        </div>
      </main>

      <footer className="border-t border-zinc-200 bg-white px-6 py-4 text-center text-xs text-zinc-400">
        Powered by <a href="https://shopcx.ai" className="text-indigo-500 hover:underline">ShopCX.ai</a>
      </footer>
    </div>
  );
}
