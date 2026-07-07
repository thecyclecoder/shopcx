import type { FeaturedReviewData } from "@/lib/blueprint-render";

/**
 * A single lifechanging featured review — a lifestyle image, a big pull-quote, the review body,
 * and the reviewer's name. Pulled from our FEATURED review set (real, attributed), replacing the
 * earlier weak/unattributed testimonial. Data-driven off `content.featured`.
 */
const F = 'var(--storefront-heading-font),-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
const CSS = `
.bp-feat{background:#faf6ef;font-family:${F};color:#241810}
.bp-feat__wrap{max-width:680px;margin:0 auto;padding:.5rem 1.4rem 3rem;display:flex;flex-direction:column;align-items:center;text-align:center;gap:1.3rem}
.bp-feat__img{width:100%;max-width:520px;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(36,24,16,.14)}
.bp-feat__img img{display:block;width:100%}
.bp-feat__stars{color:#f5a623;font-size:1.2rem;letter-spacing:.12em}
.bp-feat__q{font-size:1.5rem;line-height:1.3;font-weight:800;letter-spacing:-.01em;text-wrap:balance;margin:0}
.bp-feat__q .hl{color:#bd5a17}
.bp-feat__body{font-size:1.08rem;line-height:1.6;color:#3a2c22;max-width:56ch;margin:0}
.bp-feat__who{font-weight:800;font-size:.95rem;color:#7a6455;display:flex;align-items:center;gap:.4rem}
.bp-feat__who .v{color:#2e7d5b}
@media (min-width:900px){.bp-feat__q{font-size:1.8rem}.bp-feat__body{font-size:1.14rem}}
`;

export function BlueprintFeaturedReview({ featured }: { featured: FeaturedReviewData }) {
  return (
    <section className="bp-feat" data-section="blueprint-featured-review">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bp-feat__wrap">
        {featured.imageUrl && (
          <div className="bp-feat__img">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={featured.imageUrl} alt={`${featured.author}, verified customer`} loading="lazy" decoding="async" />
          </div>
        )}
        <div className="bp-feat__stars" aria-hidden>★★★★★</div>
        <p className="bp-feat__q">&ldquo;{featured.quote}&rdquo;</p>
        <p className="bp-feat__body">{featured.body}</p>
        <div className="bp-feat__who">{featured.author} <span className="v">✓ Verified Buyer</span></div>
      </div>
    </section>
  );
}
