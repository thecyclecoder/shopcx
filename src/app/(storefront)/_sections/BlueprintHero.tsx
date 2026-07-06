import { SeasonalBanner } from "../_components/SeasonalBanner";
import { ShopCTA } from "../_components/ShopCTA";

/**
 * Composited advertorial hero for a blueprint lander (the "8 Reasons…" Erth-style top fold).
 *
 * Two DELIBERATE designs, mobile-first (base = phone) with a wide composition layered on at
 * ≥1100px — never a fluid one-size compromise. A full-bleed background image sits behind a
 * legibility scrim; the copy is composited ON TOP (not stacked above a "word wall"). The promo
 * bar is a fixed-height [[../_components/SeasonalBanner]] populated client-side (evergreen, no
 * CLS); the hero's own urgency line is STATIC ("… Ends Soon", no season word) so it can't shift.
 *
 * Palette is the Erth warm-coffee direction (amber/cream). We scope `--storefront-primary` to
 * the amber on the hero so the shared [[../_components/ShopCTA]] renders amber HERE without
 * touching the store-wide green. Display type uses the workspace font (`--storefront-heading-font`,
 * Montserrat); the nutritionist quote stays an editorial serif italic.
 */
export interface BlueprintHeroProps {
  brand: string;
  headline: string;
  reviewCount: string; // e.g. "16,000+ 5-star reviews"
  /** Static urgency (no season word) — e.g. "65% Off — Ends Soon". */
  urgency: string;
  quote: { text: string; name: string; title: string; avatarUrl: string | null };
  offer: { discount: string; base: string; subtext: string; heading: string };
  heroImageUrl: string;
  ctaLabel: string;
  ctaHref?: string;
  lowestPriceCents: number | null;
}

const AMBER = "#d2691e"; // scoped --storefront-primary for this lander (ShopCTA reads it)
const HERO_CSS = `
.bp-hero{--storefront-primary:${AMBER};position:relative;overflow:hidden;color:#241810;font-family:var(--storefront-heading-font),"Helvetica Neue",Arial,sans-serif}
.bp-hero__bg{position:absolute;inset:0;background-position:16% center;background-size:cover;background-repeat:no-repeat}
.bp-hero__scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(247,242,232,.74),rgba(247,242,232,.60) 46%,rgba(247,242,232,.80))}
.bp-hero__promo{position:relative;z-index:3;background:#3a2416;color:#f7f2e8;text-align:center;padding:.62rem .6rem;font-weight:700;letter-spacing:.01em;font-size:.8rem;line-height:1.2;min-height:2.4rem;display:flex;align-items:center;justify-content:center}
.bp-hero__inner{position:relative;z-index:2;padding:1.9rem 1.4rem 2.4rem;display:flex;flex-direction:column;align-items:center;text-align:center;gap:.95rem}
.bp-hero__stars{display:flex;align-items:center;gap:.4rem;font-weight:700;font-size:.94rem;white-space:nowrap;text-shadow:0 1px 2px rgba(247,242,232,.72)}
.bp-hero__stars .g{color:#d99a2e;letter-spacing:.06em;font-size:1.08rem}
.bp-hero__wordmark{font-weight:800;letter-spacing:0;text-transform:uppercase;font-size:1rem;opacity:.92;text-shadow:0 1px 2px rgba(247,242,232,.72)}
.bp-hero__h1{font-weight:800;font-size:2.4rem;line-height:1.08;letter-spacing:-.02em;text-wrap:balance;max-width:100%;margin:0;text-shadow:0 1px 4px rgba(247,242,232,.72)}
.bp-hero__urgency{color:#b23a24;font-weight:800;text-transform:uppercase;letter-spacing:.02em;font-size:.92rem;white-space:nowrap;text-shadow:0 1px 2px rgba(247,242,232,.72)}
.bp-hero__rule{width:66%;height:1px;background:rgba(36,24,16,.26);margin:.15rem 0}
.bp-hero__quote{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.85rem;width:100%;background:rgba(247,242,232,.7);border:1px solid rgba(36,24,16,.08);border-radius:18px;padding:1.35rem 1.25rem;backdrop-filter:blur(2px)}
.bp-hero__qhead{font-weight:800;text-transform:uppercase;letter-spacing:.05em;font-size:.82rem;color:#bd5a17}
.bp-hero__qtext{font-family:Georgia,"Times New Roman",serif;font-style:italic;font-size:1.16rem;line-height:1.44;text-wrap:balance;margin:0}
.bp-hero__qattr{display:flex;align-items:center;gap:.7rem;margin-top:.1rem}
.bp-hero__qattr img{width:52px;height:52px;border-radius:50%;object-fit:cover;box-shadow:0 2px 8px rgba(36,24,16,.28);border:2px solid rgba(247,242,232,.9)}
.bp-hero__qwho{display:flex;flex-direction:column;text-align:left}
.bp-hero__qwho strong{font-weight:800;font-size:.86rem;text-transform:uppercase;letter-spacing:.02em}
.bp-hero__qwho em{font-style:normal;font-size:.74rem;color:#4a3628;text-transform:uppercase;letter-spacing:.02em;margin-top:.12rem}
.bp-hero__cta{margin-top:.35rem}
.bp-hero__subtext{text-transform:uppercase;letter-spacing:.03em;font-weight:800;font-size:.88rem;color:#4a3628;text-shadow:0 1px 2px rgba(247,242,232,.72);text-wrap:balance}
@media (min-width:1100px){
  .bp-hero{min-height:100svh;display:grid;place-items:center}
  .bp-hero__bg{background-position:78% center}
  .bp-hero__scrim{background:linear-gradient(102deg,rgba(247,242,232,.90) 0%,rgba(247,242,232,.70) 42%,rgba(247,242,232,.38) 70%,rgba(247,242,232,.14) 100%)}
  .bp-hero__promo{position:absolute;top:0;left:0;right:0;font-size:1.02rem;padding:.78rem 1rem;min-height:0}
  .bp-hero__inner{max-width:900px;padding:5.4rem 1.5rem 3rem;gap:1.2rem}
  .bp-hero__stars{font-size:1.04rem;text-shadow:none}.bp-hero__stars .g{font-size:1.28rem}
  .bp-hero__wordmark{font-size:.92rem;text-shadow:none}
  .bp-hero__h1{font-size:clamp(2.6rem,3.5vw,3.4rem);max-width:15ch;line-height:1.05;text-shadow:none}
  .bp-hero__urgency{font-size:1.12rem;text-shadow:none}
  .bp-hero__rule{width:300px}
  .bp-hero__quote{max-width:540px;padding:1.25rem 1.5rem;background:rgba(247,242,232,.62)}
  .bp-hero__qtext{font-size:1.14rem}
  .bp-hero__subtext{font-size:.84rem;text-shadow:none}
}
`;

export function BlueprintHero(props: BlueprintHeroProps) {
  const { brand, headline, reviewCount, urgency, quote, offer, heroImageUrl, ctaLabel, ctaHref, lowestPriceCents } = props;
  return (
    <section className="bp-hero" data-section="blueprint-hero">
      <style dangerouslySetInnerHTML={{ __html: HERO_CSS }} />
      <div className="bp-hero__bg" style={{ backgroundImage: `url("${heroImageUrl}")` }} />
      <div className="bp-hero__scrim" />
      <SeasonalBanner discount={offer.discount} base={offer.base} />
      <div className="bp-hero__inner">
        <div className="bp-hero__stars">
          <span className="g" aria-hidden>★★★★★</span>
          <span>{reviewCount}</span>
        </div>
        <div className="bp-hero__wordmark">{brand}</div>
        <h1 className="bp-hero__h1">{headline}</h1>
        <div className="bp-hero__urgency">{urgency}</div>
        <div className="bp-hero__rule" />
        <figure className="bp-hero__quote">
          <div className="bp-hero__qhead">{offer.heading}</div>
          <p className="bp-hero__qtext">{quote.text}</p>
          <figcaption className="bp-hero__qattr">
            {quote.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={quote.avatarUrl} alt={quote.name} loading="lazy" decoding="async" />
            )}
            <span className="bp-hero__qwho">
              <strong>{quote.name}</strong>
              <em>{quote.title}</em>
            </span>
          </figcaption>
        </figure>
        <div className="bp-hero__cta">
          <ShopCTA href={ctaHref} label={ctaLabel} lowestPriceCents={lowestPriceCents} showTrust={false} align="center" />
        </div>
        <div className="bp-hero__subtext">{offer.subtext}</div>
      </div>
    </section>
  );
}
