// cards/ShippingProtectionCard.jsx — Toggle shipping protection (redesigned)
import { useState, useContext } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { postJson, clearCaches } from '../core/api.js';
import { safeStr } from '../core/utils.js';

export default function ShippingProtectionCard({ contract, shipLine, onUpdate }) {
  const { config, startAction, completeAction, failAction } = useContext(PortalContext);
  const [busy, setBusy] = useState(false);
  const hasShipProt = !!shipLine;
  const variantIds = config.shippingProtectionProductIds || [];
  const isConfigured = variantIds.length > 0;

  if (!isConfigured) return null;

  // Price display
  const currentPrice = shipLine?.currentPrice?.amount;
  const onPriceText = currentPrice != null ? '$' + Number(currentPrice).toFixed(2) : '$0.00';
  const listPrice = '$5.00';
  const discPrice = '$3.75';

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const nextOn = !hasShipProt;
    startAction();
    try {
      if (nextOn) {
        await postJson('replaceVariants', {
          contractId: contract.id,
          newVariants: [{ variantId: String(variantIds[0]), quantity: 1 }],
        });
      } else {
        await postJson('replaceVariants', {
          contractId: contract.id,
          oldVariants: [{ variantId: safeStr(shipLine?.variantId) }],
          allowRemoveWithoutAdd: true,
        });
      }
      completeAction(nextOn ? 'Shipping protection added!' : 'Shipping protection removed.');
      clearCaches();
      onUpdate();
    } catch (e) {
      failAction(e?.message || 'Could not update shipping protection.');
    }
    setBusy(false);
  }

  const toggleId = 'sp_shipprot_' + (contract?.id || 'x');

  return (
    <div class={'sp-card sp-detail__card sp-shipprot' + (hasShipProt ? ' sp-shipprot--active' : '')}>
      <div class="sp-shipprot__toprow">
        <div class="sp-shipprot__header">
          <div class="sp-shipprot__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              {hasShipProt && <polyline points="9 12 11 14 15 10" />}
            </svg>
          </div>
          <div class="sp-shipprot__text">
            <div class="sp-shipprot__title">Shipping Protection</div>
            <div class="sp-shipprot__status">
              {hasShipProt ? 'Protected' : 'Not Protected'}
            </div>
          </div>
        </div>
        <div class="sp-switchwrap">
          <input class="sp-switch" type="checkbox" id={toggleId}
            checked={hasShipProt} disabled={busy}
            onChange={toggle} />
          <label class="sp-switchlabel" for={toggleId}>
            <span class="sp-switchtrack"><span class="sp-switchthumb" /></span>
          </label>
        </div>
      </div>
      <p class="sp-shipprot__desc">
        {hasShipProt
          ? 'Your orders are protected against loss, theft, and damage.'
          : 'Protect against loss, theft, and damage.'}
      </p>
      <div class="sp-shipprot__footer">
        <div class="sp-shipprot__price">
          {hasShipProt
            ? <><strong>{onPriceText}</strong><span class="sp-shipprot__per"> / order</span></>
            : <><span class="sp-shipprot__strike">{listPrice}</span> <strong class="sp-shipprot__now">{discPrice}</strong><span class="sp-shipprot__per"> / order</span></>
          }
        </div>
        {!hasShipProt && (
          <div class="sp-shipprot__social">85% of customers add this</div>
        )}
      </div>
    </div>
  );
}
