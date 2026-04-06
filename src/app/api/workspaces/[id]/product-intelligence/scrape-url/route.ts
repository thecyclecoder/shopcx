import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// POST: Scrape a URL and return cleaned text content for adding to product intelligence
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  await params; // validate workspace
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { url } = body as { url: string };

  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "ShopCX Product Intelligence Bot" },
    });
    if (!res.ok) return NextResponse.json({ error: `Failed to fetch: ${res.status}` }, { status: 400 });

    const html = await res.text();

    // Try to extract main article/product content first
    let contentHtml = html;

    // Try to find the main content area (Shopify blogs, articles, product descriptions)
    const mainSelectors = [
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]*class="[^"]*article[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div[^>]*class="[^"]*(?:sidebar|related|comment))/i,
      /<div[^>]*class="[^"]*(?:blog-post|post-content|entry-content|article-content|rte|shopify-section)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<main[^>]*>([\s\S]*?)<\/main>/i,
    ];

    for (const selector of mainSelectors) {
      const match = contentHtml.match(selector);
      if (match?.[1] && match[1].length > 200) {
        contentHtml = match[1];
        break;
      }
    }

    // Strip non-content elements
    const text = contentHtml
      // Remove entire blocks
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
      .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, "")
      .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "")
      .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "")
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
      // Remove common Shopify/e-commerce chrome
      .replace(/<div[^>]*class="[^"]*(?:cart|checkout|shipping-bar|announcement|popup|modal|overlay|drawer|slideout|cookie|banner|newsletter|signup-form|social-share|share-buttons|breadcrumb|pagination|related-products|upsell|cross-sell)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "")
      // Remove buttons, inputs, selects
      .replace(/<button[^>]*>[\s\S]*?<\/button>/gi, "")
      .replace(/<input[^>]*\/?>/gi, "")
      .replace(/<select[^>]*>[\s\S]*?<\/select>/gi, "")
      .replace(/<textarea[^>]*>[\s\S]*?<\/textarea>/gi, "")
      // Strip remaining tags but keep text
      .replace(/<[^>]*>/g, "\n")
      // Decode entities
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&[a-z]+;/gi, " ")
      // Remove common junk text patterns
      .replace(/Skip to content/gi, "")
      .replace(/Your cart.*?(?:checkout|empty)/gis, "")
      .replace(/(?:Free shipping|free gift).*?away/gi, "")
      .replace(/Share\s*(?:Facebook|Twitter|Pinterest|Email|Copy link)/gi, "")
      .replace(/Opens in a new window\.?/gi, "")
      .replace(/Choosing a selection results in a full page refresh\.?/gi, "")
      .replace(/Low stock\.?/gi, "")
      .replace(/👉\s*Checkout/gi, "")
      .replace(/\$0\.00\s*est\.?/gi, "")
      .replace(/🎉.*?rewards!?/gi, "")
      .replace(/📦|🎁/g, "")
      // Clean up whitespace
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+/g, " ")
      .replace(/^\s+$/gm, "")
      .trim();

    // Get title from page
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || url;

    return NextResponse.json({ title, content: text.slice(0, 50000), url });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Scrape failed" }, { status: 500 });
  }
}
