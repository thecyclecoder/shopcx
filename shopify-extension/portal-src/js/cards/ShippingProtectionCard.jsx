// cards/ShippingProtectionCard.jsx — Toggle shipping protection
import { useState, useContext } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { postJson, clearCaches } from '../core/api.js';
import { safeStr } from '../core/utils.js';

export default function ShippingProtectionCard({ contract, shipLine, onUpdate }) {
  const { config, showToast } = useContext(PortalContext);
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
    try {
      await postJson('replaceVariants', {
        contractId: contract.id,
        ...(nextOn
          ? { newVariants: [{ variantId: String(variantIds[0]), quantity: 1 }] }
          : { oldVariants: [{ variantId: safeStr(shipLine?.variantId) }], allowRemoveWithoutAdd: true }
        ),
      });
      showToast(nextOn ? 'Shipping protection added!' : 'Shipping protection removed.', 'success');
      clearCaches();
      onUpdate();
    } catch {
      showToast('Could not update shipping protection.', 'error');
    }
    setBusy(false);
  }

  const toggleId = 'sp_shipprot_' + (contract?.id || 'x');

  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Shipping Protection</div>
        <p class="sp-muted sp-detail__section-sub">Protect orders from loss or theft during shipping.</p>
      </div>
      <div class="sp-detail__shiprow">
        <div class="sp-detail__shipmeta">
          <div class="sp-detail__shipstate">{hasShipProt ? 'Currently on' : 'Currently off'}</div>
          <p class="sp-muted sp-detail__shipsub">85% of customers choose this.</p>
          <div class="sp-muted sp-shipprot__priceRow">
            <span>Price: </span>
            {hasShipProt
              ? <strong>{onPriceText}</strong>
              : <><span class="sp-shipprot__strike">{listPrice}</span><strong class="sp-shipprot__now">{discPrice}</strong></>
            }
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
    </div>
  );
}
