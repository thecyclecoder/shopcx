import type { CSSProperties } from "react";
import type { PageData } from "../_lib/page-data";
import type { IntroData } from "@/lib/blueprint-render";
import { PressLogos } from "../_components/PressLogos";
import { PressQuote } from "../_components/PressQuote";
import { HeroFeaturedReviews } from "../_components/HeroFeaturedReviews";

/**
 * The intro / proof band above the "8 Reasons" — matches the Erth reference AND the PDP's own
 * credibility treatment by REUSING the storefront components:
 *   • a mechanism visual + a strong product-description paragraph (lander copy, `content.intro`)
 *   • [[../_components/PressLogos]] — the "As Seen On" ABC/NBC/CBS/FOX strip
 *   • [[../_components/PressQuote]] — the attributed press quote (Gourmet Magazine), from awards
 *   • [[../_components/HeroFeaturedReviews]] — the verified-review widget (the powerful one)
 * All three read from PageData, so this stays consistent with the PDP and never fabricates a
 * quote. Replaces the old floating unattributed quote.
 */
const CSS = `
.bp-intro{background:#faf6ef;color:#241810;font-family:var(--storefront-heading-font),"Helvetica Neue",Arial,sans-serif}
.bp-intro__wrap{max-width:900px;margin:0 auto;padding:2.8rem 1.4rem;display:flex;flex-direction:column;align-items:center;text-align:center;gap:2rem}
.bp-intro__img{width:100%;max-width:760px;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(36,24,16,.12);background:#efe7da}
.bp-intro__img img{display:block;width:100%;height:auto}
.bp-intro__desc{font-size:1.18rem;line-height:1.62;color:#3a2c22;max-width:62ch;margin:0}
@media (min-width:900px){.bp-intro__wrap{padding:3.4rem 1.5rem}.bp-intro__desc{font-size:1.24rem}}
`;

export function BlueprintIntro({ data, intro }: { data: PageData; intro: IntroData }) {
  const paras = intro.description.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <section className="bp-intro" data-section="blueprint-intro">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bp-intro__wrap">
        {intro.imageUrl && (
          <div className="bp-intro__img">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={intro.imageUrl} alt={intro.imageAlt || "How Amazing Coffee works"} loading="lazy" decoding="async" />
          </div>
        )}
        <div>
          {paras.map((p, i) => (
            <p className="bp-intro__desc" key={i} style={i > 0 ? ({ marginTop: "1rem" } as CSSProperties) : undefined}>
              {p}
            </p>
          ))}
        </div>
        <PressLogos media={data.media_by_slot} label="As Seen On" align="center" />
        <PressQuote items={data.product.awards} variant="light" />
        {data.reviews.length > 0 && (
          <HeroFeaturedReviews
            reviews={data.reviews}
            workspaceSlug={data.workspace.storefront_slug || undefined}
            slug={data.product.handle}
          />
        )}
      </div>
    </section>
  );
}
