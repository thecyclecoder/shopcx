// modals/AddSwapModal.jsx — Two-step add/swap product modal
// Step 1: Select product from catalog
// Step 2: Select variant flavor + quantity, see pricing
import { useState, useContext } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { postJson, clearCaches } from '../core/api.js';
import { safeStr, shortId } from '../core/utils.js';
import Modal from '../components/Modal.jsx';

function pickImage(obj) {
  return obj?.image?.src || obj?.featuredImage?.src || obj?.image || '';
}

function variantImage(v) {
  return v?.image?.src || '';
}

function cents(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  // If looks like dollars (has decimal or small), convert
  if (String(v).includes('.') || n < 1000) return Math.round(n * 100);
  return Math.trunc(n);
}

function fmtCents(c) {
  if (c == null || !isFinite(c)) return '';
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return sign + '$' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

// Tier pricing: 25% S&S base + tier discount based on total real items
function computePrice(variant, qty, totalRealQty) {
  const msrpCents = cents(variant?.compare_at_price_cents || variant?.compare_at_price) ||
                    cents(variant?.price_cents || variant?.price);
  const baseCents = cents(variant?.price_cents || variant?.price);
  if (!msrpCents) return { msrp: null, price: null, note: '' };

  const ssDsc = 0.25; // 25% subscribe & save
  let tierDsc = 0;
  const total = (totalRealQty || 0) + qty;
  if (total >= 4) tierDsc = 0.16;
  else if (total >= 3) tierDsc = 0.12;
  else if (total >= 2) tierDsc = 0.08;

  const unitAfter = (baseCents || msrpCents) * (1 - ssDsc) * (1 - tierDsc);
  return {
    msrp: msrpCents * qty,
    price: Math.round(unitAfter * qty),
    note: tierDsc > 0
      ? `Includes 25% S&S + ${Math.round(tierDsc * 100)}% tier discount.`
      : 'Includes 25% subscribe & save.',
  };
}

function Stars({ value, count }) {
  const v = Number(value) || 0;
  const full = Math.floor(v);
  const stars = Array.from({ length: 5 }, (_, i) => i < full ? '\u2605' : '\u2606');
  return (
    <span class="sp-addswap-rating">
      <span class="sp-addswap-rating__stars">{stars.join('')}</span>
      {v > 0 && <span class="sp-addswap-rating__val">{v.toFixed(1)}</span>}
      {count && <span class="sp-addswap-rating__count">({count})</span>}
    </span>
  );
}

export default function AddSwapModal({ mode, contract, line, catalog, onClose, onDone, totalRealQty }) {
  const { showToast } = useContext(PortalContext);
  const [step, setStep] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);

  const isSwap = mode === 'swap';
  const products = Array.isArray(catalog) ? catalog : [];

  async function handleSubmit() {
    if (!selectedVariant || busy) return;
    setBusy(true);
    try {
      const payload = {
        contractId: contract.id,
        newVariants: [{ variantId: String(selectedVariant.id), quantity: qty }],
      };
      if (isSwap && line) {
        payload.oldLineId = safeStr(line.id);
      }
      await postJson('replaceVariants', payload);
      showToast(isSwap ? 'Item swapped!' : 'Item added!', 'success');
      clearCaches();
      onDone?.();
      onClose();
    } catch (e) {
      showToast(e?.message || 'Something went wrong.', 'error');
      setBusy(false);
    }
  }

  // Step 1: product selection
  if (step === 1) {
    return (
      <Modal title={isSwap ? 'Swap item' : 'Add item'} onClose={onClose}>
        <div class="sp-note sp-addswap-note">
          <div class="sp-note__title">Step 1: Choose a product</div>
          <div class="sp-note__body">Select a product, then pick your flavor.</div>
        </div>
        <div class="sp-addswap-products">
          {products.map(p => {
            const img = pickImage(p);
            const rating = p.rating || {};
            return (
              <button key={p.productId || p.id} type="button" class="sp-addswap-product"
                onClick={() => { setSelectedProduct(p); setStep(2); setSelectedVariant(p.variants?.[0] || null); }}>
                {img ? <img class="sp-addswap-product__img" src={img} alt={p.title} /> : <div class="sp-addswap-product__img sp-addswap-product__img--placeholder" />}
                <div class="sp-addswap-product__text">
                  <div class="sp-addswap-product__title">{p.title}</div>
                  {p.metafields?.direct_response_headline && <div class="sp-addswap-product__headline sp-muted">{p.metafields.direct_response_headline}</div>}
                  <Stars value={rating.value} count={rating.count} />
                </div>
              </button>
            );
          })}
        </div>
      </Modal>
    );
  }

  // Step 2: variant + quantity
  const variants = selectedProduct?.variants || [];
  const pricing = selectedVariant ? computePrice(selectedVariant, qty, totalRealQty || 0) : {};
  const varImg = variantImage(selectedVariant) || pickImage(selectedProduct);

  return (
    <Modal title={isSwap ? 'Swap item' : 'Add item'} onClose={onClose} footer={
      <><button class="sp-btn sp-btn-primary" disabled={busy || !selectedVariant} onClick={handleSubmit}>
        {busy ? 'Saving\u2026' : (isSwap ? 'Swap' : 'Add to subscription')}
      </button>
      <button class="sp-btn sp-btn--ghost" onClick={() => setStep(1)}>Back</button></>
    }>
      <div class="sp-note sp-addswap-note">
        <div class="sp-note__title">Step 2: Choose flavor & quantity</div>
        <div class="sp-note__body">Pick your preferred option below.</div>
      </div>

      <div class="sp-addswap-selected">
        {varImg ? <img class="sp-addswap-selected__img" src={varImg} alt={selectedProduct?.title} /> : <div class="sp-addswap-selected__img sp-addswap-selected__img--placeholder" />}
        <div class="sp-addswap-selected__text">
          <div class="sp-addswap-selected__title">{selectedProduct?.title}</div>
          {selectedVariant?.title && <div class="sp-addswap-selected__headline sp-muted">{selectedVariant.title}</div>}
        </div>
      </div>

      {variants.length > 1 && (
        <div class="sp-addswap-variants">
          <div class="sp-addswap-variants__label">Flavor</div>
          <div class="sp-addswap-variants__list">
            {variants.map(v => (
              <button key={v.id} type="button"
                class={'sp-addswap-variant' + (selectedVariant?.id === v.id ? ' is-selected' : '')}
                onClick={() => setSelectedVariant(v)}>
                {v.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div class="sp-addswap-qty">
        <div class="sp-addswap-qty__label">Quantity</div>
        <select class="sp-select" value={qty} onChange={(e) => setQty(Number(e.target.value) || 1)}>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </div>

      {(pricing.msrp != null || pricing.price != null) && (
        <div class="sp-addswap-price">
          <div class="sp-addswap-price__label sp-muted">Price</div>
          <div class="sp-addswap-price__vals">
            {pricing.msrp != null && <div class="sp-addswap-price__msrp">{fmtCents(pricing.msrp)}</div>}
            {pricing.price != null && <div class="sp-addswap-price__now">{fmtCents(pricing.price)}</div>}
          </div>
          {pricing.note && <div class="sp-addswap-price__note sp-muted">{pricing.note}</div>}
        </div>
      )}
    </Modal>
  );
}
