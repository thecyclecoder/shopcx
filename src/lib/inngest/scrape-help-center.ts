import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&rsquo;/g, "\u2019")
    .replace(/&lsquo;/g, "\u2018").replace(/&rdquo;/g, "\u201D").replace(/&ldquo;/g, "\u201C")
    .replace(/&ndash;/g, "\u2013").replace(/&mdash;/g, "\u2014").replace(/&nbsp;/g, " ");
}

export const scrapeHelpCenter = inngest.createFunction(
  {
    id: "kb-scrape-help-center",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "kb/scrape-help-center" }],
  },
  async ({ event, step }) => {
    const { workspace_id, url } = event.data as { workspace_id: string; url: string };
    const admin = createAdminClient();

    // Step 1: Fetch the sitemap or index page to discover article URLs
    const articleUrls = await step.run("discover-articles", async () => {
      const urls: string[] = [];

      // Try sitemap first
      const sitemapUrl = new URL("/sitemap.xml", url).href;
      try {
        const res = await fetch(sitemapUrl);
        if (res.ok) {
          const xml = await res.text();
          const matches = xml.match(/<loc>(.*?)<\/loc>/g) || [];
          for (const match of matches) {
            const articleUrl = match.replace(/<\/?loc>/g, "");
            if (articleUrl.includes("/article") || articleUrl.includes("/help") || articleUrl.includes("/hc/")) {
              urls.push(articleUrl);
            }
          }
        }
      } catch {}

      // If no sitemap results, crawl the index page for links
      if (urls.length === 0) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            const html = await res.text();
            const baseUrl = new URL(url).origin;
            // Find all internal links
            const linkMatches = html.match(/href="([^"]*?)"/g) || [];
            for (const link of linkMatches) {
              const href = link.replace(/href="/, "").replace(/"$/, "");
              if (href.startsWith("/") && !href.startsWith("//")) {
                urls.push(baseUrl + href);
              } else if (href.startsWith(baseUrl)) {
                urls.push(href);
              }
            }
          }
        } catch {}
      }

      // Deduplicate and filter
      const unique = [...new Set(urls)].filter(u =>
        !u.endsWith(".css") && !u.endsWith(".js") && !u.endsWith(".png") && !u.endsWith(".jpg") &&
        !u.includes("/cdn-cgi/") && !u.includes("#")
      );

      return unique.slice(0, 200); // Cap at 200 articles
    });

    console.log(`Discovered ${articleUrls.length} article URLs`);

    // Step 2: Scrape each article
    let imported = 0;
    const batchSize = 10;

    for (let i = 0; i < articleUrls.length; i += batchSize) {
      const batch = articleUrls.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize);

      const results = await step.run(`scrape-batch-${batchNum}`, async () => {
        const articles: { title: string; content: string; content_html: string; url: string; category: string }[] = [];

        for (const articleUrl of batch) {
          try {
            const res = await fetch(articleUrl, { signal: AbortSignal.timeout(10000) });
            if (!res.ok) continue;
            const html = await res.text();

            // Extract title
            const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
            let title = h1Match?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
            // Strip "Updated X ago" from Gorgias titles
            title = title.replace(/Updated\s+\d+\s+\w+\s+ago/i, "").trim();
            if (!title) {
              const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
              title = titleMatch?.[1]?.replace(/\s*[-|].*$/, "").trim() || "";
            }

            title = decodeEntities(title);

            if (!title || title.length < 3) continue;

            // Extract main content — prefer <article>, fallback to <main>
            const bodyMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
              || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
              || html.match(/<div[^>]*class="[^"]*article[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

            let contentHtml = bodyMatch?.[1] || "";
            // Clean CSS-in-JS (Gorgias uses React with inline styles)
            contentHtml = contentHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
            // Strip Gorgias "Was this article helpful?" widget
            contentHtml = contentHtml.replace(/<div[^>]*class="[^"]*article-rating[^"]*"[^>]*>[\s\S]*$/i, "");
            contentHtml = contentHtml.replace(/Was this article helpful\?[\s\S]*$/i, "");
            const content = decodeEntities(
              contentHtml
                .replace(/<[^>]+>/g, " ")
                .replace(/\.css-[a-z0-9]+\{[^}]+\}/g, "")
                .replace(/Updated\s+\d+\s+\w+\s+ago/gi, "")
                .replace(/\s+/g, " ")
                .trim()
            );

            if (content.length < 50) continue;

            // Guess category from URL path or content
            const urlLower = articleUrl.toLowerCase();
            let category = "general";
            if (urlLower.includes("shipping") || urlLower.includes("delivery")) category = "shipping";
            else if (urlLower.includes("billing") || urlLower.includes("payment") || urlLower.includes("refund")) category = "billing";
            else if (urlLower.includes("return") || urlLower.includes("exchange")) category = "policy";
            else if (urlLower.includes("subscription") || urlLower.includes("cancel")) category = "subscription";
            else if (urlLower.includes("product") || urlLower.includes("ingredient")) category = "product";

            articles.push({ title, content: content.slice(0, 5000), content_html: contentHtml.slice(0, 10000), url: articleUrl, category });
          } catch {
            // Skip failed articles
          }
        }
        return articles;
      });

      // Insert articles
      for (const article of results) {
        // Preserve original URL path as slug — strip language prefix (en-US, etc.)
        let urlPath = new URL(article.url).pathname.replace(/^\/+|\/+$/g, "");
        urlPath = urlPath.replace(/^[a-z]{2}(-[A-Z]{2})?\//i, ""); // Strip en-US/, fr/, etc.
        const slug = urlPath || article.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 200);

        const { error } = await admin.from("knowledge_base").upsert({
          workspace_id,
          title: article.title,
          content: article.content,
          content_html: article.content_html,
          category: article.category,
          slug,
          published: true,
          excerpt: article.content.slice(0, 200),
          source: "import",
          active: true,
        }, { onConflict: "workspace_id,slug" });

        if (!error) imported++;
      }
    }

    // Step 3: Map articles to products by title match
    const mapped = await step.run("map-products", async () => {
      const { data: products } = await admin
        .from("products")
        .select("id, title")
        .eq("workspace_id", workspace_id);

      if (!products || products.length === 0) return 0;

      // Build search keywords for each product:
      // "Ashwavana Guru Focus" → ["ashwavana guru focus", "ashwavana guru", "ashwavana"]
      // "Apple Cider Vinegar Gummies" → ["apple cider vinegar gummies", "apple cider vinegar", "apple cider"]
      const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "of", "for", "with", "in", "on", "to", "by"]);
      const productKeywords = products.map(p => {
        const words = p.title.toLowerCase().replace(/[™®©]/g, "").split(/\s+/).filter((w: string) => w.length > 1 && !STOP_WORDS.has(w));
        const phrases: string[] = [];
        // Full name first, then progressively shorter prefixes (min 1 word)
        for (let len = words.length; len >= 1; len--) {
          phrases.push(words.slice(0, len).join(" "));
        }
        return { product: p, phrases };
      });

      // Sort by longest keyword first so more specific matches win
      productKeywords.sort((a, b) => (b.phrases[0]?.length || 0) - (a.phrases[0]?.length || 0));

      const { data: articles } = await admin
        .from("knowledge_base")
        .select("id, title, content, category")
        .eq("workspace_id", workspace_id)
        .eq("source", "import");

      let count = 0;
      for (const article of articles || []) {
        const titleLower = article.title.toLowerCase().replace(/[™®©]/g, "");
        const contentLower = (article.content || "").toLowerCase().replace(/[™®©]/g, "").slice(0, 1000);
        const searchText = titleLower + " " + contentLower;

        let matched = false;
        for (const { product, phrases } of productKeywords) {
          // Try each phrase from most specific to least
          for (const phrase of phrases) {
            // Require at least 4 chars to avoid false positives on short words
            if (phrase.length < 4) continue;
            if (searchText.includes(phrase)) {
              await admin.from("knowledge_base").update({
                product_id: product.id,
                product_name: product.title,
                category: article.category === "general" ? "product" : article.category,
              }).eq("id", article.id);
              count++;
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
      }
      return count;
    });

    console.log(`Mapped ${mapped} articles to products`);

    // Step 4: Trigger embedding generation for all new articles
    await step.run("trigger-embeddings", async () => {
      const { data: articles } = await admin
        .from("knowledge_base")
        .select("id")
        .eq("workspace_id", workspace_id)
        .eq("source", "import");

      for (const article of articles || []) {
        await inngest.send({
          name: "kb/document.updated",
          data: { kb_id: article.id, workspace_id },
        });
      }
    });

    return { discovered: articleUrls.length, imported, mapped };
  }
);
