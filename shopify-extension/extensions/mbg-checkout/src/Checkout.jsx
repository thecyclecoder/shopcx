import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";

/**
 * Money-Back Guarantee block with its terms one tap away:
 *
 *   Centered on a tinted card:
 *                       [gold seal]
 *               Love it, or your money back
 *     Try your first order for 30 days. If it's not for you,
 *               send it back for a refund.
 *            How the 30-day guarantee works ›   → modal: the published Returns
 *                                                 policy, section by section
 *
 * The tint is the checkout branding's `subdued` background; checkout extensions
 * can't set an arbitrary colour, only transparent / base / subdued.
 *
 * SOURCED, NOT WRITTEN. Whether it shows is decided by the live `refunds` policy
 * (same gate as the trust card's guarantee line); the modal's terms are the
 * published `returns` policy, structured to plain text by GET /api/storefront/
 * guarantee. Edit the policy and checkout follows with no deploy. If the API is
 * unreachable or the policy no longer offers a guarantee, nothing renders.
 *
 * THE LINE IS DELIBERATELY NARROW. The policy covers the first order only and
 * deducts the return label, so the copy says "your first order" and "a refund",
 * never "risk-free" or "full refund". The seal is the store's existing artwork.
 *
 * EVERYONE SEES IT, signed-in returning customers included (founder's call,
 * 2026-10-06). The copy's "your first order" and the terms modal carry the scope,
 * so the block doesn't need to hide itself.
 */
export default function extension() {
  render(<GuaranteeTerms />, document.body);
}

const MODAL_ID = "mbg-terms";

// the store's own gold "100% Money Back Guarantee" seal (Shopify Files)
const DEFAULT_SEAL =
  "https://cdn.shopify.com/s/files/1/0634/9599/5565/files/money-back-guarantee.png?v=1725549424";

/** consecutive list items → one <s-unordered-list> */
function Blocks({ blocks }) {
  const out = [];
  let items = [];
  const flush = () => {
    if (items.length) {
      out.push(
        <s-unordered-list key={`l${out.length}`}>
          {items.map((t, i) => (
            <s-list-item key={i}>{t}</s-list-item>
          ))}
        </s-unordered-list>,
      );
      items = [];
    }
  };
  blocks.forEach((b) => {
    if (b.type === "item") items.push(b.text);
    else {
      flush();
      out.push(<s-paragraph key={`p${out.length}`}>{b.text}</s-paragraph>);
    }
  });
  flush();
  return out;
}

function GuaranteeTerms() {
  const settings = shopify.settings.value;
  const apiEndpoint = String(settings.api_endpoint || "https://shopcx.ai").replace(/\/$/, "");
  const badge = String(settings.badge_url || "").trim();
  const shop = shopify.shop.myshopifyDomain;

  const [guarantee, setGuarantee] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiEndpoint}/api/storefront/guarantee?shop=${encodeURIComponent(shop)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && data.enabled && data.title) setGuarantee(data);
      })
      .catch(() => {
        // fail closed: a guarantee we can't verify is not shown
      });
    return () => {
      cancelled = true;
    };
  }, [apiEndpoint, shop]);

  if (!guarantee) return null;

  const terms = Array.isArray(guarantee.terms) ? guarantee.terms : [];

  return (
    <s-box background="subdued" borderRadius="large" padding="large-200">
      <s-stack gap="small-200" alignItems="center">
        <s-box inlineSize="88px">
          <s-image src={badge || DEFAULT_SEAL} alt="100% money-back guarantee seal" aspectRatio="1" />
        </s-box>
        <s-heading>Love it, or your money back</s-heading>
        <s-paragraph textAlign="center" color="subdued">
          Try your first order for 30 days. If it's not for you, send it back for a refund.
        </s-paragraph>
        {terms.length ? (
          <s-link command="--show" commandFor={MODAL_ID}>
            How the 30-day guarantee works
          </s-link>
        ) : null}
      </s-stack>

      {terms.length ? (
        <s-modal id={MODAL_ID} heading={guarantee.title} padding="base">
          <s-stack gap="base">
            {terms.map((section, i) => (
              <s-stack key={i} gap="small-200">
                {section.heading ? <s-heading>{section.heading}</s-heading> : null}
                <Blocks blocks={section.blocks} />
              </s-stack>
            ))}
          </s-stack>
        </s-modal>
      ) : null}
    </s-box>
  );
}
