/**
 * The advertorial blueprint lander's OWN call-to-action — deliberately not the shared ShopCTA.
 *
 * ShopCTA is a fixed-height (`h-16`) min-width pill in the store-wide green; on this Erth-palette
 * lander a long label wrapped and overflowed the fixed height on mobile. LanderCTA is padding-sized
 * (auto-height — can never overflow), center-aligned with balanced wrapping, full-width up to a cap
 * on mobile and hugging on desktop, in the lander's amber. Scrolls to the on-page pricing/offer
 * (`#pricing`) like the rest of the storefront CTAs.
 */
const CSS = `
.lander-cta{display:inline-flex;align-items:center;justify-content:center;gap:.55rem;width:100%;max-width:440px;
  background:linear-gradient(180deg,#e07a2f,#bd5a17);color:#fff;font-family:var(--storefront-heading-font),"Helvetica Neue",Arial,sans-serif;
  font-weight:800;text-transform:uppercase;letter-spacing:.02em;font-size:1.14rem;line-height:1.15;text-align:center;text-wrap:balance;
  padding:1.05rem 2rem;border-radius:999px;box-shadow:0 8px 22px rgba(189,90,23,.4);text-decoration:none;
  transition:transform .15s ease,box-shadow .15s ease}
.lander-cta:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(189,90,23,.5)}
.lander-cta:focus-visible{outline:3px solid #241810;outline-offset:3px}
.lander-cta svg{flex-shrink:0}
@media (min-width:900px){.lander-cta{width:auto;font-size:1.18rem;padding:1.05rem 2.7rem}}
@media (prefers-reduced-motion:reduce){.lander-cta{transition:none}}
`;

export function LanderCTA({ label, href = "#pricing" }: { label: string; href?: string }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <a className="lander-cta" href={href}>
        <span>{label}</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M8 5l7 7-7 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
    </>
  );
}
