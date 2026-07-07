import type { ReviewsData } from "@/lib/blueprint-render";

/**
 * Post-reasons reviews section, modeled on the Erth reference: a stars + "Verified Reviews"
 * header, an optional before/after transformation showcase, and review cards styled like a
 * FACEBOOK COMMENT — round avatar + name + a light-gray rounded speech bubble, with an optional
 * photo below. Data-driven off `content.reviews` (real reviews + real names, avatars generated).
 */
const F = 'var(--storefront-heading-font),-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
const CSS = `
.bp-rv{background:#faf6ef;font-family:${F};color:#241810}
.bp-rv__wrap{max-width:680px;margin:0 auto;padding:2.8rem 1.4rem 3.2rem}
.bp-rv__head{text-align:center;display:flex;flex-direction:column;align-items:center;gap:.5rem;margin-bottom:2rem}
.bp-rv__stars{color:#f5a623;font-size:1.3rem;letter-spacing:.12em}
.bp-rv__count{font-weight:800;text-transform:uppercase;letter-spacing:.06em;font-size:.82rem;color:#7a6455}
.bp-rv__h{font-weight:800;font-size:1.9rem;line-height:1.12;letter-spacing:-.02em;text-wrap:balance;margin:.2rem 0 0}
.bp-rv__ba{margin:0 auto 2rem;max-width:560px;text-align:center}
.bp-rv__ba img{width:100%;border-radius:16px;display:block;box-shadow:0 4px 16px rgba(36,24,16,.14)}
.bp-rv__ba-cap{margin-top:.7rem;font-weight:800;font-size:1rem;color:#2e7d5b}
.bp-rv__card{background:#fff;border:1px solid rgba(36,24,16,.08);border-radius:16px;padding:1.15rem 1.2rem;margin-bottom:1.1rem;box-shadow:0 2px 10px rgba(36,24,16,.06)}
.bp-rv__top{display:flex;align-items:center;gap:.7rem;margin-bottom:.7rem}
.bp-rv__av{width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0;background:#e7ddcd}
.bp-rv__who{display:flex;flex-direction:column;line-height:1.2}
.bp-rv__name{font-weight:800;font-size:.98rem;color:#1c3d5a}
.bp-rv__badge{font-size:.74rem;font-weight:700;color:#2e7d5b;display:flex;align-items:center;gap:.25rem}
.bp-rv__bubble{background:#f0f2f5;border-radius:14px;padding:.85rem 1rem;font-size:1rem;line-height:1.5;color:#2c2118}
.bp-rv__photo{margin-top:.8rem;width:100%;border-radius:12px;display:block}
@media (min-width:900px){.bp-rv__wrap{padding:3.4rem 1.5rem 4rem}.bp-rv__h{font-size:2.3rem}}
`;

export function BlueprintReviews({ reviews }: { reviews: ReviewsData }) {
  return (
    <section className="bp-rv" data-section="blueprint-reviews">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bp-rv__wrap">
        <div className="bp-rv__head">
          <div className="bp-rv__stars" aria-hidden>★★★★★</div>
          <div className="bp-rv__count">{reviews.ratingText}</div>
          <h2 className="bp-rv__h">{reviews.header}</h2>
        </div>
        {reviews.beforeAfter && (
          <figure className="bp-rv__ba">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={reviews.beforeAfter.imageUrl} alt="Customer before and after transformation" loading="lazy" decoding="async" />
            <figcaption className="bp-rv__ba-cap">{reviews.beforeAfter.caption}</figcaption>
          </figure>
        )}
        {reviews.cards.map((c, i) => (
          <article className="bp-rv__card" key={i}>
            <div className="bp-rv__top">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {c.avatarUrl && <img className="bp-rv__av" src={c.avatarUrl} alt={c.name} loading="lazy" decoding="async" />}
              <div className="bp-rv__who">
                <span className="bp-rv__name">{c.name}</span>
                <span className="bp-rv__badge">✓ Verified Buyer</span>
              </div>
            </div>
            <div className="bp-rv__bubble">{c.body}</div>
            {c.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="bp-rv__photo" src={c.imageUrl} alt={`${c.name} photo`} loading="lazy" decoding="async" />
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
