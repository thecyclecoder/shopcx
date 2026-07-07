import type { FooterData } from "@/lib/blueprint-render";

/**
 * The lander's simple footer: the Superfoods Company logo and a single guarantee tagline. No nav,
 * no ingredient links — the lander ends clean. Data-driven off `content.footer`.
 */
const F = 'var(--storefront-heading-font),-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
const CSS = `
.bp-ft{background:#fff;font-family:${F};color:#241810;border-top:1px solid rgba(36,24,16,.1)}
.bp-ft__wrap{max-width:680px;margin:0 auto;padding:2.8rem 1.4rem 3.4rem;display:flex;flex-direction:column;align-items:center;gap:1.1rem;text-align:center}
.bp-ft__logo{max-height:44px;width:auto}
.bp-ft__tag{font-weight:700;font-size:1.05rem;color:#3a2c22;text-wrap:balance}
`;

export function BlueprintFooter({ footer }: { footer: FooterData }) {
  return (
    <footer className="bp-ft" data-section="blueprint-footer">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bp-ft__wrap">
        {footer.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="bp-ft__logo" src={footer.logoUrl} alt="Superfoods Company" loading="lazy" decoding="async" />
        )}
        <div className="bp-ft__tag">{footer.tagline}</div>
      </div>
    </footer>
  );
}
