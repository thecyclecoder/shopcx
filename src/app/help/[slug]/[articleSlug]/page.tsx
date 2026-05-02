import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import Link from "next/link";
import type { Metadata } from "next";
import ArticleFeedback from "./article-feedback";

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

  const headersList = await headers();
  const host = headersList.get("host") || "";
  const isSubdomain = host.split(".").length >= 3 || !host.includes("shopcx.ai");
  const basePath = isSubdomain ? "" : `/help/${slug}`;

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

  // Get product details if article is tagged to a product
  let shopifyProductId: string | null = null;
  let productCard: { title: string; handle: string; image_url: string | null; description: string | null } | null = null;
  if (article.product_id) {
    const { data: product } = await admin
      .from("products")
      .select("shopify_product_id, title, handle, image_url, description")
      .eq("id", article.product_id)
      .single();
    shopifyProductId = product?.shopify_product_id || null;
    if (product) {
      productCard = { title: product.title, handle: product.handle, image_url: product.image_url, description: product.description };
    }
  }

  // Get the Shopify store domain for product link. Use the
  // myshopify_domain — Shopify auto-redirects it to the primary
  // customer-facing domain (e.g. 2c6b02-3.myshopify.com →
  // superfoodscompany.com), so the link always lands at the right
  // store regardless of how the merchant has their primary domain
  // configured. The legacy `shopify_domain` field on workspaces is
  // sometimes a bare slug (e.g. "superfoodsco") and produces
  // unresolvable URLs.
  const { data: wsStore } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain")
    .eq("id", workspace.id)
    .single();
  const shopDomain = wsStore?.shopify_myshopify_domain || "";

  // Get related articles — same product first, then same category
  let related: { id: string; title: string; slug: string; excerpt: string | null }[] | null = null;
  if (article.product_id) {
    const { data } = await admin
      .from("knowledge_base")
      .select("id, title, slug, excerpt")
      .eq("workspace_id", workspace.id)
      .eq("product_id", article.product_id)
      .eq("published", true)
      .neq("id", article.id)
      .order("view_count", { ascending: false })
      .limit(5);
    related = data;
  }
  if (!related || related.length === 0) {
    const { data } = await admin
      .from("knowledge_base")
      .select("id, title, slug, excerpt")
      .eq("workspace_id", workspace.id)
      .eq("category", article.category)
      .eq("published", true)
      .neq("id", article.id)
      .order("view_count", { ascending: false })
      .limit(5);
    related = data;
  }

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

  // Product structured data (for widget product context detection)
  const productSchema = shopifyProductId ? {
    "@context": "https://schema.org",
    "@type": "Product",
    productID: shopifyProductId,
    name: article.product_name || "",
  } : null;

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
      {productSchema && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productSchema) }} />}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }} />

      {/* Header */}
      <header className="border-b border-zinc-200 bg-white px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <Link href={basePath || "/"}>
            <img src={workspace.help_logo_url || "https://shopcx.ai/logo.svg"} alt={workspace.name} className="h-8 w-auto" />
          </Link>
          <Link href={basePath || "/"} className="text-sm text-indigo-600 hover:underline">
            &larr; {workspace.name} Help Center
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-xs text-zinc-400">
          <Link href={basePath || "/"} className="hover:text-zinc-600">Help Center</Link>
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

          <div className="prose mt-6 max-w-none text-zinc-800 [&_*]:!text-zinc-800 [&_a]:!text-indigo-600 [&_h1]:!text-zinc-900 [&_h2]:!text-zinc-900 [&_h3]:!text-zinc-900 [&_strong]:!text-zinc-900 [&_img]:my-4 [&_img]:rounded-lg [&_img]:max-w-full [&_video]:my-4 [&_video]:rounded-lg [&_video]:max-w-full [&_iframe]:my-4 [&_iframe]:rounded-lg [&_iframe]:max-w-full">
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
                <Link key={r.id} href={`${basePath}/${r.slug}`} className="block rounded-lg border border-zinc-200 bg-white px-4 py-3 hover:border-indigo-300 transition-colors">
                  <p className="text-sm font-medium text-zinc-900">{r.title}</p>
                  {r.excerpt && <p className="mt-0.5 text-xs text-zinc-500 line-clamp-1">{r.excerpt}</p>}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Product callout card — only on KB minisite, not in widget */}
        {productCard && (
          <div className="mt-8 overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <div className="flex flex-col sm:flex-row">
              {productCard.image_url && (
                <div className="aspect-square w-full sm:w-48 shrink-0 overflow-hidden bg-zinc-100">
                  <img src={productCard.image_url} alt={productCard.title} className="h-full w-full object-cover" />
                </div>
              )}
              <div className="flex flex-1 flex-col justify-center p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Featured Product</p>
                <h3 className="mt-1 text-lg font-bold text-zinc-900">{productCard.title}</h3>
                {productCard.description && (
                  <p className="mt-1 text-sm text-zinc-600 line-clamp-2">{productCard.description}</p>
                )}
                {shopDomain && productCard.handle && (
                  <a
                    href={`https://${shopDomain}/products/${productCard.handle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-block rounded-md px-4 py-2 text-sm font-medium text-white"
                    style={{ backgroundColor: workspace.help_primary_color || "#4f46e5" }}
                  >
                    View Product →
                  </a>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Article feedback */}
        <ArticleFeedback articleId={article.id} slug={slug} />

        {/* Contact CTA */}
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 text-center">
          <p className="text-sm text-zinc-600">Still need help?</p>
          <Link href="/#contact" className="mt-2 inline-block rounded-md px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: workspace.help_primary_color || "#4f46e5" }}>
            Contact Support
          </Link>
        </div>
      </main>

      <footer className="border-t border-zinc-200 bg-white px-6 py-4 text-center text-xs text-zinc-400">
        Powered by <a href="https://shopcx.ai" className="text-indigo-500 hover:underline">ShopCX.ai</a>
      </footer>

      {/* Live Chat Widget */}
      <script src="https://shopcx.ai/widget.js" data-workspace={workspace.id} async />
    </div>
  );
}
