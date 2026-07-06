import { LanderCTA } from "../_components/LanderCTA";
import type { ReasonItem } from "@/lib/blueprint-render";

/**
 * The "8 Reasons…" body of an advertorial blueprint lander — one ROW per reason.
 *
 * Desktop (≥900px): image LEFT, content RIGHT (numbered headline · copy · CTA · reassurance).
 * Mobile: stacks (image → headline → copy → CTA). Every reason gets its own image + CTA — the
 * repeated buy button is the DR pattern (a decision point at every scroll depth). Data-driven
 * off `lander_blueprints.content.reasons`. Palette scoped to the Erth amber like the hero.
 */

const AMBER = "#d2691e";
const REASONS_CSS = `
.bp-reasons{--storefront-primary:${AMBER};background:#faf6ef;font-family:var(--storefront-heading-font),"Helvetica Neue",Arial,sans-serif;color:#241810}
.bp-reasons__wrap{max-width:1120px;margin:0 auto;padding:2.6rem 1.4rem}
.bp-reason{display:flex;flex-direction:column;gap:1.1rem;padding:2rem 0;border-top:1px solid rgba(36,24,16,.1)}
.bp-reason:first-child{border-top:0;padding-top:.5rem}
.bp-reason__img{width:100%;aspect-ratio:4 / 3;border-radius:16px;overflow:hidden;background:#efe7da;box-shadow:0 4px 16px rgba(36,24,16,.12)}
.bp-reason__img img{display:block;width:100%;height:100%;object-fit:cover}
.bp-reason__body{display:flex;flex-direction:column;gap:1rem}
.bp-reason__h{font-weight:800;font-size:1.6rem;line-height:1.12;letter-spacing:-.02em;text-wrap:balance;margin:0}
.bp-reason__p{font-size:1.08rem;line-height:1.6;color:#3a2c22;margin:0}
.bp-reason__p+.bp-reason__p{margin-top:.7rem}
.bp-reason__reassure{text-align:center;font-weight:700;font-size:.86rem;color:#7a6455;text-transform:uppercase;letter-spacing:.03em}
@media (min-width:900px){
  .bp-reason{flex-direction:row;align-items:center;gap:2.6rem;padding:2.8rem 0}
  .bp-reason__img{flex:0 0 44%;max-width:44%}
  .bp-reason__body{flex:1}
  .bp-reason__h{font-size:2.1rem}
  .bp-reason__reassure{text-align:left}
}
`;

export function BlueprintReasons({
  reasons,
  ctaLabel,
  ctaHref,
  reassurance,
  lowestPriceCents,
}: {
  reasons: ReasonItem[];
  ctaLabel: string;
  ctaHref?: string;
  reassurance: string;
  lowestPriceCents: number | null;
}) {
  if (!reasons.length) return null;
  return (
    <section className="bp-reasons" data-section="blueprint-reasons">
      <style dangerouslySetInnerHTML={{ __html: REASONS_CSS }} />
      <div className="bp-reasons__wrap">
        {reasons.map((r) => (
          <article className="bp-reason" key={r.n} data-reason={r.n}>
            {r.imageUrl && (
              <div className="bp-reason__img">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={r.imageUrl} alt={r.imageAlt || r.headline} loading="lazy" decoding="async" />
              </div>
            )}
            <div className="bp-reason__body">
              <h2 className="bp-reason__h">{`${r.n}. ${r.headline}`}</h2>
              {r.copy.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p, i) => (
                <p className="bp-reason__p" key={i}>{p}</p>
              ))}
              <div>
                <LanderCTA label={ctaLabel} href={ctaHref} />
              </div>
              <div className="bp-reason__reassure">{reassurance}</div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
