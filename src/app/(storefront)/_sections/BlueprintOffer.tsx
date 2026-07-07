import type { OfferData } from "@/lib/blueprint-render";
import { LanderCTA } from "../_components/LanderCTA";
import { CountdownTimer } from "../_components/CountdownTimer";

/**
 * The offer card, modeled on the Erth reference: an orange header band ("Last Chance Offer" +
 * discount), the composed bundle image, product title, a checklist, the amber CTA, a star rating
 * with review count, and a live "Sale Ends in HH:MM:SS" countdown. Data-driven off `content.offer`.
 */
const F = 'var(--storefront-heading-font),-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
const CSS = `
.bp-of{background:#faf6ef;font-family:${F};color:#241810}
.bp-of__wrap{max-width:560px;margin:0 auto;padding:1rem 1.4rem 3rem}
.bp-of__card{border:2px solid #e07a2f;border-radius:20px;overflow:hidden;background:#fff;box-shadow:0 10px 30px rgba(36,24,16,.12)}
.bp-of__band{background:linear-gradient(180deg,#e88a3a,#d9741f);color:#fff;text-align:center;padding:1.3rem 1.2rem}
.bp-of__badge{display:inline-block;background:rgba(255,255,255,.22);border-radius:8px;padding:.35rem .9rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;font-size:.78rem;margin-bottom:.7rem}
.bp-of__headline{font-weight:800;font-size:1.7rem;line-height:1.1;letter-spacing:-.01em;text-wrap:balance;margin:0}
.bp-of__img{width:100%;display:block;background:#f3ede2}
.bp-of__body{padding:1.5rem 1.4rem 1.7rem;text-align:center}
.bp-of__title{font-weight:800;font-size:1.5rem;line-height:1.15;letter-spacing:-.01em;text-wrap:balance;margin:0 0 1.1rem}
.bp-of__list{list-style:none;margin:0 0 1.3rem;padding:0;display:flex;flex-direction:column;gap:.7rem;text-align:left;max-width:340px;margin-left:auto;margin-right:auto}
.bp-of__list li{display:flex;align-items:center;gap:.7rem;font-size:1.04rem}
.bp-of__list .ck{color:#e07a2f;font-weight:900;font-size:1.2rem;flex-shrink:0}
.bp-of__cta{display:flex;justify-content:center}
.bp-of__rate{margin-top:1rem;font-weight:800;font-size:.95rem}
.bp-of__rate .s{color:#f5a623;letter-spacing:.08em}
.bp-of__timer{margin-top:.5rem;font-size:1.02rem;color:#3a2c22}
@media (min-width:900px){.bp-of__headline{font-size:2rem}.bp-of__title{font-size:1.7rem}}
`;

export function BlueprintOffer({ offer, ctaHref }: { offer: OfferData; ctaHref?: string }) {
  return (
    <section className="bp-of" data-section="blueprint-offer" id="pricing">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bp-of__wrap">
        <div className="bp-of__card">
          <div className="bp-of__band">
            <span className="bp-of__badge">{offer.badge}</span>
            <h2 className="bp-of__headline">{offer.headline}</h2>
          </div>
          {offer.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="bp-of__img" src={offer.imageUrl} alt={offer.title} loading="lazy" decoding="async" />
          )}
          <div className="bp-of__body">
            <h3 className="bp-of__title">{offer.title}</h3>
            <ul className="bp-of__list">
              {offer.checklist.map((item, i) => (
                <li key={i}><span className="ck" aria-hidden>✓</span><span>{item}</span></li>
              ))}
            </ul>
            <div className="bp-of__cta"><LanderCTA label={offer.ctaLabel} href={ctaHref} /></div>
            <div className="bp-of__rate"><span className="s" aria-hidden>★★★★★</span> {offer.ratingText}</div>
            <div className="bp-of__timer">Sale Ends in: <CountdownTimer seconds={offer.countdownSeconds} /></div>
          </div>
        </div>
      </div>
    </section>
  );
}
