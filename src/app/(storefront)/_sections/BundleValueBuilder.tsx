import type { PageData } from "../_lib/page-data";
import { ShopCTA } from "../_components/ShopCTA";

/**
 * The bundle PDP's value builder — sits in the hero between the subhead and the "As Seen On" row.
 * Price line + "Your FREE Starter Kit Includes" grid + Add to Cart + a risk-aversion block
 * (guarantee / cancel-anytime / refill notice + satisfaction seal + risk-free copy). Replaces the
 * plain "Select Bundle" hero CTA. Add to Cart uses the real #buy add-to-cart on the base variant
 * (placeholder for the Starter Kit variant, per the offer-creator spec).
 */
const AMAZING = "ea433e56-0aa4-4b46-9107-feb11f77f533";
const KIT_BASE = `https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/${AMAZING}/kit/`;

const KIT_ITEMS: { img: string; label: string; free: boolean }[] = [
  { img: "kit-coffee.jpg", label: "30 Servings Amazing Coffee", free: false },
  { img: "kit-frother.jpg", label: "Electric Milk Frother", free: true },
  { img: "kit-mug.jpg", label: "Reusable Coffee Mug", free: true },
  { img: "kit-eguide.jpg", label: "Superfood Coffee E-Guide", free: true },
  { img: "kit-box.jpg", label: "Shipping + Custom Kit Box", free: true },
];

const CSS = `
.bvb{margin-top:1.5rem;border:1px solid rgba(24,24,27,.1);border-radius:20px;padding:1.4rem 1.3rem 1.6rem;background:#fff;box-shadow:0 4px 18px rgba(24,24,27,.06)}
.bvb__price{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;margin-bottom:1.1rem}
.bvb__now{font-weight:800;font-size:2.1rem;color:#241810}
.bvb__was{font-size:1.25rem;color:#9ca3af;text-decoration:line-through}
.bvb__badge{background:linear-gradient(180deg,#e88a3a,#d9741f);color:#fff;font-weight:800;text-transform:uppercase;letter-spacing:.02em;font-size:.82rem;padding:.5rem .9rem;border-radius:10px}
.bvb__kh{text-align:center;font-weight:800;font-size:1.12rem;margin:.2rem 0 1rem}
.bvb__kh .f{color:#d9741f}
.bvb__grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.7rem;margin-bottom:1.3rem}
.bvb__card{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.45rem}
.bvb__thumb{width:100%;aspect-ratio:1/1;border-radius:12px;overflow:hidden;border:2px solid #f0c99a;background:#f7f1e8}
.bvb__thumb img{width:100%;height:100%;object-fit:cover;display:block}
.bvb__label{font-size:.78rem;line-height:1.25;font-weight:600;color:#3a2c22}
.bvb__label .f{color:#d9741f;font-weight:800}
.bvb__cta{margin-top:.2rem}
.bvb__risk{margin-top:1.5rem;padding-top:1.3rem;border-top:1px solid rgba(24,24,27,.1)}
.bvb__rlist{list-style:none;margin:0 0 1.2rem;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:.6rem .8rem}
.bvb__rlist li{display:flex;align-items:center;gap:.5rem;font-size:.95rem;color:#3f3f46}
.bvb__rlist .ck{color:#d9741f;font-weight:900;flex-shrink:0}
.bvb__guar{display:flex;align-items:center;gap:1rem}
.bvb__seal{width:92px;height:92px;flex-shrink:0;object-fit:contain}
.bvb__gtext{font-size:1.02rem;line-height:1.45;color:#241810;font-weight:600}
.bvb__gtext .hl{color:#d9741f;font-weight:800}
@media (min-width:900px){.bvb__now{font-size:2.3rem}}
`;

export function BundleValueBuilder({ data }: { data: PageData }) {
  const variantId = data.base_variant?.id || null;
  const freqs = data.pricing_rule?.available_frequencies || [];
  const freq = freqs.find((f) => f.default) || freqs[0] || null;
  return (
    <div className="bvb" data-section="bundle-value-builder">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bvb__price">
        <span className="bvb__now">$49.95</span>
        <span className="bvb__was">$154.85</span>
        <span className="bvb__badge">65% Off Today</span>
      </div>

      <div className="bvb__kh">Your <span className="f">FREE</span> Starter Kit Includes ($75 Value):</div>
      <div className="bvb__grid">
        {KIT_ITEMS.map((k, i) => (
          <div className="bvb__card" key={i}>
            <div className="bvb__thumb">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={KIT_BASE + k.img} alt={k.label} loading="lazy" decoding="async" />
            </div>
            <div className="bvb__label">{k.free && <span className="f">FREE </span>}{k.label}</div>
          </div>
        ))}
      </div>

      <div className="bvb__cta">
        <ShopCTA
          href={variantId ? `#buy-${variantId}` : "#pricing"}
          label="Add to Cart"
          align="center"
          showTrust={false}
          dataAttributes={
            variantId
              ? { "variant-id": variantId, "tier-quantity": 1, mode: "subscribe", "frequency-days": freq?.interval_days ?? null }
              : undefined
          }
        />
      </div>

      <div className="bvb__risk">
        <ul className="bvb__rlist">
          <li><span className="ck" aria-hidden>✓</span> FREE 3-Day Shipping</li>
          <li><span className="ck" aria-hidden>✓</span> 30-Day Guarantee</li>
          <li><span className="ck" aria-hidden>✓</span> Cancel Anytime</li>
          <li><span className="ck" aria-hidden>✓</span> Refill ships in 30 days</li>
        </ul>
        <div className="bvb__guar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="bvb__seal" src={KIT_BASE + "satisfaction-seal.png"} alt="100% Satisfaction Guarantee" loading="lazy" decoding="async" />
          <p className="bvb__gtext">
            <span className="hl">Try Amazing Coffee risk-free for 30 Days.</span> If you&rsquo;re not satisfied we will refund you, no questions asked. Reclaim your health today.
          </p>
        </div>
      </div>
    </div>
  );
}
