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

// ---- Inline cards ----

function PauseCard({ contract, onUpdate, showToast }) {
  const [busy, setBusy] = useState(false);
  async function doPause(days) {
    setBusy(true);
    try {
      await postJson('pause', { contractId: contract.id, days });
      showToast('Subscription paused for ' + days + ' days', 'success');
      clearCaches(); onUpdate();
    } catch { showToast('Could not pause. Please try again.', 'error'); }
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

function ResumeCard({ contract, onUpdate, showToast }) {
  const [busy, setBusy] = useState(false);
  async function doResume() {
    setBusy(true);
    try {
      await postJson('resume', { contractId: contract.id });
      showToast('Subscription resumed!', 'success');
      clearCaches(); onUpdate();
    } catch { showToast('Could not resume. Please try again.', 'error'); }
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

function LineItemDisclosure({ ln, canRemove, onSwap, onQty, onRemove, removing }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="sp-line-group">
      <div class="sp-line">
        {getLineImage(ln)
          ? <img class="sp-line__img" src={getLineImage(ln)} alt={safeStr(ln.title)} />
          : <div class="sp-line__img sp-line__img--placeholder" />}
        <div class="sp-line__meta">
          <div class="sp-line__title">{safeStr(ln.title) || 'Item'}</div>
          <div class="sp-line__subwrap sp-muted">
            {ln.variantTitle && <div class="sp-line__variant">{safeStr(ln.variantTitle)}</div>}
            <div class="sp-line__qty">Qty {ln.quantity || 1}</div>
          </div>
        </div>
        <div class="sp-line__price">{ln.currentPrice ? money(ln.currentPrice) : ''}</div>
      </div>
      <button type="button" class={'sp-disclosure' + (open ? ' is-open' : '')}
        onClick={() => setOpen(!open)}>
        <span class="sp-disclosure__label">Make changes to this item</span>
        <span class="sp-disclosure__arrow">{open ? '\u25B2' : '\u25BC'}</span>
      </button>
      {open && (
        <div class="sp-disclosure__panel">
          <button class="sp-disclosure__action" onClick={onSwap}>
            <div class="sp-disclosure__action-title">Swap</div>
            <div class="sp-disclosure__action-sub sp-muted">Choose different flavor or product.</div>
          </button>
          <button class="sp-disclosure__action" onClick={onQty}>
            <div class="sp-disclosure__action-title">Change quantity</div>
            <div class="sp-disclosure__action-sub sp-muted">Update how many you receive.</div>
          </button>
          {canRemove && (
            <button class="sp-disclosure__action sp-disclosure__action--danger" disabled={removing}
              onClick={onRemove}>
              <div class="sp-disclosure__action-title">{removing ? 'Removing\u2026' : 'Remove'}</div>
              <div class="sp-disclosure__action-sub sp-muted">Remove this item.</div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ItemsCard({ contract, lines, shipLine, onUpdate, onPatchLines, showToast, config }) {
  const [modal, setModal] = useState(null);
  const [removingLine, setRemovingLine] = useState(null); // sku of line being removed

  const total = lines.reduce((sum, ln) => {
    const p = getLinePrice(ln);
    return sum + (isFinite(p) ? p * (ln.quantity || 1) : 0);
  }, 0);

  const totalRealQty = lines.reduce((sum, ln) => sum + (ln.quantity || 1), 0);
  const canRemove = lines.length > 1;

  async function doRemove(ln) {
    setRemovingLine(ln.sku || ln.variantId);
    try {
      const resp = await postJson('replaceVariants', {
        contractId: contract.id,
        oldVariants: [{ variantId: ln.variantId }],
        allowRemoveWithoutAdd: true,
      });
      showToast('Item removed.', 'success');
      clearCaches();
      // Use patch lines from response if available, otherwise optimistically remove the line
      if (resp?.patch?.lines && Array.isArray(resp.patch.lines)) {
        onPatchLines(resp.patch.lines);
      } else {
        // Appstle may be async — re-fetch would return stale data, so remove optimistically
        const remaining = lines.filter(l => l !== ln);
        if (remaining.length) {
          onPatchLines(remaining);
        } else {
          onUpdate();
        }
      }
    } catch (e) {
      showToast(e?.message || 'Could not remove item.', 'error');
    }
    setRemovingLine(null);
  }

  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Items</div>
        <p class="sp-muted sp-detail__section-sub">What's included in your subscription.</p>
      </div>
      <div class="sp-detail__lines">
        {lines.map((ln, i) => (
          <LineItemDisclosure key={i} ln={ln} canRemove={canRemove}
            removing={removingLine === (ln.sku || ln.variantId)}
            onSwap={() => setModal({ type: 'addSwap', line: ln, mode: 'swap' })}
            onQty={() => setModal({ type: 'quantity', line: ln })}
            onRemove={() => doRemove(ln)}
          />
        ))}
      </div>
      {isFinite(total) && total > 0 && (
        <div class="sp-detail__totals">
          <span class="sp-muted">Subtotal</span>
          <span class="sp-detail__total-price">{toMoney(total)}</span>
        </div>
      )}
      <div class="sp-detail__items-actions">
        <button class="sp-btn sp-btn--ghost" onClick={() => setModal({ type: 'addSwap', mode: 'add' })}>
          + Add item
        </button>
      </div>

      {modal?.type === 'addSwap' && (
        <AddSwapModal mode={modal.mode} contract={contract} line={modal.line}
          catalog={config.catalog} totalRealQty={totalRealQty}
          onClose={() => setModal(null)} onDone={onUpdate} />
      )}
      {modal?.type === 'quantity' && (
        <QuantityModal contract={contract} line={modal.line}
          onClose={() => setModal(null)} onDone={onUpdate} />
      )}
    </div>
  );
}

function AddressCard({ contract, showToast, onUpdate }) {
  const addr = contract?.deliveryMethod?.address || {};
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    firstName: addr.firstName || '', lastName: addr.lastName || '',
    address1: addr.address1 || '', address2: addr.address2 || '',
    city: addr.city || '', province: addr.province || '', zip: addr.zip || '',
  });
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await postJson('address', { contractId: contract.id, ...form });
      showToast('Address updated!', 'success');
      clearCaches(); setEditing(false); onUpdate();
    } catch { showToast('Could not update address.', 'error'); }
    setBusy(false);
  }

  const display = [addr.address1, addr.address2, [addr.city, addr.province, addr.zip].filter(Boolean).join(', ')].filter(Boolean).join('\n');

  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead"><div class="sp-title2">Shipping address</div></div>
      <p class="sp-muted" style={{ whiteSpace: 'pre-line' }}>{display || 'No address on file'}</p>
      <button class="sp-btn sp-btn--ghost" onClick={() => setEditing(true)}>Change address</button>
      {editing && (
        <Modal title="Change shipping address" onClose={() => setEditing(false)} footer={
          <><button class="sp-btn sp-btn-primary" disabled={busy} onClick={save}>Save</button>
          <button class="sp-btn sp-btn--ghost" onClick={() => setEditing(false)}>Cancel</button></>
        }>
          {['firstName', 'lastName', 'address1', 'address2', 'city', 'province', 'zip'].map(k => (
            <div key={k} class="sp-field">
              <label class="sp-field__label">{k.replace(/([A-Z])/g, ' $1').replace(/^\w/, c => c.toUpperCase())}</label>
              <input class="sp-input" value={form[k]} onInput={(e) => setForm(prev => ({ ...prev, [k]: e.target.value }))} />
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}

function CouponCard({ contract, showToast, onUpdate }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  async function apply() {
    if (!code.trim()) return;
    setBusy(true);
    try {
      await postJson('coupon', { contractId: contract.id, discountCode: code.trim(), mode: 'apply' });
      showToast('Coupon applied!', 'success');
      setCode(''); clearCaches(); onUpdate();
    } catch { showToast('Could not apply coupon.', 'error'); }
    setBusy(false);
  }
  return (
    <div class="sp-card sp-detail__card">
      <div class="sp-detail__sectionhead"><div class="sp-title2">Coupon</div></div>
      <div class="sp-detail__coupon-row">
        <input class="sp-input" placeholder="Discount code" value={code}
          onInput={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') apply(); }} />
        <button class="sp-btn sp-btn-primary" disabled={busy || !code.trim()} onClick={apply}>Apply</button>
      </div>
    </div>
  );
}

function FrequencyCard({ contract, showToast, onUpdate }) {
  const label = billingLabel(contract?.billingPolicy) || 'Not set';
  const [modal, setModal] = useState(false);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  const options = [
    { label: 'Twice a Month', interval: 'WEEK', count: 2 },
    { label: 'Monthly', interval: 'WEEK', count: 4 },
    { label: 'Every 2 Months', interval: 'WEEK', count: 8 },
  ];

  async function save() {
    const opt = options.find(o => o.label === selected);
    if (!opt) return;
    setBusy(true);
    try {
      await postJson('frequency', { contractId: contract.id, intervalCount: opt.count, interval: opt.interval });
      showToast('Frequency updated!', 'success');
      clearCaches(); setModal(false); onUpdate();
    } catch { showToast('Could not update frequency.', 'error'); }
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
            {options.map(o => (
              <label key={o.label} class="sp-radio-row">
                <input type="radio" name="freq" value={o.label} checked={selected === o.label} onChange={() => setSelected(o.label)} />
                <span>{o.label}</span>
              </label>
            ))}
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
  const { config, router, showToast } = useContext(PortalContext);
  const contractId = new URLSearchParams(window.location.search).get('id') || '';

  const [contract, setContract] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchContract = useCallback(async () => {
    let c = getCachedContractById(contractId);
    if (c) { setContract(normalizeContract(c)); setLoading(false); return; }
    try {
      const resp = await requestJson('subscriptionDetail', { id: contractId }, { force: true });
      if (resp?.ok) {
        setContract(normalizeContract(resp.contract || resp.data || resp.subscription));
      } else { setError(true); }
    } catch { setError(true); }
    setLoading(false);
  }, [contractId]);

  // Optimistic lines update from replaceVariants patch (avoids stale re-fetch)
  const patchLines = useCallback((newLines) => {
    setContract(prev => prev ? normalizeContract({ ...prev, lines: newLines }) : prev);
  }, []);

  useEffect(() => { fetchContract(); }, [fetchContract]);

  if (!contractId) return <div class="sp-wrap sp-grid"><div class="sp-card"><h2 class="sp-title">Missing subscription id</h2></div></div>;

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
    return <div class="sp-wrap sp-grid"><div class="sp-card"><h2 class="sp-title">Could not load subscription</h2><p class="sp-muted">Please refresh.</p></div></div>;
  }

  const b = getBucket(contract);
  const isCancelled = b === 'cancelled';
  const isLocked = !!contract?.portalState?.isLocked;
  const isReadOnly = isCancelled || isLocked;
  const { lines, shipLine } = splitLines(contract);

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

  // Product IDs for reviews
  const productIds = lines.map(ln => shortId(ln?.productId)).filter(Boolean);

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
      </div>

      {dunning && <DunningBanner dunning={dunning} />}

      {isLocked && (
        <div class="sp-alert">
          <div class="sp-alert__title">Heads up</div>
          <div class="sp-alert__body sp-muted">Your subscription is being set up. Once you receive your first order, you can make edits here.</div>
        </div>
      )}

      <div class="sp-grid sp-detail__grid">
        <div class="sp-detail__col">
          {b === 'paused' && !isReadOnly && <ResumeCard contract={contract} onUpdate={fetchContract} showToast={showToast} />}
          {b === 'active' && !isReadOnly && <PauseCard contract={contract} onUpdate={fetchContract} showToast={showToast} />}
          <ItemsCard contract={contract} lines={lines} shipLine={shipLine} onUpdate={fetchContract} onPatchLines={patchLines} showToast={showToast} config={config} />
          {!isReadOnly && <FrequencyCard contract={contract} showToast={showToast} onUpdate={fetchContract} />}
        </div>
        <div class="sp-detail__col">
          {!isCancelled && <RewardsCard />}
          {!isReadOnly && <CouponCard contract={contract} showToast={showToast} onUpdate={fetchContract} />}
          {!isReadOnly && <AddressCard contract={contract} showToast={showToast} onUpdate={fetchContract} />}
          {!isReadOnly && <ShippingProtectionCard contract={contract} shipLine={shipLine} onUpdate={fetchContract} />}
          {!isCancelled && productIds.length > 0 && <ReviewsCard productIds={productIds} />}
          {!isReadOnly && <CancelCard router={router} contractId={shortId(contract.id)} />}
        </div>
      </div>
    </div>
  );
}
