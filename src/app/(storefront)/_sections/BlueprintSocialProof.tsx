import type { PageData } from "../_lib/page-data";
import { HeroFeaturedReviews } from "../_components/HeroFeaturedReviews";

/**
 * "More Than 700,000 Lives Transformed with Superfoods Company" band, followed by the reused
 * verified-review widget ([[../_components/HeroFeaturedReviews]], reading real reviews from
 * PageData). Mirrors the Erth reference's closing social-proof + review-carousel.
 */
const F = 'var(--storefront-heading-font),-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
const CSS = `
.bp-sp{background:#faf6ef;font-family:${F};color:#241810}
.bp-sp__wrap{max-width:760px;margin:0 auto;padding:3rem 1.4rem 3.4rem;display:flex;flex-direction:column;align-items:center;gap:1.8rem}
.bp-sp__h{text-align:center;font-weight:800;font-size:1.9rem;line-height:1.15;letter-spacing:-.02em;text-wrap:balance;margin:0}
.bp-sp__h .n{color:#bd5a17}
.bp-sp__reviews{width:100%}
@media (min-width:900px){.bp-sp__h{font-size:2.4rem}}
`;

export function BlueprintSocialProof({ data, heading }: { data: PageData; heading: string }) {
  return (
    <section className="bp-sp" data-section="blueprint-social-proof">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bp-sp__wrap">
        <h2 className="bp-sp__h">{heading}</h2>
        {data.reviews.length > 0 && (
          <div className="bp-sp__reviews">
            <HeroFeaturedReviews
              reviews={data.reviews}
              workspaceSlug={data.workspace.storefront_slug || undefined}
              slug={data.product.handle}
            />
          </div>
        )}
      </div>
    </section>
  );
}
