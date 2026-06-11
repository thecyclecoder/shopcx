/**
 * Ad tool — STATIC ads (a separate process from video).
 *
 * Static ads are single, design-led, scroll-stopping stills — NOT frozen video
 * frames. Three designed archetypes, each a Remotion still template populated
 * from real product intelligence:
 *   - review   → a 5★ testimonial card (real review text + reviewer + rating)
 *   - offer    → a bold promo (discount + product + urgency)
 *   - benefit_authority → editorial benefits OR a nutritionist endorsement
 *
 * This file: DB hydration (`loadStaticInputs`) + PURE per-archetype prop builders
 * (`build*Props`) the Remotion compositions consume. See docs/brain/specs/ad-static.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type StaticArchetype = "review" | "offer" | "benefit_authority";
export const STATIC_ARCHETYPES: StaticArchetype[] = ["review", "offer", "benefit_authority"];

/** Brand palette for the templates. Tasteful default; overridable later. */
export interface Brand {
  bg: string;
  fg: string;
  accent: string;
  accentFg: string;
  muted: string;
}
export const DEFAULT_BRAND: Brand = {
  bg: "#FBF7F0", // warm off-white
  fg: "#2B1A12", // deep espresso
  accent: "#E0561F", // Amazing Coffee orange
  accentFg: "#FFFFFF",
  muted: "#8A7A6E",
};

export interface ReviewProps {
  brand: Brand;
  reviewerName: string;
  rating: number; // 1-5
  /** Summarized headline (the smart_quote). */
  headline: string;
  /** Full review body, shown below the headline (truncated to fit). */
  body?: string | null;
  /** @deprecated kept for back-compat — the template falls back to it as the headline. */
  quote?: string;
  verified: boolean;
  productTitle: string;
  productImageUrl?: string | null;
  /** Storefront font key (workspaces.storefront_font); defaults to montserrat. */
  fontKey?: string | null;
}
export interface OfferProps {
  brand: Brand;
  discount: string; // "40% OFF"
  subline: string; // "+ FREE SHIPPING"
  urgency: string; // "For a limited time"
  ctaText: string; // "Shop now"
  productTitle: string;
  productImageUrl?: string | null;
  backdropUrl?: string | null; // optional NBP scene behind
}
export interface BenefitAuthorityProps {
  brand: Brand;
  mode: "benefits" | "authority";
  productTitle: string;
  productImageUrl?: string | null;
  benefits: string[]; // benefits mode
  expert: { name: string; title: string; quote: string; bullets: string[] } | null; // authority mode
}

export interface StaticInputs {
  productTitle: string;
  reviews: Array<{ reviewer_name: string | null; rating: number; body: string | null; smart_quote: string | null; verified_purchase: boolean | null; featured: boolean | null }>;
  endorsement: { name: string; title: string; quote: string; bullets: string[] } | null;
  benefits: string[];
  productImageUrl: string | null;
}

/** Hydrate everything the static archetypes need from product intelligence. */
export async function loadStaticInputs(productId: string): Promise<StaticInputs> {
  const admin = createAdminClient();
  const { data: product } = await admin.from("products").select("id, title").eq("id", productId).single();

  const [reviewsRes, pageRes, benefitsRes, variantRes] = await Promise.all([
    admin
      .from("product_reviews")
      .select("reviewer_name, rating, body, smart_quote, verified_purchase, featured")
      .eq("product_id", productId)
      .gte("rating", 5)
      .order("featured", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(8),
    admin
      .from("product_page_content")
      .select("endorsements, benefit_bar")
      .eq("product_id", productId)
      .eq("status", "published")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("product_benefit_selections")
      .select("benefit_name, role")
      .eq("product_id", productId)
      .order("ai_confidence", { ascending: false })
      .limit(6),
    admin.from("product_variants").select("isolated_image_url").eq("product_id", productId).not("isolated_image_url", "is", null).limit(1).maybeSingle(),
  ]);

  const endos = Array.isArray(pageRes.data?.endorsements) ? (pageRes.data!.endorsements as any[]) : [];
  const endorsement = endos[0]
    ? { name: endos[0].name || "", title: endos[0].title || "", quote: endos[0].quote || "", bullets: Array.isArray(endos[0].bullets) ? endos[0].bullets : [] }
    : null;

  const benefitBar = Array.isArray(pageRes.data?.benefit_bar) ? (pageRes.data!.benefit_bar as any[]) : [];
  const benefits: string[] = (benefitsRes.data?.map((b) => b.benefit_name).filter(Boolean) as string[]) ||
    [];
  // fall back to benefit_bar labels if no selections
  const benefitList = benefits.length ? benefits : benefitBar.map((b) => (typeof b === "string" ? b : b?.label || b?.text)).filter(Boolean);

  return {
    productTitle: product?.title || "the product",
    reviews: (reviewsRes.data as StaticInputs["reviews"]) || [],
    endorsement,
    benefits: benefitList.slice(0, 5),
    productImageUrl: variantRes.data?.isolated_image_url || null,
  };
}

// ── PURE prop builders (one per archetype) ──────────────────────────────────

const trimQuote = (s: string, max = 180) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).replace(/[,;:\s]+\S*$/, "") + "…" : t;
};

export function buildReviewProps(inp: StaticInputs, brand = DEFAULT_BRAND, index = 0, fontKey?: string | null): ReviewProps {
  const r = inp.reviews[index] || inp.reviews[0];
  const headline = trimQuote(r?.smart_quote || r?.body || "This is the best I've ever tried.", 140);
  return {
    brand,
    reviewerName: r?.reviewer_name || "Verified Customer",
    rating: Math.min(5, Math.max(1, Math.round(r?.rating ?? 5))),
    headline,
    body: r?.body || null,
    quote: headline,
    verified: !!r?.verified_purchase,
    productTitle: inp.productTitle,
    productImageUrl: inp.productImageUrl,
    fontKey: fontKey || null,
  };
}

export function buildOfferProps(
  inp: StaticInputs,
  brand = DEFAULT_BRAND,
  offer?: Partial<Pick<OfferProps, "discount" | "subline" | "urgency" | "ctaText">>,
  backdropUrl?: string | null,
): OfferProps {
  return {
    brand,
    discount: offer?.discount || "40% OFF",
    subline: offer?.subline || "+ FREE SHIPPING",
    urgency: offer?.urgency || "For a limited time",
    ctaText: offer?.ctaText || "Shop now",
    productTitle: inp.productTitle,
    productImageUrl: inp.productImageUrl,
    backdropUrl: backdropUrl || null,
  };
}

export function buildBenefitAuthorityProps(inp: StaticInputs, brand = DEFAULT_BRAND, prefer: "auto" | "benefits" | "authority" = "auto"): BenefitAuthorityProps {
  const useAuthority = prefer === "authority" || (prefer === "auto" && !!inp.endorsement);
  return {
    brand,
    mode: useAuthority ? "authority" : "benefits",
    productTitle: inp.productTitle,
    productImageUrl: inp.productImageUrl,
    benefits: inp.benefits.length ? inp.benefits : ["12 superfoods in one cup", "Clean energy, no crash", "Curbs cravings"],
    expert: useAuthority ? inp.endorsement : null,
  };
}
