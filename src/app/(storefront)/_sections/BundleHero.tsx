import type { PageData } from "../_lib/page-data";
import { ShopCTA } from "../_components/ShopCTA";

/**
 * Bundle PDP hero (rendered for ?variant=bundle&name=…). Carries the composed bundle image and the
 * "Select Bundle" buy control — selection lives HERE, not in a price-table chapter (those are
 * dropped for the bundle PDP). The section is `id="pricing"` so every existing storefront CTA that
 * targets `#pricing` scrolls back to this hero, satisfying "all CTAs roll to the hero."
 *
 * Checkout is wired to the base coffee variant (subscribe, default frequency) as a working
 * PLACEHOLDER — the real Starter Kit variant + offer come from the `offer-creator` /
 * `digital-goods-delivery` specs. Swap `buyVariantId` when the Starter Kit variant lands.
 */
const F = 'var(--storefront-heading-font),"Helvetica Neue",Arial,sans-serif';
const CSS = `
.bh{background:#fff;font-family:${F};color:#18181b}
.bh__wrap{max-width:1080px;margin:0 auto;padding:1.6rem 1.4rem 2.4rem;display:flex;flex-direction:column;align-items:center;text-align:center;gap:1.1rem}
.bh__stars{display:flex;align-items:center;justify-content:center;gap:.5rem;font-weight:700;font-size:.94rem;color:#3f3f46}
.bh__stars .s{color:#f5a623;letter-spacing:.06em;font-size:1.05rem}
.bh__h1{font-weight:800;font-size:2rem;line-height:1.1;letter-spacing:-.02em;text-wrap:balance;margin:0}
.bh__img{width:100%;max-width:620px;border-radius:18px;overflow:hidden;box-shadow:0 8px 26px rgba(24,24,27,.12);background:#f4f1ea}
.bh__img img{display:block;width:100%}
.bh__price{display:flex;align-items:baseline;justify-content:center;gap:.55rem;flex-wrap:wrap}
.bh__price .now{font-weight:800;font-size:2rem;color:var(--storefront-primary,#055c3f)}
.bh__price .was{font-size:1.1rem;color:#9ca3af;text-decoration:line-through}
.bh__price .renew{width:100%;font-size:.9rem;color:#52525b;margin-top:.1rem}
.bh__list{list-style:none;margin:.2rem 0 .3rem;padding:0;display:flex;flex-direction:column;gap:.55rem;text-align:left;max-width:340px}
.bh__list li{display:flex;align-items:center;gap:.6rem;font-size:1.02rem}
.bh__list .ck{color:var(--storefront-primary,#055c3f);font-weight:900;flex-shrink:0}
.bh__cta{width:100%;max-width:440px}
.bh__reassure{font-size:.86rem;color:#71717a}
@media (min-width:1000px){
  .bh__wrap{display:grid;grid-template-columns:1fr 1fr;align-items:center;text-align:left;gap:2.6rem;padding:2.6rem 1.5rem}
  .bh__img{grid-row:1 / span 6;grid-column:2}
  .bh__h1{font-size:2.6rem}
  .bh__stars,.bh__price,.bh__list,.bh__cta{justify-self:start}
}
`;

export function BundleHero({ data }: { data: PageData }) {
  const img = data.media_by_slot["bundle_hero"]?.url || data.media_by_slot["hero"]?.url || null;
  const buyVariantId = data.base_variant?.id || null; // PLACEHOLDER — swap for the Starter Kit variant
  const freqs = data.pricing_rule?.available_frequencies || [];
  const defFreq = freqs.find((f) => f.default) || freqs[0] || null;
  const ratingCount = data.product.rating_count;
  return (
    <section id="pricing" data-section="bundle-hero" className="bh">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bh__wrap">
        <div className="bh__stars">
          <span className="s" aria-hidden>★★★★★</span>
          <span>{ratingCount ? `${ratingCount.toLocaleString()} Verified Reviews` : "16,000+ Verified Reviews"}</span>
        </div>
        <h1 className="bh__h1">Amazing Coffee + Free Starter Kit</h1>
        {img && (
          <div className="bh__img">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img} alt="Amazing Coffee Starter Kit — coffee, frother, mug, and guide" />
          </div>
        )}
        <div className="bh__price">
          <span className="now">$49.95</span>
          <span className="was">$154.85</span>
          <span className="renew">today, then $59.95/mo. Cancel anytime.</span>
        </div>
        <ul className="bh__list">
          <li><span className="ck" aria-hidden>✓</span><span><strong>FREE</strong> Milk Frother, Mug &amp; E-Guide</span></li>
          <li><span className="ck" aria-hidden>✓</span><span><strong>FREE</strong> Shipping</span></li>
          <li><span className="ck" aria-hidden>✓</span><span>30-Day Money-Back Guarantee</span></li>
        </ul>
        <div className="bh__cta">
          <ShopCTA
            href={buyVariantId ? `#buy-${buyVariantId}` : "#pricing"}
            label="Select Bundle"
            align="center"
            showTrust={false}
            dataAttributes={
              buyVariantId
                ? { "variant-id": buyVariantId, "tier-quantity": 1, mode: "subscribe", "frequency-days": defFreq?.interval_days ?? null }
                : undefined
            }
          />
        </div>
        <div className="bh__reassure">Feel the difference in 30 days or your money back</div>
      </div>
    </section>
  );
}
