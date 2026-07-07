import type { PageData } from "../_lib/page-data";
import type { BlueprintRenderContent } from "@/lib/blueprint-render";
import { BlueprintHero } from "./BlueprintHero";
import { BlueprintIntro } from "./BlueprintIntro";
import { BlueprintReasons } from "./BlueprintReasons";
import { BlueprintReviews } from "./BlueprintReviews";
import { BlueprintFeaturedReview } from "./BlueprintFeaturedReview";
import { BlueprintOffer } from "./BlueprintOffer";
import { BlueprintFaq } from "./BlueprintFaq";
import { BlueprintSocialProof } from "./BlueprintSocialProof";
import { BlueprintFooter } from "./BlueprintFooter";

/**
 * Blueprint-driven storefront lander. The advertorial listicle renders a FIXED, curated section
 * order — every section is a purpose-built component reading structured `content.*`:
 *
 *   hero → intro/proof → 8 reasons → reviews → featured review → offer → FAQ → social proof → footer
 *
 * The generic blueprint blocks (recap / testimonials / offer / faq / footer / cta) are
 * intentionally NOT rendered here — they're replaced wholesale by the components above. Each
 * section self-omits when its content is absent, so a partially-authored blueprint still renders.
 */

function lowestPriceCents(data: PageData): number | null {
  return data.pricing_tiers.length
    ? Math.min(...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents))
    : null;
}

export function BlueprintLander({
  data,
  content,
}: {
  data: PageData;
  content: BlueprintRenderContent;
}) {
  const price = lowestPriceCents(data);
  return (
    <>
      {content.hero && <BlueprintHero {...content.hero} lowestPriceCents={price} />}
      {content.intro && <BlueprintIntro data={data} intro={content.intro} />}
      {content.reasons && content.reasons.length > 0 && (
        <BlueprintReasons
          reasons={content.reasons}
          ctaLabel={content.hero?.ctaLabel || "Feel the Difference, 65% Off Now"}
          reassurance="Feel the difference in 30 days or your money back"
          lowestPriceCents={price}
        />
      )}
      {content.reviews && <BlueprintReviews reviews={content.reviews} />}
      {content.featured && <BlueprintFeaturedReview featured={content.featured} />}
      {content.offer && <BlueprintOffer offer={content.offer} />}
      {content.faq && content.faq.length > 0 && <BlueprintFaq faq={content.faq} />}
      {content.socialProofHeading && <BlueprintSocialProof data={data} heading={content.socialProofHeading} />}
      {content.footer && <BlueprintFooter footer={content.footer} />}
    </>
  );
}
