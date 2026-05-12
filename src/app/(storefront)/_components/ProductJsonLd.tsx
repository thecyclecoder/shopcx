import type { PageData } from "../_lib/page-data";

/**
 * Emits Schema.org structured data for the product page. Combines:
 *   - Product (with brand, image, sku, description, additionalProperty
 *     for certifications/allergen-free)
 *   - AggregateOffer (price range from pricing_tiers + availability)
 *   - AggregateRating (rating + reviewCount matching the visible badge)
 *   - Review[] (top 20 — schema-friendly subset; helps Google show
 *     individual review snippets in search)
 *   - FAQPage with every FAQ item
 *
 * Two scripts so the FAQPage is a discrete type (Google prefers them
 * separately). Both render inline at the start of the page body —
 * fine for SEO crawlers and LLM ingestion.
 */
export function ProductJsonLd({
  data,
  canonicalUrl,
}: {
  data: PageData;
  canonicalUrl?: string;
}) {
  const ld = buildProductLd(data, canonicalUrl);
  const faq = buildFaqLd(data);
  return (
    <>
      <script
        type="application/ld+json"
        // JSON.stringify is safe here — the source is admin-curated
        // strings, and we don't allow any HTML to round-trip through.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }}
      />
      {faq && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faq) }}
        />
      )}
    </>
  );
}

function buildProductLd(data: PageData, canonicalUrl?: string) {
  const product = data.product;
  const tiers = data.pricing_tiers;
  const hero = data.media_by_slot["hero"];

  const additionalProperty: Array<{ "@type": "PropertyValue"; name: string; value: string }> = [];
  for (const c of product.certifications || []) {
    if (c?.trim()) additionalProperty.push({ "@type": "PropertyValue", name: "Certification", value: c });
  }
  for (const a of product.allergen_free || []) {
    if (a?.trim()) additionalProperty.push({ "@type": "PropertyValue", name: "Free From", value: a });
  }
  for (const w of product.awards || []) {
    if (w?.trim()) additionalProperty.push({ "@type": "PropertyValue", name: "Award / Press", value: w });
  }

  // Cheapest unit price, highest unit price — used by Google for the
  // "from $X.XX" snippet.
  const priceValues: number[] = [];
  for (const t of tiers) {
    if (t.subscribe_price_cents != null) priceValues.push(t.subscribe_price_cents);
    if (t.price_cents != null) priceValues.push(t.price_cents);
  }
  const lowPrice = priceValues.length ? Math.min(...priceValues) / 100 : null;
  const highPrice = priceValues.length ? Math.max(...priceValues) / 100 : null;

  // Up to 20 reviews — schema.org/Review individual entries help Google
  // render rich review snippets. We use the SSG payload (already
  // ordered featured > rating > recency).
  const reviewLd = (data.reviews || []).slice(0, 20).map((r) => ({
    "@type": "Review",
    reviewBody: (r.body || r.smart_quote || r.title || "").slice(0, 600),
    reviewRating: {
      "@type": "Rating",
      ratingValue: r.rating ?? 5,
      bestRating: 5,
    },
    author: { "@type": "Person", name: r.reviewer_name || "Verified buyer" },
    datePublished: r.created_at?.slice(0, 10),
  }));

  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description:
      data.page_content?.hero_subheadline ||
      product.description ||
      undefined,
    image: hero?.url ? [hero.url] : undefined,
    sku: product.id,
    brand: {
      "@type": "Brand",
      name: "Superfoods Company",
    },
  };

  if (additionalProperty.length) ld.additionalProperty = additionalProperty;

  if (lowPrice != null && highPrice != null) {
    ld.offers = {
      "@type": "AggregateOffer",
      priceCurrency: "USD",
      lowPrice: lowPrice.toFixed(2),
      highPrice: highPrice.toFixed(2),
      offerCount: tiers.length,
      availability: "https://schema.org/InStock",
      url: canonicalUrl,
    };
  }

  // Use product.rating_count — that's the same bumped number shown
  // in the hero ("4.8 · 2,660 reviews"), keeps JSON-LD consistent
  // with what crawlers see rendered on the page.
  if (product.rating != null && (product.rating_count || 0) > 0) {
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Number(product.rating.toFixed(2)),
      reviewCount: product.rating_count,
      bestRating: 5,
    };
  }

  if (reviewLd.length) ld.review = reviewLd;

  return ld;
}

function buildFaqLd(data: PageData) {
  const items = data.page_content?.faq_items || [];
  if (items.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: it.answer,
      },
    })),
  };
}
