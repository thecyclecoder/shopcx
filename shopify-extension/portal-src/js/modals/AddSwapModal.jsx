// modals/AddSwapModal.jsx — Two-step add/swap product modal
// Step 1: Select product from catalog
// Step 2: Select variant flavor + quantity, see pricing
import { useState, useContext } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { postJson, clearCaches } from '../core/api.js';
import { safeStr, shortId } from '../core/utils.js';
import Modal from '../components/Modal.jsx';

function pickImage(obj) {
  const src = obj?.image?.src || obj?.featuredImage?.src || obj?.image || '';
  if (!src) return '';
  // Use Shopify _300x300 size transform for smaller images
  return src.includes('?') ? src + '&width=300' : src + '?width=300';
}

function variantImage(v) {
  const src = v?.image?.src || '';
  if (!src) return '';
  return src.includes('?') ? src + '&width=300' : src + '?width=300';
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

// Simple pricing: MSRP × 0.75 (25% subscribe & save discount)
function computePrice(variant, qty) {
  const msrpCents = cents(variant?.compare_at_price_cents || variant?.compare_at_price) ||
                    cents(variant?.price_cents || variant?.price);
  if (!msrpCents) return { msrp: null, price: null };

  const unitAfter = msrpCents * 0.75;
  return {
    msrp: msrpCents * qty,
    price: Math.round(unitAfter * qty),
  };
}

function Stars({ value, count }) {
  const v = Number(value) || 0;
  if (v === 0 && !count) return null;
  const full = Math.floor(v);
  const half = v - full >= 0.25;
  return (
    <span class="sp-addswap-stars">
      <span class="sp-addswap-stars__glyphs">
        {Array.from({ length: 5 }, (_, i) => {
          const filled = i < full || (i === full && half);
          return <span key={i} style={{ opacity: filled ? 1 : 0.25 }}>{'\u2605'}</span>;
        })}
      </span>
      {v > 0 && <span class="sp-addswap-stars__text">{v.toFixed(2)}</span>}
      {count > 0 && <span class="sp-addswap-stars__text">({count})</span>}
    </span>
  );
}

export default function AddSwapModal({ mode, contract, line, catalog, onClose, onDone, onPatchLines, totalRealQty }) {
  const { showToast, startAction, completeAction, failAction } = useContext(PortalContext);
  const [step, setStep] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);

  const isSwap = mode === 'swap';
  const allProducts = Array.isArray(catalog) ? catalog : [];
  // When swapping, exclude the current product (customer should use "Change flavor" for same-product swaps)
  // Also exclude products with no in-stock variants
  const products = allProducts
    .filter(p => !(isSwap && line && String(p.productId || p.id) === String(line.productId)))
    .filter(p => (p.variants || []).some(v => v.inventory_quantity == null || v.inventory_quantity > 0));

  async function handleSubmit() {
    if (!selectedVariant || busy) return;
    setBusy(true);
    onClose();
    startAction();
    try {
      const payload = {
        contractId: contract.id,
        newVariants: [{ variantId: String(selectedVariant.id), quantity: qty }],
      };
      if (isSwap && line) {
        payload.oldLineId = safeStr(line.id);
      }
      const resp = await postJson('replaceVariants', payload);
      completeAction(isSwap ? 'Item swapped!' : 'Item added!');
      clearCaches();
      if (resp?.patch?.lines && Array.isArray(resp.patch.lines) && onPatchLines) {
        onPatchLines(resp.patch.lines);
      } else {
        onDone?.();
      }
    } catch (e) {
      failAction(e?.message || 'Something went wrong.');
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
        <div class="sp-addswap-list">
          {products.map(p => {
            const img = pickImage(p);
            const rating = p.rating || {};
            return (
              <button key={p.productId || p.id} type="button" class="sp-addswap-rowbtn"
                onClick={() => { setSelectedProduct(p); setStep(2); setSelectedVariant(p.variants?.[0] || null); }}>
                <div class="sp-addswap-rowbtn__inner sp-addswap-prodrow">
                  {img ? <img class="sp-addswap-prodrow__img" src={img} alt={p.title} /> : <div class="sp-addswap-prodrow__img sp-addswap-prodrow__img--placeholder" />}
                  <div class="sp-addswap-prodrow__text">
                    <div class="sp-addswap-prodrow__title">{p.title}</div>
                    {p.metafields?.direct_response_headline && <div class="sp-addswap-prodrow__headline sp-muted">{p.metafields.direct_response_headline}</div>}
                    <Stars value={rating.value} count={rating.count} />
                  </div>
                </div>
                <span class="sp-addswap-selectbtn">Select product</span>
              </button>
            );
          })}
        </div>
      </Modal>
    );
  }

  // Step 2: variant + quantity (only in-stock variants)
  const variants = (selectedProduct?.variants || []).filter(v => v.inventory_quantity == null || v.inventory_quantity > 0);
  const pricing = selectedVariant ? computePrice(selectedVariant, qty) : {};
  const varImg = variantImage(selectedVariant) || pickImage(selectedProduct);

  return (
    <Modal title={isSwap ? 'Swap item' : 'Add item'} onClose={onClose} footer={
      <><button class="sp-btn sp-btn-primary" disabled={busy || !selectedVariant} onClick={handleSubmit}>
        {busy ? 'Saving…' : (isSwap ? 'Swap' : 'Add to subscription')}
      </button>
      <button class="sp-btn sp-btn--ghost" onClick={() => setStep(1)}>Back</button></>
    }>
      <div class="sp-note sp-addswap-note">
        <div class="sp-note__title">Step 2: Choose flavor & quantity</div>
        <div class="sp-note__body">Pick your preferred option below.</div>
      </div>

      <div class="sp-addswap-selected">
        {varImg ? <img class="sp-addswap__img" src={varImg} alt={selectedProduct?.title} /> : <div class="sp-addswap__img sp-addswap__img--placeholder" />}
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
            <span class="sp-addswap__discount-badge">25% OFF</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
