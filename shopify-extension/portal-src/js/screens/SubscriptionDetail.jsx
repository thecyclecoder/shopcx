// screens/SubscriptionDetail.jsx — Subscription detail with all cards + dunning
import { useState, useEffect, useContext, useCallback } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { requestJson, postJson, clearCaches, getCachedContractById } from '../core/api.js';
import { normalizeContract, bucket as getBucket, fmtDate, billingLabel, shortId, money, safeStr, splitLines, getLineImage, getLinePrice, toMoney } from '../core/utils.js';
import { SkeletonCard } from '../components/Skeleton.jsx';
import Pill from '../components/Pill.jsx';
import { DunningBanner } from '../components/DunningBanner.jsx';
import Modal from '../components/Modal.jsx';
import ShippingProtectionCard from '../cards/ShippingProtectionCard.jsx';
import RewardsCard from '../cards/RewardsCard.jsx';
import ReviewsCard from '../cards/ReviewsCard.jsx';
import AddSwapModal from '../modals/AddSwapModal.jsx';
import RemoveModal from '../modals/RemoveModal.jsx';
import QuantityModal from '../modals/QuantityModal.jsx';
import { fireConfetti } from '../core/confetti.js';

// Compute MSRP (full retail) for a line item × quantity
// 1. pricingPolicy.basePrice (set after swap mutations)
// 2. catalog variant compare_at_price_cents or price_cents
function getLineMsrp(ln, catalogProducts) {
  const qty = ln.quantity || 1;
  // Source 1: pricingPolicy basePrice (MoneyV2 — dollars)
  const bp = ln.pricingPolicy?.basePrice?.amount;
  if (bp != null && isFinite(Number(bp))) return Number(bp) * qty;
  // Source 2: catalog variant compare_at_price_cents or price_cents
  if (Array.isArray(catalogProducts)) {
    const lnPid = String(ln.productId || '');
    const prod = catalogProducts.find(p =>
      String(p.productId || '') === lnPid || String(p.internalId || '') === lnPid
    );
    if (prod?.variants) {
      const vid = String(ln.variantId || '');
      const v = prod.variants.find(vr => String(vr.id || '') === vid);
      if (v) {
        const raw = v.compare_at_price_cents || v.compare_at_price || v.price_cents || v.price;
        if (raw != null) {
          const n = Number(raw);
          if (isFinite(n)) {
            // If it looks like cents (no decimal & >= 1000), convert; otherwise treat as dollars
            const dollars = (String(raw).includes('.') || n < 1000) ? n : n / 100;
            return dollars * qty;
          }
        }
      }
    }
  }
  return null;
}

// ---- Inline cards ----

function PauseCard({ contract, onUpdate, showToast, startAction, completeAction, failAction }) {
  const [busy, setBusy] = useState(false);
  async function doPause(days) {
    setBusy(true);
    startAction();
    try {
      await postJson('pause', { contractId: contract.id, pauseDays: days });
      const resumeDate = new Date();
      resumeDate.setDate(resumeDate.getDate() + days);
      const label = resumeDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      completeAction('Subscription paused until ' + label);
      clearCaches(); onUpdate();
    } catch { failAction('Could not pause.'); }
    setBusy(false);
  }
  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Pause subscription</div>
        <p class="sp-muted sp-detail__section-sub">Take a break without losing your subscriber perks.</p>
      </div>
      <div class="sp-detail__actions sp-detail__actions--stack">
        <button class="sp-btn sp-btn-primary" disabled={busy} onClick={() => doPause(30)}>Pause 30 days</button>
        <button class="sp-btn sp-btn--ghost" disabled={busy} onClick={() => doPause(60)}>Pause 60 days</button>
      </div>
    </div>
  );
}

function ResumeCard({ contract, onUpdate, showToast, startAction, completeAction, failAction }) {
  const [busy, setBusy] = useState(false);
  async function doResume() {
    setBusy(true);
    startAction();
    try {
      await postJson('resume', { contractId: contract.id });
      completeAction('Subscription resumed!');
      clearCaches(); onUpdate();
    } catch { failAction('Could not resume.'); }
    setBusy(false);
  }
  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Resume subscription</div>
        <p class="sp-muted sp-detail__section-sub">Restart your deliveries when you're ready.</p>
      </div>
      <button class="sp-btn sp-btn-primary" disabled={busy} onClick={doResume}>Resume subscription</button>
    </div>
  );
}

function ReactivateCard({ contract, showToast, onUpdate, startAction, completeAction, failAction }) {
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedDate, setSelectedDate] = useState('');

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 2);
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 90);
  const minStr = tomorrow.toISOString().split('T')[0];
  const maxStr = maxDate.toISOString().split('T')[0];

  async function doReactivate() {
    if (!selectedDate || busy) return;
    setBusy(true);
    setModal(false);
    startAction();
    try {
      await postJson('reactivate', { contractId: contract.id, nextBillingDate: selectedDate });
      completeAction('Subscription reactivated!');
      clearCaches();
      // Optimistic update — Appstle may be async so re-fetch could return stale cancelled status
      onUpdate({ status: 'ACTIVE', nextBillingDate: selectedDate });
    } catch (e) {
      failAction(e?.message || 'Could not reactivate.');
    }
    setBusy(false);
  }

  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Reactivate subscription</div>
        <p class="sp-muted sp-detail__section-sub">Pick up where you left off.</p>
      </div>
      <button class="sp-btn sp-btn-primary" onClick={() => { setSelectedDate(''); setModal(true); }}>Reactivate</button>
      {modal && (
        <Modal title="Reactivate subscription" onClose={() => setModal(false)} footer={
          <><button class="sp-btn sp-btn-primary" disabled={busy || !selectedDate} onClick={doReactivate}>
            {busy ? 'Reactivating…' : 'Reactivate'}
          </button>
          <button class="sp-btn sp-btn--ghost" onClick={() => setModal(false)}>Cancel</button></>
        }>
          <div class="sp-detail__date-pick">
            <label class="sp-muted">Choose your next order date</label>
            <input type="date" class="sp-input" min={minStr} max={maxStr} value={selectedDate}
              onFocus={(e) => e.target.showPicker?.()}
              onInput={(e) => setSelectedDate(e.target.value)} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function OrderActionsCard({ contract, showToast, onUpdate, startAction, completeAction, failAction }) {
  const [dateModal, setDateModal] = useState(false);
  const [orderNowConfirm, setOrderNowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedDate, setSelectedDate] = useState('');

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 2);
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 90);
  const minStr = tomorrow.toISOString().split('T')[0];
  const maxStr = maxDate.toISOString().split('T')[0];

  async function saveDate() {
    if (!selectedDate || busy) return;
    // Validate date range client-side
    if (selectedDate < minStr || selectedDate > maxStr) {
      showToast('Please select a date within the next 90 days.', 'error');
      return;
    }
    setBusy(true);
    setDateModal(false);
    startAction();
    try {
      await postJson('changeDate', { contractId: contract.id, nextBillingDate: selectedDate });
      const d = new Date(selectedDate + 'T00:00:00');
      const label = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      completeAction('Next order date changed to ' + label);
      clearCaches(); onUpdate();
    } catch (e) {
      failAction(e?.message || 'Could not update date.');
    }
    setBusy(false);
  }

  async function doOrderNow() {
    setBusy(true);
    setOrderNowConfirm(false);
    startAction();
    try {
      await postJson('orderNow', { contractId: contract.id });
      completeAction('Order placed! Check your email for confirmation.');
      clearCaches(); onUpdate();
    } catch (e) {
      failAction(e?.message || 'Could not place order.');
    }
    setBusy(false);
  }

  const nextDate = contract.nextBillingDate ? fmtDate(contract.nextBillingDate) : null;

  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Order actions</div>
        {nextDate && <p class="sp-muted sp-detail__section-sub">Next order: {nextDate}</p>}
      </div>
      <div class="sp-detail__actions sp-detail__actions--stack">
        <button class="sp-btn sp-btn-primary" disabled={busy} onClick={() => setOrderNowConfirm(true)}>
          Order now
        </button>
        <button class="sp-btn sp-btn--ghost" disabled={busy} onClick={() => { setSelectedDate(''); setDateModal(true); }}>
          Change next order date
        </button>
      </div>

      {orderNowConfirm && (
        <Modal title="Order now" onClose={() => setOrderNowConfirm(false)} footer={
          <><button class="sp-btn sp-btn-primary" disabled={busy} onClick={doOrderNow}>
            {busy ? 'Placing order…' : 'Confirm'}
          </button>
          <button class="sp-btn sp-btn--ghost" onClick={() => setOrderNowConfirm(false)}>Cancel</button></>
        }>
          <p>This will process your next subscription order immediately. Your card on file will be charged.</p>
        </Modal>
      )}

      {dateModal && (
        <Modal title="Change next order date" onClose={() => setDateModal(false)} footer={
          <><button class="sp-btn sp-btn-primary" disabled={busy || !selectedDate} onClick={saveDate}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button class="sp-btn sp-btn--ghost" onClick={() => setDateModal(false)}>Cancel</button></>
        }>
          <div class="sp-detail__date-pick">
            <label class="sp-muted">Select a new date (up to 60 days out)</label>
            <input type="date" class="sp-input" min={minStr} max={maxStr} value={selectedDate}
              onFocus={(e) => e.target.showPicker?.()}
              onInput={(e) => setSelectedDate(e.target.value)} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function LineItemDisclosure({ ln, canRemove, onSwap, onQty, onRemove, removing, forceClose, catalog, contract, onPatchLines, onDone }) {
  const [open, setOpen] = useState(false);
  const [flavorOpen, setFlavorOpen] = useState(false);
  const [flavorBusy, setFlavorBusy] = useState(false);
  const { showToast, startAction, completeAction, failAction } = useContext(PortalContext);

  // Close panel when forceClose changes (after mutations)
  useEffect(() => { setOpen(false); setFlavorOpen(false); }, [forceClose]);

  const imgSrc = getLineImage(ln);
  const sizedImg = imgSrc ? (imgSrc.includes('?') ? imgSrc + '&width=800' : imgSrc + '?width=800') : '';

  // Find flavor variants for "Change flavor" — same product, in-stock, not current variant
  // Match by both Shopify productId and internal UUID (internalId) since ln.productId may be either
  const catalogProducts = Array.isArray(catalog) ? catalog : [];
  const lnPid = String(ln.productId || '');
  const currentProduct = catalogProducts.find(p =>
    String(p.productId || '') === lnPid || String(p.internalId || '') === lnPid
  );
  const flavorVariants = (currentProduct?.variants || []).filter(v =>
    String(v.id) !== String(ln.variantId) && (v.inventory_quantity == null || v.inventory_quantity > 0)
  );
  const hasFlavorOptions = flavorVariants.length > 0;

  async function handleFlavorChange(variantId, variantTitle) {
    if (flavorBusy) return;
    setFlavorBusy(true);
    setFlavorOpen(false);
    setOpen(false);
    startAction();
    try {
      const payload = {
        contractId: contract.id,
        oldLineId: safeStr(ln.id),
        newVariants: [{ variantId: String(variantId), quantity: ln.quantity || 1 }],
        carryForwardDiscount: 'EXISTING_PLAN',
      };
      const resp = await postJson('replaceVariants', payload);
      completeAction('Flavor changed to ' + (variantTitle || 'new flavor') + '!');
      clearCaches();
      if (resp?.patch?.lines && Array.isArray(resp.patch.lines) && onPatchLines) {
        onPatchLines(resp.patch.lines);
      } else {
        onDone?.();
      }
    } catch (e) {
      failAction(e?.message || 'Could not change flavor.');
    }
    setFlavorBusy(false);
  }

  return (
    <div class="sp-line-group">
      {sizedImg
        ? <img class="sp-line__hero" src={sizedImg} alt={safeStr(ln.title)} />
        : <div class="sp-line__hero sp-line__hero--placeholder" />}
      <div class="sp-line">
        <div class="sp-line__meta">
          <div class="sp-line__title">{safeStr(ln.title) || 'Item'}</div>
          <div class="sp-line__subwrap sp-muted">
            {ln.variantTitle && <div class="sp-line__variant">{safeStr(ln.variantTitle)}</div>}
            <div class="sp-line__qty">Qty {ln.quantity || 1}</div>
          </div>
        </div>
        <div class="sp-line__price">{(() => {
          const msrp = getLineMsrp(ln, catalogProducts);
          const actual = ln.currentPrice ? Number(ln.currentPrice.amount) * (ln.quantity || 1) : 0;
          if (msrp && msrp > actual) {
            return (
              <>
                <span class="sp-line__msrp">{money({ amount: String(msrp.toFixed(2)), currencyCode: ln.currentPrice?.currencyCode || 'USD' })}</span>
                {' '}<span class="sp-line__now">{money({ amount: String(actual.toFixed(2)), currencyCode: ln.currentPrice?.currencyCode || 'USD' })}</span>
              </>
            );
          }
          return ln.currentPrice ? money({ amount: String(actual.toFixed(2)), currencyCode: ln.currentPrice?.currencyCode || 'USD' }) : '';
        })()}</div>
      </div>
      <button type="button" class={'sp-disclosure' + (open ? ' is-open' : '')}
        onClick={() => setOpen(!open)}>
        <span class="sp-disclosure__label">Make changes to this item</span>
        <span class="sp-disclosure__arrow">{open ? '\u25B2' : '\u25BC'}</span>
      </button>
      {open && (
        <div class="sp-disclosure__panel">
          {hasFlavorOptions && (
            <div class="sp-disclosure__action-wrap">
              <button class="sp-disclosure__action" disabled={flavorBusy}
                onClick={() => setFlavorOpen(!flavorOpen)}>
                <div class="sp-disclosure__action-title">Change flavor</div>
                <div class="sp-disclosure__action-sub sp-muted">Switch to another flavor of this product.</div>
              </button>
              {flavorOpen && (
                <div class="sp-flavor-picker">
                  {flavorBusy ? (
                    <div class="sp-flavor-picker__busy">Updating flavor…</div>
                  ) : (
                    flavorVariants.map(v => (
                      <button key={v.id} type="button" class="sp-flavor-picker__option"
                        onClick={() => handleFlavorChange(v.id, v.title)}>
                        {v.title}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          <button class="sp-disclosure__action" onClick={onSwap}>
            <div class="sp-disclosure__action-title">Swap product</div>
            <div class="sp-disclosure__action-sub sp-muted">Replace with a different product.</div>
          </button>
          <button class="sp-disclosure__action" onClick={onQty}>
            <div class="sp-disclosure__action-title">Change quantity</div>
            <div class="sp-disclosure__action-sub sp-muted">Update how many you receive.</div>
          </button>
          {canRemove && (
            <button class="sp-disclosure__action sp-disclosure__action--danger" disabled={removing}
              onClick={onRemove}>
              <div class="sp-disclosure__action-title">{removing ? 'Removing…' : 'Remove'}</div>
              <div class="sp-disclosure__action-sub sp-muted">Remove this item.</div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ItemsCard({ contract, lines, shipLine, onUpdate, onPatchLines, showToast, config, isCancelled, disclosureKey }) {
  const [modal, setModal] = useState(null);
  const [removingLine, setRemovingLine] = useState(null);
  const [mutating, setMutating] = useState(false);

  const total = lines.reduce((sum, ln) => {
    const p = getLinePrice(ln);
    return sum + (isFinite(p) ? p * (ln.quantity || 1) : 0);
  }, 0);

  const totalRealQty = lines.reduce((sum, ln) => sum + (ln.quantity || 1), 0);
  const canRemove = lines.length > 1;

  async function doRemove(ln) {
    setRemovingLine(ln.sku || ln.variantId);
    setMutating(true);
    startAction();
    try {
      const resp = await postJson('removeLineItem', {
        contractId: contract.id,
        lineId: ln.id,
        variantId: ln.variantId,
      });
      completeAction('Item removed.');
      clearCaches();
      if (resp?.patch?.lines && Array.isArray(resp.patch.lines)) {
        onPatchLines(resp.patch.lines);
      } else {
        onUpdate();
      }
    } catch (e) {
      failAction(e?.message || 'Could not remove item.');
    }
    setRemovingLine(null);
    setMutating(false);
  }

  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Items</div>
        <p class="sp-muted sp-detail__section-sub">What's included in your subscription.</p>
      </div>
      <div class="sp-detail__lines">
        {lines.map((ln, i) => (
          isCancelled ? (
            <div key={i} class="sp-line-group">
              {(() => { const src = getLineImage(ln); const sized = src ? (src.includes('?') ? src + '&width=800' : src + '?width=800') : ''; return sized ? <img class="sp-line__hero" src={sized} alt={safeStr(ln.title)} /> : <div class="sp-line__hero sp-line__hero--placeholder" />; })()}
              <div class="sp-line">
                <div class="sp-line__meta">
                  <div class="sp-line__title">{safeStr(ln.title) || 'Item'}</div>
                  <div class="sp-line__subwrap sp-muted">
                    {ln.variantTitle && <div class="sp-line__variant">{safeStr(ln.variantTitle)}</div>}
                    <div class="sp-line__qty">Qty {ln.quantity || 1}</div>
                  </div>
                </div>
                <div class="sp-line__price">{(() => {
                  const catalogProducts = Array.isArray(config?.catalog) ? config.catalog : [];
                  const msrp = getLineMsrp(ln, catalogProducts);
                  const actual = ln.currentPrice ? Number(ln.currentPrice.amount) * (ln.quantity || 1) : 0;
                  if (msrp && msrp > actual) {
                    return (
                      <>
                        <span class="sp-line__msrp">{money({ amount: String(msrp.toFixed(2)), currencyCode: ln.currentPrice?.currencyCode || 'USD' })}</span>
                        {' '}<span class="sp-line__now">{money({ amount: String(actual.toFixed(2)), currencyCode: ln.currentPrice?.currencyCode || 'USD' })}</span>
                      </>
                    );
                  }
                  return ln.currentPrice ? money({ amount: String(actual.toFixed(2)), currencyCode: ln.currentPrice?.currencyCode || 'USD' }) : '';
                })()}</div>
              </div>
            </div>
          ) : (
            <LineItemDisclosure key={i} ln={ln} canRemove={canRemove}
              removing={removingLine === (ln.sku || ln.variantId)}
              forceClose={disclosureKey}
              catalog={config.catalog}
              contract={contract}
              onPatchLines={onPatchLines}
              onDone={onUpdate}
              onSwap={() => setModal({ type: 'addSwap', line: ln, mode: 'swap' })}
              onQty={() => setModal({ type: 'quantity', line: ln })}
              onRemove={() => doRemove(ln)}
            />
          )
        ))}
      </div>
      {isFinite(total) && total > 0 && (() => {
        const catalogProducts = Array.isArray(config?.catalog) ? config.catalog : [];
        const msrpTotal = lines.reduce((sum, ln) => {
          const m = getLineMsrp(ln, catalogProducts);
          return sum + (m || (getLinePrice(ln) * (ln.quantity || 1)));
        }, 0);
        const showMsrp = isFinite(msrpTotal) && msrpTotal > total;
        return (
          <div class="sp-detail__totals" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span class="sp-muted">Subtotal</span>
            <span class="sp-detail__total-price">
              {showMsrp && <span class="sp-subtotal__msrp">{toMoney(msrpTotal)}</span>}
              {toMoney(total)}
            </span>
          </div>
        );
      })()}
      {!isCancelled && (
        <div class="sp-detail__items-actions">
          <button class="sp-btn sp-btn--ghost" disabled={mutating} onClick={() => setModal({ type: 'addSwap', mode: 'add' })}>
            + Add item
          </button>
        </div>
      )}

      {modal?.type === 'addSwap' && (
        <AddSwapModal mode={modal.mode} contract={contract} line={modal.line}
          catalog={config.catalog} totalRealQty={totalRealQty}
          onClose={() => setModal(null)} onDone={onUpdate} onPatchLines={onPatchLines} />
      )}
      {modal?.type === 'quantity' && (
        <QuantityModal contract={contract} line={modal.line}
          onClose={() => setModal(null)} onDone={onUpdate} onPatchLines={onPatchLines} />
      )}
    </div>
  );
}

const US_STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
  ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['FL','Florida'],['GA','Georgia'],
  ['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],
  ['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],
  ['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],
  ['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],
  ['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],
  ['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],
  ['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],
  ['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
  ['DC','District of Columbia'],['PR','Puerto Rico'],['VI','Virgin Islands'],['GU','Guam'],
  ['AS','American Samoa'],['MP','Northern Mariana Islands'],
];

function PaymentMethodCard({ contract }) {
  const pm = contract?.paymentMethod;
  const manageUrl = contract?.paymentManageUrl;

  if (!pm && !manageUrl) return null;

  const brandIcon = {
    Visa: '💳', Mastercard: '💳', 'American Express': '💳', Discover: '💳',
  };

  return (
    <div class="sp-card" style={{ marginTop: 16 }}>
      <div class="sp-card__header">
        <h3 class="sp-card__title">Payment Method</h3>
      </div>
      <div class="sp-card__body">
        {pm ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 20 }}>{brandIcon[pm.brand] || '💳'}</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {pm.brand || 'Card'} ending in {pm.last4 || '****'}
              </div>
              {pm.expiry && (
                <div style={{ fontSize: 12, color: '#6b7280' }}>Expires {pm.expiry}</div>
              )}
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 12 }}>No payment method on file.</p>
        )}
        {manageUrl && (
          <a
            href={manageUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="sp-btn sp-btn--secondary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
          >
            Manage Payment Methods
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
        )}
      </div>
    </div>
  );
}

function AddressCard({ contract, startAction, completeAction, failAction, onUpdate }) {
  const addr = contract?.deliveryMethod?.address || {};
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    firstName: addr.firstName || '', lastName: addr.lastName || '',
    address1: addr.address1 || '', address2: addr.address2 || '',
    city: addr.city || '', province: addr.province || addr.provinceCode || '', zip: addr.zip || '',
  });
  const [busy, setBusy] = useState(false);
  const [verification, setVerification] = useState(null); // { entered, suggested, errors }

  async function save(skipVerification) {
    setBusy(true);
    setVerification(null);
    startAction();
    try {
      const resp = await postJson('address', { contractId: contract.id, ...form, skipVerification: !!skipVerification });
      if (resp?.verification && !resp.verification.valid) {
        // Show verification result — let customer choose
        setVerification(resp.verification);
        setBusy(false);
        return;
      }
      completeAction('Address updated!');
      clearCaches(); setEditing(false); onUpdate();
    } catch { failAction('Could not update address.'); }
    setBusy(false);
  }

  function useSuggested() {
    if (!verification?.suggested) return;
    const s = verification.suggested;
    setForm(prev => ({
      ...prev,
      address1: s.address1 || prev.address1,
      address2: s.address2 || '',
      city: s.city || prev.city,
      province: s.province || prev.province,
      zip: s.zip || prev.zip,
    }));
    setVerification(null);
    // Re-save with the suggested address (skip verification since it came from EasyPost)
    setTimeout(() => save(true), 100);
  }

  function useEntered() {
    setVerification(null);
    save(true);
  }

  const display = [addr.address1, addr.address2, [addr.city, addr.province || addr.provinceCode, addr.zip].filter(Boolean).join(', ')].filter(Boolean).join('\n');

  const textFields = ['firstName', 'lastName', 'address1', 'address2', 'city', 'zip'];
  const fieldLabels = { firstName: 'First name', lastName: 'Last name', address1: 'Address', address2: 'Apt / Suite', city: 'City', zip: 'ZIP code' };

  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead"><div class="sp-title2">Shipping address</div></div>
      <p class="sp-muted" style={{ whiteSpace: 'pre-line', marginBottom: '12px' }}>{display || 'No address on file'}</p>
      <button class="sp-btn sp-btn--ghost" onClick={() => { setVerification(null); setEditing(true); }}>Change address</button>
      {editing && (
        <Modal title="Change shipping address" onClose={() => { setEditing(false); setVerification(null); }} footer={
          verification ? null : (
            <><button class="sp-btn sp-btn-primary" disabled={busy} onClick={() => save(false)}>{busy ? 'Verifying…' : 'Save'}</button>
            <button class="sp-btn sp-btn--ghost" onClick={() => { setEditing(false); setVerification(null); }}>Cancel</button></>
          )
        }>
          {verification ? (
            <div class="sp-address-verify">
              {verification.errors?.length > 0 && (
                <div class="sp-address-verify__errors">
                  {verification.errors.map((e, i) => <div key={i} class="sp-muted">{e}</div>)}
                </div>
              )}
              {verification.suggested && (
                <>
                  <div class="sp-address-verify__label">Suggested address</div>
                  <button type="button" class="sp-address-verify__option sp-address-verify__option--suggested" onClick={useSuggested}>
                    <div>{verification.suggested.address1}</div>
                    {verification.suggested.address2 && <div>{verification.suggested.address2}</div>}
                    <div>{verification.suggested.city}, {verification.suggested.province} {verification.suggested.zip}</div>
                    <span class="sp-address-verify__badge">Use this address</span>
                  </button>
                  <div class="sp-address-verify__label">You entered</div>
                  <button type="button" class="sp-address-verify__option" onClick={useEntered}>
                    <div>{verification.entered.address1}</div>
                    {verification.entered.address2 && <div>{verification.entered.address2}</div>}
                    <div>{verification.entered.city}, {verification.entered.province} {verification.entered.zip}</div>
                    <span class="sp-address-verify__badge sp-address-verify__badge--muted">Use as entered</span>
                  </button>
                </>
              )}
              {!verification.suggested && (
                <div class="sp-address-verify__actions">
                  <button class="sp-btn sp-btn--ghost" onClick={() => setVerification(null)}>Edit address</button>
                  <button class="sp-btn sp-btn-primary" onClick={useEntered}>Save anyway</button>
                </div>
              )}
            </div>
          ) : (
            <>
              {textFields.map(k => (
                <div key={k} class="sp-field">
                  <label class="sp-field__label">{fieldLabels[k]}</label>
                  <input class="sp-input" value={form[k]} onInput={(e) => setForm(prev => ({ ...prev, [k]: e.target.value }))} />
                </div>
              ))}
              <div class="sp-field">
                <label class="sp-field__label">State</label>
                <select class="sp-select" value={form.province} onChange={(e) => setForm(prev => ({ ...prev, province: e.target.value }))}>
                  <option value="">Select state</option>
                  {US_STATES.map(([code, name]) => (
                    <option key={code} value={code}>{name}</option>
                  ))}
                </select>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function CouponCard({ contract, startAction, completeAction, failAction, onUpdate, onCouponStateChange }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [loyalty, setLoyalty] = useState(null);
  const [loyaltyBusy, setLoyaltyBusy] = useState(null);
  const [localApplied, setLocalApplied] = useState(null); // { id, code, value, type } for optimistic display

  // Build full list of all discounts (MANUAL + CODE_DISCOUNT)
  const allDiscounts = localApplied
    ? [localApplied, ...(contract?.appliedDiscounts || []).filter(d => d.id !== localApplied.id)]
    : (contract?.appliedDiscounts || []);
  const hasManualDiscount = allDiscounts.some(d => d.type === 'MANUAL' || d.type === 'AUTOMATIC_DISCOUNT');
  const hasCodeCoupon = allDiscounts.some(d => d.type === 'CODE_DISCOUNT' || d.type === 'code');
  const hasAnyCoupon = hasCodeCoupon || allDiscounts.length > 0;

  // Backward compat: single coupon values for loyalty check
  const appliedCoupon = localApplied || contract?.appliedDiscount || contract?.discount || null;
  const couponCode = localApplied ? localApplied.code : (appliedCoupon?.code || appliedCoupon?.title || '');
  const isLoyaltyCoupon = couponCode.startsWith('LOYALTY-');

  // Load loyalty data when no coupon is applied
  useEffect(() => {
    if (couponCode) return;
    requestJson('loyaltyBalance', {}, { force: true })
      .then(resp => { if (resp?.ok && resp?.enabled) setLoyalty(resp); })
      .catch(err => console.error('[SubscriptionDetail] loyalty balance error:', err?.status, err?.details || err?.message));
  }, [couponCode]);

  async function apply() {
    if (!code.trim()) return;
    setBusy(true);
    startAction();
    try {
      await postJson('coupon', { contractId: contract.id, discountCode: code.trim(), mode: 'apply' });
      completeAction('Coupon applied!');
      setCode(''); clearCaches(); onUpdate();
    } catch { failAction('Could not apply coupon.'); }
    setBusy(false);
  }

  async function removeDiscount(discount) {
    setBusy(true);
    startAction();
    try {
      await postJson('coupon', { contractId: contract.id, discountId: discount.id, mode: 'remove' });
      completeAction('Discount removed.');
      setLocalApplied(null);
      if (onCouponStateChange) onCouponStateChange(false);
      requestJson('loyaltyBalance', {}, { force: true })
        .then(resp => { if (resp?.ok && resp?.enabled) setLoyalty(resp); })
        .catch(err => console.error('[SubscriptionDetail] loyalty refresh error:', err?.message));
      clearCaches(); onUpdate();
    } catch { failAction('Could not remove discount.'); }
    setBusy(false);
  }

  async function applyLoyaltyCoupon(redemptionId) {
    setLoyaltyBusy(redemptionId);
    startAction();
    try {
      const resp = await postJson('loyaltyApplyToSubscription', { contractId: contract.id, redemptionId });
      if (resp?.ok) {
        completeAction(`$${resp.discount_value} loyalty coupon applied!`);
        setLocalApplied({ code: resp.code, value: resp.discount_value, valueType: 'FIXED_AMOUNT' });
        if (onCouponStateChange) onCouponStateChange(true);
        clearCaches(); onUpdate();
      } else {
        failAction(resp?.error || 'Could not apply.');
      }
    } catch (e) { failAction(e?.message || 'Failed.'); }
    setLoyaltyBusy(null);
  }

  async function redeemAndApply(tierIndex) {
    setLoyaltyBusy('tier-' + tierIndex);
    startAction();
    try {
      const resp = await postJson('loyaltyApplyToSubscription', { contractId: contract.id, tierId: tierIndex });
      if (resp?.ok) {
        completeAction(`$${resp.discount_value} loyalty coupon redeemed and applied!`);
        setLocalApplied({ code: resp.code, value: resp.discount_value, valueType: 'FIXED_AMOUNT' });
        if (onCouponStateChange) onCouponStateChange(true);
        clearCaches(); onUpdate();
      } else {
        failAction(resp?.error || 'Could not redeem.');
      }
    } catch (e) { failAction(e?.message || 'Failed.'); }
    setLoyaltyBusy(null);
  }

  const activeCoupons = loyalty?.unused_coupons?.filter(c => c.status === 'active') || [];
  const affordableTiers = loyalty?.tiers?.filter(t => t.affordable) || [];
  const showLoyalty = !hasCodeCoupon && !isLoyaltyCoupon && loyalty && (activeCoupons.length > 0 || affordableTiers.length > 0);

  function formatDiscountValue(d) {
    if (!d?.value) return '';
    return d.valueType === 'PERCENTAGE' || d.type === 'percentage'
      ? d.value + '% off'
      : '$' + Number(d.value).toFixed(2) + ' off';
  }

  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead"><div class="sp-title2">Coupon</div></div>
      {/* Show all applied discounts */}
      {allDiscounts.length > 0 && allDiscounts.map((d, i) => (
        <div key={d.id || i} class="sp-detail__coupon-applied" style={i > 0 ? { marginTop: '8px' } : undefined}>
          <div class="sp-detail__coupon-info">
            <span class="sp-detail__coupon-code" title={d.code || d.title}>{d.code || d.title}</span>
            {d.type === 'MANUAL' && <span class="sp-badge sp-badge--muted" style={{ marginLeft: '6px', fontSize: '11px' }}>Auto discount</span>}
            {formatDiscountValue(d) && <span class="sp-detail__coupon-value">{formatDiscountValue(d)}</span>}
          </div>
          <button class="sp-btn sp-btn--ghost sp-btn--sm" disabled={busy} onClick={() => removeDiscount(d)}>Remove</button>
        </div>
      ))}
      {/* Coupon input: hidden when any coupon is applied, blocked when manual discount exists */}
      {hasCodeCoupon ? null : hasManualDiscount ? (
        <div class="sp-muted" style={{ marginTop: allDiscounts.length > 0 ? '12px' : '0', fontSize: '13px' }}>
          Remove your existing discount to apply a coupon code
        </div>
      ) : (
        <>
          <div class="sp-detail__coupon-row">
            <input class="sp-input" placeholder="Discount code" value={code}
              onInput={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') apply(); }} />
            <button class="sp-btn sp-btn-primary" disabled={busy || !code.trim()} onClick={apply}>Apply</button>
          </div>
          {showLoyalty && (
            <div class="sp-loyalty__quick">
              <div class="sp-loyalty__quick-title sp-muted">Use reward points</div>
              {activeCoupons.map(c => (
                <button key={c.id} type="button" class="sp-loyalty__quick-btn sp-loyalty__quick-btn--premium"
                  disabled={loyaltyBusy != null}
                  onClick={() => applyLoyaltyCoupon(c.id)}>
                  {loyaltyBusy === c.id ? 'Applying…' : `Apply $${Number(c.discount_value).toFixed(0)} coupon \u2014 ${c.code}`}
                </button>
              ))}
              {activeCoupons.length === 0 && affordableTiers.map(t => (
                <button key={t.index} type="button" class="sp-loyalty__quick-btn sp-loyalty__quick-btn--premium"
                  disabled={loyaltyBusy != null}
                  onClick={() => redeemAndApply(t.index)}>
                  {loyaltyBusy === 'tier-' + t.index
                    ? 'Redeeming…'
                    : `Redeem ${t.label} & apply \u2014 ${t.points_cost.toLocaleString()} pts`}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FrequencyCard({ contract, showToast, onUpdate, startAction, completeAction, failAction }) {
  const label = billingLabel(contract?.billingPolicy) || 'Not set';
  const [modal, setModal] = useState(false);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  const options = [
    { label: 'Twice a Month', interval: 'WEEK', count: 2 },
    { label: 'Monthly', interval: 'WEEK', count: 4 },
    { label: 'Every 2 Months', interval: 'WEEK', count: 8 },
  ];

  // Determine which option matches the current billing policy
  const currentInterval = (contract?.billingPolicy?.interval || '').toUpperCase();
  const currentCount = Number(contract?.billingPolicy?.intervalCount) || 0;
  function isCurrent(o) {
    return o.interval === currentInterval && o.count === currentCount;
  }

  async function save() {
    const opt = options.find(o => o.label === selected);
    if (!opt) return;
    setBusy(true);
    setModal(false);
    startAction();
    try {
      await postJson('frequency', { contractId: contract.id, intervalCount: opt.count, interval: opt.interval });
      completeAction('Delivery frequency changed to ' + opt.label);
      clearCaches(); onUpdate();
    } catch { failAction('Could not update frequency.'); }
    setBusy(false);
  }

  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Delivery frequency</div>
        <p class="sp-muted">{label}</p>
      </div>
      <button class="sp-btn sp-btn--ghost" onClick={() => setModal(true)}>Change frequency</button>
      {modal && (
        <Modal title="Change delivery frequency" onClose={() => setModal(false)} footer={
          <><button class="sp-btn sp-btn-primary" disabled={busy || !selected} onClick={save}>Save</button>
          <button class="sp-btn sp-btn--ghost" onClick={() => setModal(false)}>Cancel</button></>
        }>
          <div class="sp-radio-list">
            {options.map(o => {
              const current = isCurrent(o);
              return (
                <label key={o.label} class={'sp-radio-row' + (selected === o.label ? ' is-selected' : '') + (current ? ' is-disabled' : '')}>
                  <input type="radio" name="freq" value={o.label} checked={selected === o.label}
                    disabled={current} onChange={() => setSelected(o.label)} />
                  <span>{o.label}</span>
                  {current && <span class="sp-badge sp-badge--muted" style={{ marginLeft: '8px', fontSize: '11px' }}>Current</span>}
                </label>
              );
            })}
          </div>
        </Modal>
      )}
    </div>
  );
}

function CancelCard({ router, contractId }) {
  const cancelUrl = router.base + '/subscription?id=' + encodeURIComponent(contractId) + '&intent=cancel';
  return (
    <div class="sp-card sp-detail__card sp-detail__cancel">
      <div class="sp-detail__cancel-row">
        <div>
          <div class="sp-detail__cancel-title">Cancel subscription</div>
          <div class="sp-muted sp-detail__cancel-sub">We'll ask a couple quick questions first.</div>
        </div>
        <a class="sp-btn sp-btn--ghost sp-btn--danger sp-btn--sm" href={cancelUrl}
          onClick={(e) => { e.preventDefault(); router.navigate(cancelUrl); }}>
          Cancel
        </a>
      </div>
    </div>
  );
}

// ---- Main screen ----

export default function SubscriptionDetail() {
  const { config, router, showToast, startAction, completeAction, failAction } = useContext(PortalContext);
  const contractId = new URLSearchParams(window.location.search).get('id') || '';

  const [contract, setContract] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Increment to force-close all disclosure panels after mutations
  const [disclosureKey, setDisclosureKey] = useState(0);

  // Success banner state (set by cancel flow remedy acceptance)
  const [savedBanner, setSavedBanner] = useState(null);
  const [bannerHiding, setBannerHiding] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('saved') === '1') {
      const action = params.get('action') || 'updated your subscription';
      setSavedBanner(action);
      fireConfetti();
      // Clean URL params
      params.delete('saved');
      params.delete('action');
      const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
      window.history.replaceState(null, '', cleanUrl);
      // Auto-dismiss after 8 seconds
      const timer = setTimeout(() => dismissBanner(), 8000);
      return () => clearTimeout(timer);
    }
  }, []);

  function dismissBanner() {
    setBannerHiding(true);
    setTimeout(() => { setSavedBanner(null); setBannerHiding(false); }, 300);
  }

  const fetchContract = useCallback(async () => {
    // Use cached data as instant preview, but always fetch full detail
    const cached = getCachedContractById(contractId);
    if (cached) { setContract(normalizeContract(cached)); setLoading(false); }
    try {
      const resp = await requestJson('subscriptionDetail', { id: contractId }, { force: true });
      if (resp?.ok) {
        setContract(normalizeContract(resp.contract || resp.data || resp.subscription));
      } else if (!cached) { setError(true); }
    } catch { if (!cached) setError(true); }
    setLoading(false);
  }, [contractId]);

  // After any mutation: collapse disclosures + re-fetch
  const handleUpdate = useCallback((optimistic) => {
    setDisclosureKey(k => k + 1);
    if (optimistic && typeof optimistic === 'object') {
      // Apply optimistic state change immediately, then background re-fetch
      setContract(prev => prev ? normalizeContract({ ...prev, ...optimistic }) : prev);
      setTimeout(() => fetchContract(), 3000);
    } else {
      fetchContract();
    }
  }, [fetchContract]);

  // Optimistic lines update from replaceVariants patch
  const patchLines = useCallback((newLines) => {
    setDisclosureKey(k => k + 1);
    setContract(prev => prev ? normalizeContract({ ...prev, lines: newLines }) : prev);
  }, []);

  useEffect(() => { fetchContract(); }, [fetchContract]);

  if (!contractId) { router.navigate(router.base + '/subscriptions'); return null; }

  if (loading) {
    return (
      <div class="sp-wrap sp-detail">
        <SkeletonCard />
        <div class="sp-grid sp-detail__grid">
          <div class="sp-detail__col"><SkeletonCard /><SkeletonCard /></div>
          <div class="sp-detail__col"><SkeletonCard /><SkeletonCard /></div>
        </div>
      </div>
    );
  }

  if (error || !contract) {
    router.navigate(router.base + '/subscriptions');
    return null;
  }

  const b = getBucket(contract);
  const isCancelled = b === 'cancelled';
  const isLocked = !!contract?.portalState?.isLocked;
  const isReadOnly = isCancelled || isLocked;
  const { lines, shipLine } = splitLines(contract);
  const appliedDiscount = contract?.appliedDiscount || contract?.discount || null;
  const appliedCouponCode = appliedDiscount?.code || appliedDiscount?.title || '';
  const hasLoyaltyCouponApplied = appliedCouponCode.startsWith('LOYALTY-');
  const hasCouponApplied = !!appliedCouponCode;
  const [couponAppliedLocal, setCouponAppliedLocal] = useState(hasCouponApplied);

  const statusText = b === 'cancelled' ? 'Cancelled' : b === 'paused' ? 'Paused' : 'Active';
  const statusKind = b === 'cancelled' ? 'cancelled' : b === 'paused' ? 'paused' : 'active';

  let subtitle = '';
  if (b === 'paused') {
    const resumeAt = contract.pause_resume_at ? fmtDate(contract.pause_resume_at) : '';
    const until = resumeAt || (contract.nextBillingDate ? fmtDate(contract.nextBillingDate) : '');
    subtitle = until ? 'Paused until ' + until : 'This subscription is paused.';
  } else if (!isCancelled && contract.nextBillingDate) {
    subtitle = 'Your next order is on ' + fmtDate(contract.nextBillingDate);
  }

  const recoveryStatus = contract?.portalState?.recoveryStatus;
  const dunning = (recoveryStatus === 'in_recovery' || recoveryStatus === 'failed') ? {
    in_recovery: recoveryStatus === 'in_recovery',
    recovery_failed: recoveryStatus === 'failed',
    payment_update_url: contract?.portalState?.paymentUpdateUrl || '',
  } : null;

  // Resolve line product IDs to Shopify product IDs for review lookups
  // ln.productId may be an internal UUID; catalog has both internalId and productId (Shopify)
  const catalogProducts = Array.isArray(config?.catalog) ? config.catalog : [];
  const productIds = lines.map(ln => {
    const lnPid = String(ln?.productId || '');
    if (!lnPid) return '';
    // Find matching catalog entry by either ID format
    const match = catalogProducts.find(p =>
      String(p.productId || '') === lnPid || String(p.internalId || '') === lnPid
    );
    // Return the Shopify product ID for the reviews API
    return shortId(match?.productId || lnPid);
  }).filter(Boolean);

  return (
    <div class="sp-wrap sp-detail">
      <div class="sp-card sp-detail__header">
        <div class="sp-detail__header-top">
          <div class="sp-detail__titlewrap">
            <h2 class="sp-title sp-detail__title">Subscription details</h2>
            <p class="sp-muted sp-detail__subtitle">{subtitle}</p>
          </div>
          <Pill kind={statusKind}>{statusText}</Pill>
        </div>
        {contract.crisisBanner && (
          <div class="sp-alert sp-alert--crisis" style={{ marginTop: '10px' }}>
            <div class="sp-alert__body">{contract.crisisBanner.message}</div>
          </div>
        )}
      </div>

      {savedBanner && (
        <div class={'sp-success-banner' + (bannerHiding ? ' sp-success-banner--hiding' : '')}>
          <div class="sp-success-banner__title">Congratulations!</div>
          <div class="sp-success-banner__text">
            You just {savedBanner} and you're still on track with your health goals!
          </div>
          <button type="button" class="sp-success-banner__close" onClick={dismissBanner}>{'\u2715'}</button>
        </div>
      )}

      {dunning && <DunningBanner dunning={dunning} />}

      {isLocked && (
        <div class="sp-alert">
          <div class="sp-alert__title">Heads up</div>
          <div class="sp-alert__body sp-muted">Your subscription is being set up. Once you receive your first order, you can make edits here.</div>
        </div>
      )}

      <div class="sp-grid sp-detail__grid">
        <div class="sp-detail__col">
          {isCancelled && <ReactivateCard contract={contract} showToast={showToast} onUpdate={handleUpdate} startAction={startAction} completeAction={completeAction} failAction={failAction} />}
          {b === 'paused' && !isReadOnly && <ResumeCard contract={contract} onUpdate={handleUpdate} showToast={showToast} startAction={startAction} completeAction={completeAction} failAction={failAction} />}
          <ItemsCard contract={contract} lines={lines} shipLine={shipLine}
            onUpdate={handleUpdate} onPatchLines={patchLines} showToast={showToast}
            config={config} isCancelled={isCancelled} disclosureKey={disclosureKey} />
          {b === 'active' && !isReadOnly && <OrderActionsCard contract={contract} showToast={showToast} onUpdate={handleUpdate} startAction={startAction} completeAction={completeAction} failAction={failAction} />}
          {!isReadOnly && <FrequencyCard contract={contract} showToast={showToast} onUpdate={handleUpdate} startAction={startAction} completeAction={completeAction} failAction={failAction} />}
          {b === 'active' && !isReadOnly && <PauseCard contract={contract} onUpdate={handleUpdate} showToast={showToast} startAction={startAction} completeAction={completeAction} failAction={failAction} />}
        </div>
        <div class="sp-detail__col">
          {!isCancelled && <RewardsCard contractId={shortId(contract.id)} hideRedeem={!couponAppliedLocal} showRedeemOverride={couponAppliedLocal} />}
          {!isReadOnly && <CouponCard contract={contract} startAction={startAction} completeAction={completeAction} failAction={failAction} onUpdate={handleUpdate} onCouponStateChange={(v) => setCouponAppliedLocal(v)} />}
          <PaymentMethodCard contract={contract} />
          {!isReadOnly && <AddressCard contract={contract} startAction={startAction} completeAction={completeAction} failAction={failAction} onUpdate={handleUpdate} />}
          {!isReadOnly && <ShippingProtectionCard contract={contract} shipLine={shipLine} onUpdate={handleUpdate} />}
          {!isCancelled && productIds.length > 0 && <ReviewsCard productIds={productIds} />}
          {!isReadOnly && <CancelCard router={router} contractId={shortId(contract.id)} />}
        </div>
      </div>
    </div>
  );
}
