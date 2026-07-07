import type { FaqItem } from "@/lib/blueprint-render";

/**
 * FAQ section (Erth reference): a heading and expandable question rows. Uses native <details>/
 * <summary> so it expands/collapses with zero client JS and stays keyboard-accessible. Data-driven
 * off `content.faq`.
 */
const F = 'var(--storefront-heading-font),-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
const CSS = `
.bp-faq{background:#fff;font-family:${F};color:#241810}
.bp-faq__wrap{max-width:680px;margin:0 auto;padding:3rem 1.4rem}
.bp-faq__h{text-align:center;font-weight:800;font-size:2rem;line-height:1.12;letter-spacing:-.02em;margin:0 0 1.8rem}
.bp-faq__item{border-top:1px solid rgba(36,24,16,.14)}
.bp-faq__item:last-child{border-bottom:1px solid rgba(36,24,16,.14)}
.bp-faq__item summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.2rem .2rem;font-weight:700;font-size:1.08rem;line-height:1.35}
.bp-faq__item summary::-webkit-details-marker{display:none}
.bp-faq__item summary .chev{flex-shrink:0;transition:transform .2s ease;color:#7a6455}
.bp-faq__item[open] summary .chev{transform:rotate(180deg)}
.bp-faq__a{padding:0 .2rem 1.3rem;font-size:1.04rem;line-height:1.6;color:#3a2c22}
@media (min-width:900px){.bp-faq__h{font-size:2.4rem}}
@media (prefers-reduced-motion:reduce){.bp-faq__item summary .chev{transition:none}}
`;

export function BlueprintFaq({ faq }: { faq: FaqItem[] }) {
  if (!faq.length) return null;
  return (
    <section className="bp-faq" data-section="blueprint-faq">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bp-faq__wrap">
        <h2 className="bp-faq__h">Frequently Asked Questions</h2>
        {faq.map((f, i) => (
          <details className="bp-faq__item" key={i}>
            <summary>
              <span>{f.q}</span>
              <svg className="chev" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </summary>
            <div className="bp-faq__a">{f.a}</div>
          </details>
        ))}
      </div>
    </section>
  );
}
