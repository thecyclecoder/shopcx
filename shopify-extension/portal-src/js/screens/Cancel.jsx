// screens/Cancel.jsx — AI-powered cancel retention flow
//
// Flow: skeleton → reason → remedies|chat|line_item_modify → confirm → done
// Backend: GET/POST /api/portal?route=cancelJourney&contractId={id}

import { useState, useEffect, useContext, useRef, useCallback } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { requestJson, postJson, clearCaches } from '../core/api.js';
import { shortId } from '../core/utils.js';
import { SkeletonCancelScreen } from '../components/Skeleton.jsx';
import ReviewsCard from '../cards/ReviewsCard.jsx';
import { fireConfetti } from '../core/confetti.js';

// Reason type is now driven by backend config (type: "remedy" | "ai_conversation")
// Fallback for old configs that don't have types yet
const OPEN_ENDED_FALLBACK = ['just_need_a_break', 'something_else', 'reached_goals'];

const DEFAULT_REASONS = [
  { id: 'too_expensive', label: "It's too expensive" },
  { id: 'too_much_product', label: 'I have too much product' },
  { id: 'not_seeing_results', label: "I'm not seeing results" },
  { id: 'reached_goals', label: 'I already reached my goals' },
  { id: 'just_need_a_break', label: 'I just need a break' },
  { id: 'tired_of_flavor', label: "I'm tired of the flavors" },
  { id: 'shipping_issues', label: 'Shipping or delivery issues' },
  { id: 'something_else', label: 'Something else' },
];

// ---- Sub-components ----

function StarRating({ rating }) {
  const stars = Array.from({ length: 5 }, (_, i) => i < rating ? '\u2605' : '\u2606');
  return <span class="sp-review-stars">{stars.join('')}</span>;
}

function ReviewCard({ review }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div class="sp-review-social">
      <div class="sp-review-social__header">
        <StarRating rating={review.rating || 5} />
        <span class="sp-review-social__author sp-muted">{review.author || 'Verified Customer'}</span>
      </div>
      {review.summary && <div class="sp-review-social__summary">{'\u201C'}{review.summary}{'\u201D'}</div>}
      {review.body && (
        <>
          <div class="sp-review-social__body" style={{ display: expanded ? 'block' : 'none' }}>{review.body}</div>
          <button type="button" class="sp-review-social__toggle sp-muted" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : 'Read full review'}
          </button>
        </>
      )}
    </div>
  );
}

function ReviewsList({ reviews }) {
  if (!reviews?.length) return null;
  return (
    <div class="sp-review-social-list">
      <div class="sp-review-social-list__title">What other customers are saying</div>
      {reviews.slice(0, 3).map((r, i) => <ReviewCard key={i} review={r} />)}
    </div>
  );
}

const REMEDY_ICONS = {
  coupon: '\uD83C\uDFF7\uFE0F', pause: '\u23F8\uFE0F', pause_30d: '\u23F8\uFE0F', pause_60d: '\u23F8\uFE0F',
  skip: '\u23ED\uFE0F', monthly: '\uD83D\uDCC5', bimonthly: '\uD83D\uDCC5', frequency_change: '\uD83D\uDCC5',
  free_product: '\uD83C\uDF81', line_item_modifier: '\uD83D\uDD04',
};

function RemedyCard({ remedy, onAccept, busy }) {
  const icon = REMEDY_ICONS[remedy.type] || '\u2728';
  return (
    <div class="sp-remedy-card">
      <div class="sp-remedy-card__icon">{icon}</div>
      <div class="sp-remedy-card__body">
        <div class="sp-remedy-card__label">{remedy.label || 'Special offer'}</div>
        {remedy.description && <div class="sp-remedy-card__desc sp-muted">{remedy.description}</div>}
      </div>
      <button type="button" class="sp-btn sp-btn-primary sp-remedy-card__btn" disabled={busy} onClick={() => onAccept(remedy)}>
        {remedy.label || 'Accept'}
      </button>
    </div>
  );
}

function ChatInterface({ messages, turn, maxTurns, loading, onSend, onCancel, onKeep }) {
  const [text, setText] = useState('');
  const messagesEnd = useRef(null);
  const inputRef = useRef(null);
  const ended = turn >= maxTurns;

  useEffect(() => {
    // Small delay to ensure DOM has rendered the new message
    setTimeout(() => {
      messagesEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 50);
  }, [messages.length, loading]);

  useEffect(() => {
    if (!loading && !ended) inputRef.current?.focus();
  }, [loading, ended]);

  function handleSend() {
    const msg = text.trim();
    if (!msg) return;
    setText('');
    onSend(msg);
  }

  return (
    <div class="sp-chat">
      <div class="sp-chat__messages">
        {messages.map((m, i) => (
          <div key={i} class={'sp-chat__bubble sp-chat__bubble--' + m.role}>
            <div class="sp-chat__text">{m.text}</div>
          </div>
        ))}
        {loading && (
          <div class="sp-chat__bubble sp-chat__bubble--ai sp-chat__bubble--typing">
            <div class="sp-chat__typing">
              <span class="sp-chat__dot" /><span class="sp-chat__dot" /><span class="sp-chat__dot" />
            </div>
          </div>
        )}
        <div ref={messagesEnd} />
      </div>
      {!ended && !loading && (
        <div class="sp-chat__input-row">
          <input ref={inputRef} type="text" class="sp-chat__input" placeholder="Type your message…"
            value={text} onInput={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSend(); } }} />
          <button type="button" class="sp-btn sp-btn-primary sp-chat__send" onClick={handleSend}>Send</button>
        </div>
      )}
      <div class="sp-chat__actions">
        {ended && (
          <button type="button" class="sp-btn sp-btn-primary" onClick={onKeep}>Keep my subscription</button>
        )}
        {!loading && turn >= 2 && (
          <button type="button" class="sp-btn sp-btn--ghost sp-chat__cancel-link" onClick={onCancel}>
            I still want to cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Line Item Modifier Components ----

function LineItemCard({ item, selected, onSelect }) {
  const img = item.image || item.variantImage || item.variant_image;
  const vTitle = item.variantTitle || item.variant_title;
  return (
    <button type="button"
      class={'sp-remedy-card sp-remedy-card--selectable' + (selected ? ' sp-remedy-card--selected' : '')}
      onClick={() => onSelect(item)}>
      {img && <img src={img} alt="" class="sp-remedy-card__img" />}
      <div class="sp-remedy-card__body">
        <div class="sp-remedy-card__label">{item.title || item.productTitle}</div>
        {vTitle && vTitle !== 'Default Title' && (
          <div class="sp-remedy-card__desc sp-muted">{vTitle}</div>
        )}
        <div class="sp-remedy-card__desc sp-muted">Qty: {item.quantity || 1}</div>
      </div>
    </button>
  );
}

function LineItemModifier({ subscription, contractId, onComplete, onCancel, showToast }) {
  const [subStep, setSubStep] = useState('select_item'); // select_item, choose_action, action_form, confirm
  const [selectedItem, setSelectedItem] = useState(null);
  const [action, setAction] = useState('');
  const [actionValue, setActionValue] = useState(null);
  const [busy, setBusy] = useState(false);
  const [variants, setVariants] = useState([]);
  const [products, setProducts] = useState([]);
  const [productSearch, setProductSearch] = useState('');

  const items = (subscription?.items || subscription?.lines || [])
    .filter(i => !i.isShippingProtection);

  function selectItem(item) {
    setSelectedItem(item);
    setSubStep('choose_action');
  }

  function chooseAction(act) {
    setAction(act);
    if (act === 'swap_variant') {
      // Load variants for this product from the item data
      const v = selectedItem?.variants || [];
      setVariants(v);
    }
    setSubStep('action_form');
  }

  async function executeAction() {
    setBusy(true);
    try {
      let payload = { step: 'line_item_action', action };
      const vid = shortId(selectedItem?.variantId || selectedItem?.variant_id);

      if (action === 'swap_variant') {
        payload = { ...payload, oldVariantId: vid, newVariantId: actionValue, variantId: vid };
      } else if (action === 'change_quantity') {
        payload = { ...payload, variantId: vid, quantity: actionValue };
      } else if (action === 'remove') {
        payload = { ...payload, variantId: vid };
      } else if (action === 'swap_product') {
        payload = { ...payload, variantId: vid, newVariantId: actionValue, quantity: selectedItem?.quantity || 1 };
      }

      const resp = await postJson('cancelJourney', payload, { contractId });
      if (resp?.ok) {
        onComplete(resp.savedAction || 'updated your subscription items');
      } else {
        showToast('Something went wrong. Please try again.', 'error');
        setBusy(false);
      }
    } catch {
      showToast('Something went wrong. Please try again.', 'error');
      setBusy(false);
    }
  }

  const hasMultipleVariants = selectedItem?.variants?.length > 1;
  const actionLabel = {
    swap_variant: 'Change flavor',
    change_quantity: 'Change quantity',
    swap_product: 'Swap product',
    remove: 'Remove item',
  };

  // Step 1: Select item
  if (subStep === 'select_item') {
    return (
      <div class="sp-cancel__line-items">
        <div class="sp-cancel__remedies-title">Which item would you like to change?</div>
        <div class="sp-remedy-list">
          {items.map((item, i) => (
            <LineItemCard key={i} item={item} selected={false} onSelect={selectItem} />
          ))}
        </div>
        <div class="sp-cancel__footer">
          <button type="button" class="sp-btn sp-btn--ghost" onClick={onCancel}>
            {'\u2190'} Back to options
          </button>
        </div>
      </div>
    );
  }

  // Step 2: Choose action
  if (subStep === 'choose_action') {
    return (
      <div class="sp-cancel__line-items">
        <div class="sp-cancel__remedies-title">What would you like to do with {selectedItem?.title || 'this item'}?</div>
        <div class="sp-remedy-list">
          {hasMultipleVariants && (
            <button type="button" class="sp-btn sp-btn--ghost sp-cancel-reason"
              onClick={() => chooseAction('swap_variant')}>
              <div class="sp-cancel-reason__label">{'\uD83C\uDF68'} Change flavor / variant</div>
            </button>
          )}
          <button type="button" class="sp-btn sp-btn--ghost sp-cancel-reason"
            onClick={() => chooseAction('change_quantity')}>
            <div class="sp-cancel-reason__label">{'\uD83D\uDD22'} Change quantity</div>
          </button>
          <button type="button" class="sp-btn sp-btn--ghost sp-cancel-reason"
            onClick={() => chooseAction('swap_product')}>
            <div class="sp-cancel-reason__label">{'\uD83D\uDD00'} Swap for a different product</div>
          </button>
          <button type="button" class="sp-btn sp-btn--ghost sp-cancel-reason"
            onClick={() => chooseAction('remove')}>
            <div class="sp-cancel-reason__label">{'\u274C'} Remove this item</div>
          </button>
        </div>
        <div class="sp-cancel__footer">
          <button type="button" class="sp-btn sp-btn--ghost" onClick={() => setSubStep('select_item')}>
            {'\u2190'} Back
          </button>
        </div>
      </div>
    );
  }

  // Step 3: Action form
  if (subStep === 'action_form') {
    let form = null;

    if (action === 'swap_variant') {
      const currentVariant = shortId(selectedItem?.variantId);
      form = (
        <div>
          <div class="sp-cancel__remedies-title">Choose a new variant</div>
          <div class="sp-remedy-list">
            {variants.filter(v => shortId(v.id) !== currentVariant).map((v, i) => (
              <button key={i} type="button"
                class={'sp-btn sp-btn--ghost sp-cancel-reason' + (actionValue === shortId(v.id) ? ' sp-cancel-reason--selected' : '')}
                onClick={() => setActionValue(shortId(v.id))}>
                <div class="sp-cancel-reason__label">{v.title}</div>
              </button>
            ))}
          </div>
        </div>
      );
    } else if (action === 'change_quantity') {
      const qty = actionValue || selectedItem?.quantity || 1;
      form = (
        <div>
          <div class="sp-cancel__remedies-title">Set new quantity</div>
          <div class="sp-cancel__qty-row">
            <button type="button" class="sp-btn sp-btn--ghost sp-btn--sm"
              disabled={qty <= 1} onClick={() => setActionValue(Math.max(1, qty - 1))}>-</button>
            <span class="sp-cancel__qty-val">{qty}</span>
            <button type="button" class="sp-btn sp-btn--ghost sp-btn--sm"
              onClick={() => setActionValue(qty + 1)}>+</button>
          </div>
        </div>
      );
    } else if (action === 'remove') {
      form = (
        <div>
          <div class="sp-cancel__remedies-title">Remove {selectedItem?.title || 'this item'}?</div>
          <p class="sp-muted" style={{ marginBottom: '16px' }}>
            This will remove the item from your upcoming orders.
          </p>
        </div>
      );
      if (!actionValue) setActionValue('confirmed');
    } else if (action === 'swap_product') {
      form = (
        <div>
          <div class="sp-cancel__remedies-title">This feature is coming soon</div>
          <p class="sp-muted">Product swap will be available in a future update. For now, you can remove this item and add a new one from your subscription page.</p>
        </div>
      );
    }

    const canProceed = action === 'remove' || (action === 'swap_product') || !!actionValue;

    return (
      <div class="sp-cancel__line-items">
        {form}
        <div class="sp-cancel__footer" style={{ gap: '8px', display: 'flex', flexDirection: 'column' }}>
          {action !== 'swap_product' && (
            <button type="button" class="sp-btn sp-btn-primary" disabled={!canProceed || busy}
              onClick={() => action === 'remove' ? executeAction() : setSubStep('confirm')}>
              {busy ? 'Updating...' : action === 'remove' ? 'Remove item' : 'Confirm change'}
            </button>
          )}
          <button type="button" class="sp-btn sp-btn--ghost" onClick={() => { setSubStep('choose_action'); setActionValue(null); }}>
            {'\u2190'} Back
          </button>
        </div>
      </div>
    );
  }

  // Step 4: Confirm
  if (subStep === 'confirm') {
    return (
      <div class="sp-cancel__line-items">
        <div class="sp-cancel__remedies-title">Confirm your change</div>
        <div class="sp-remedy-card">
          <div class="sp-remedy-card__body">
            <div class="sp-remedy-card__label">{selectedItem?.title}</div>
            <div class="sp-remedy-card__desc sp-muted">{actionLabel[action] || action}</div>
          </div>
        </div>
        <div class="sp-cancel__footer" style={{ gap: '8px', display: 'flex', flexDirection: 'column' }}>
          <button type="button" class="sp-btn sp-btn-primary" disabled={busy} onClick={executeAction}>
            {busy ? 'Updating...' : 'Confirm'}
          </button>
          <button type="button" class="sp-btn sp-btn--ghost" onClick={() => setSubStep('action_form')}>
            {'\u2190'} Back
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// ---- Headers ----

function CancelHeader({ contractId, title, onBack }) {
  return (
    <div class="sp-cancel__header">
      <button type="button" class="sp-btn sp-btn--ghost sp-cancel__back" onClick={onBack}>
        {'\u2190'} Back to subscription
      </button>
      {title && <div class="sp-cancel__title sp-title2">{title}</div>}
    </div>
  );
}

function AlertBar() {
  return (
    <div class="sp-cancel__alert sp-cancel__alert--top">
      <div class="sp-cancel__alert-title">Not cancelled yet</div>
      <div class="sp-cancel__alert-sub">Your subscription remains active until you confirm on the final step.</div>
    </div>
  );
}

// ---- Main cancel screen ----

export default function Cancel() {
  const { router, showToast } = useContext(PortalContext);
  const contractId = new URLSearchParams(window.location.search).get('id') || '';
  const detailUrl = router.base + '/subscription?id=' + encodeURIComponent(contractId);

  // State
  const [phase, setPhase] = useState('loading'); // loading, reason, remedies, chat, line_item_modify, confirm
  const [journey, setJourney] = useState(null);
  const [reason, setReason] = useState('');
  const [remedies, setRemedies] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState(null);

  // Chat state
  const [chatMessages, setChatMessages] = useState([]);
  const [chatTurn, setChatTurn] = useState(0);
  const [chatMaxTurns, setChatMaxTurns] = useState(3);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatTicketId, setChatTicketId] = useState(null);
  const [chatInitialAiReply, setChatInitialAiReply] = useState(null);
  const [chatReasonLabel, setChatReasonLabel] = useState('');

  // Product IDs for ReviewsCard on reason step
  const productIds = journey?.subscription?.items
    ? (journey.subscription.items || []).map(i => shortId(i.product_id)).filter(Boolean)
    : [];

  // Scroll to top helper
  function scrollTop() { window.scrollTo(0, 0); }

  // Phase change wrapper: always scroll to top
  function goToPhase(p) {
    setPhase(p);
    scrollTop();
  }

  // Customer context for personalized messaging
  const [customerFirstName, setCustomerFirstName] = useState('');
  const [subscriptionAgeDays, setSubscriptionAgeDays] = useState(0);

  // Navigate to detail with save celebration
  function navigateWithSave(action) {
    clearCaches();
    const savedUrl = detailUrl + (detailUrl.includes('?') ? '&' : '?') + 'saved=1&action=' + encodeURIComponent(action);
    router.navigate(savedUrl);
  }

  // Fetch journey data on mount
  useEffect(() => {
    if (!contractId) return;
    scrollTop();
    requestJson('cancelJourney', { contractId }, { force: true })
      .then(resp => {
        if (resp?.ok) {
          setJourney(resp);
          if (resp.reviews) setReviews(resp.reviews);
          if (resp.customerFirstName) setCustomerFirstName(resp.customerFirstName);
          if (resp.subscriptionAgeDays) setSubscriptionAgeDays(resp.subscriptionAgeDays);
          goToPhase('reason');
        } else {
          setJourney({ cancel_reasons: [], reviews: [] });
          goToPhase('reason');
        }
      })
      .catch(() => {
        setJourney({ cancel_reasons: [], reviews: [] });
        goToPhase('reason');
      });
  }, [contractId]);

  const goBack = useCallback(() => router.navigate(detailUrl), [router, detailUrl]);

  // ---- Reason selection ----
  async function selectReason(reasonId) {
    setReason(reasonId);

    // Check reason type from backend config, fall back to hardcoded list
    const reasonConfig = reasons.find(r => r.id === reasonId);
    const reasonType = reasonConfig?.type || (OPEN_ENDED_FALLBACK.includes(reasonId) ? 'ai_conversation' : 'remedy');
    const suggestedRemedyId = reasonConfig?.suggested_remedy_id || null;

    if (reasonType === 'ai_conversation') {
      goToPhase('chat');
      setChatMessages([]);
      setChatTurn(0);
      setChatLoading(true);

      try {
        const rl = reasonConfig?.label || reasonId;
        setChatReasonLabel(rl);
        const resp = await postJson('cancelJourney', { step: 'reason', reason: reasonId, reasonType: 'ai_conversation', reasonLabel: rl }, { contractId });
        if (resp?.reply) {
          setChatMessages([{ role: 'ai', text: resp.reply }]);
          setChatTurn(resp.turn || 1);
          if (resp.maxTurns) setChatMaxTurns(resp.maxTurns);
          setChatInitialAiReply(resp.reply);
        } else {
          const fallback = "I understand. Can you tell me more about what's going on?";
          setChatMessages([{ role: 'ai', text: fallback }]);
          setChatTurn(1);
          setChatInitialAiReply(fallback);
        }
        if (resp?.ticketId) setChatTicketId(resp.ticketId);
      } catch {
        const fallback = "I'd love to help. Can you tell me more?";
        setChatMessages([{ role: 'ai', text: fallback }]);
        setChatTurn(1);
        setChatInitialAiReply(fallback);
      }
      setChatLoading(false);
    } else {
      goToPhase('remedies');
      setBusy(true);
      try {
        const resp = await postJson('cancelJourney', {
          step: 'reason', reason: reasonId, reasonType: 'remedy',
          suggested_remedy_id: suggestedRemedyId,
        }, { contractId });
        if (resp?.remedies) setRemedies(resp.remedies);
        if (resp?.reviews) setReviews(resp.reviews);
        if (resp?.sessionId) setSessionId(resp.sessionId);
      } catch {
        setRemedies(journey?.remedies || []);
      }
      setBusy(false);
    }
  }

  // ---- Chat ----
  async function sendChat(text) {
    setChatMessages(prev => [...prev, { role: 'customer', text }]);
    setChatLoading(true);
    try {
      const resp = await postJson('cancelJourney', {
        step: 'chat', message: text, reason, reasonLabel: chatReasonLabel,
        turn: chatTurn, ticketId: chatTicketId,
        initialAiReply: chatTicketId ? null : chatInitialAiReply,
      }, { contractId });
      if (resp?.reply) {
        setChatMessages(prev => [...prev, { role: 'ai', text: resp.reply }]);
        setChatTurn(resp.turn || chatTurn + 1);
      }
      if (resp?.ticketId) setChatTicketId(resp.ticketId);
    } catch {
      setChatMessages(prev => [...prev, { role: 'ai', text: 'I understand. Would you like to keep your subscription?' }]);
      setChatTurn(chatMaxTurns);
    }
    setChatLoading(false);
  }

  // ---- Remedy acceptance ----
  async function acceptRemedy(remedy) {
    setBusy(true);
    try {
      const resp = await postJson('cancelJourney', {
        step: 'remedy', remedyId: remedy.id, accepted: true, reason, sessionId,
      }, { contractId });

      // Line item modifier: open multi-step flow
      if (resp?.step === 'line_item_modify') {
        goToPhase('line_item_modify');
        setBusy(false);
        return;
      }

      const action = resp?.savedAction || remedy.label || 'updated your subscription';
      navigateWithSave(action);
    } catch {
      showToast('Something went wrong. Please try again.', 'error');
      setBusy(false);
    }
  }

  // ---- Hard cancel ----
  async function confirmCancel() {
    setBusy(true);
    try {
      await postJson('cancelJourney', {
        step: 'confirm_cancel', reason, ticketId: chatTicketId, sessionId,
      }, { contractId });
      showToast('Your subscription has been cancelled.', 'success');
      clearCaches();
      router.navigate(detailUrl);
    } catch {
      showToast("Sorry — we couldn't cancel your subscription. Please try again.", 'error');
      setBusy(false);
    }
  }

  if (!contractId) {
    return (
      <div class="sp-wrap"><div class="sp-card">
        <h2 class="sp-title">Missing subscription</h2>
        <p class="sp-muted">No subscription id was provided.</p>
      </div></div>
    );
  }

  // ---- LOADING ----
  if (phase === 'loading') {
    return (
      <div class="sp-cancel">
        <CancelHeader onBack={goBack} title="Cancel subscription" />
        <SkeletonCancelScreen />
      </div>
    );
  }

  const reasons = journey?.cancel_reasons?.length ? journey.cancel_reasons : DEFAULT_REASONS;

  // ---- REASON STEP ----
  if (phase === 'reason') {
    const reasonTiles = reasons.map(r => (
      <button key={r.id} type="button" class="sp-btn sp-btn--ghost sp-cancel-reason" onClick={() => selectReason(r.id)}>
        <div class="sp-cancel-reason__label">{r.label}</div>
      </button>
    ));

    const hasProductReviews = productIds.length > 0;

    const content = (
      <>
        <div class="sp-cancel__required">
          <div class="sp-cancel__required-title">To complete your cancellation</div>
          <div class="sp-cancel__required-sub sp-muted">Select the option that best describes your reason.</div>
        </div>
        <div class={'sp-cancel-reasons' + (hasProductReviews ? ' sp-cancel-reasons--with-reviews' : '')}>
          {reasonTiles}
        </div>
        <div class="sp-cancel__footer">
          <a class="sp-cancel__exit sp-muted" href={detailUrl} onClick={(e) => { e.preventDefault(); goBack(); }}>
            Back to subscription details
          </a>
        </div>
      </>
    );

    return (
      <div class="sp-card sp-cancel">
        <CancelHeader onBack={goBack} title="Cancel subscription" />
        <AlertBar />
        {hasProductReviews ? (
          <div class="sp-cancel__layout">
            <div class="sp-cancel__left">{content}</div>
            <div class="sp-cancel__right"><ReviewsCard productIds={productIds} /></div>
          </div>
        ) : content}
      </div>
    );
  }

  // ---- REMEDIES STEP ----
  if (phase === 'remedies') {
    const ageMonths = Math.floor(subscriptionAgeDays / 28);
    const isVip = ageMonths >= 3;
    const name = customerFirstName || 'there';
    const personalHeader = isVip
      ? `Hey ${name}, you're a VIP customer with us. Thanks for being with us for ${ageMonths} month${ageMonths !== 1 ? 's' : ''}. We've put together a special group of options for you because we'd hate to lose you!`
      : `Hey ${name}, most people see the best results with at least 3 months of consistent use. Here are some options to keep you on track:`;

    if (busy && !remedies.length) {
      return (
        <div class="sp-cancel">
          <CancelHeader onBack={goBack} />
          <SkeletonCancelScreen />
        </div>
      );
    }
    return (
      <div class="sp-card sp-cancel">
        <CancelHeader onBack={goBack} />
        <AlertBar />
        {remedies.length > 0 && (
          <div class="sp-cancel__remedies-section">
            <div class="sp-cancel__remedies-title">{personalHeader}</div>
            <div class="sp-remedy-list">
              {remedies.slice(0, 3).map(r => (
                <RemedyCard key={r.id} remedy={r} onAccept={acceptRemedy} busy={busy} />
              ))}
            </div>
          </div>
        )}
        <ReviewsList reviews={reviews} />
        <div class="sp-cancel__footer">
          <button type="button" class="sp-btn sp-btn--ghost sp-cancel__still-cancel"
            onClick={() => goToPhase('confirm')}>
            I still want to cancel
          </button>
        </div>
      </div>
    );
  }

  // ---- LINE ITEM MODIFIER STEP ----
  if (phase === 'line_item_modify') {
    return (
      <div class="sp-card sp-cancel">
        <CancelHeader onBack={() => goToPhase('remedies')} title="Customize your order" />
        <LineItemModifier
          subscription={journey?.subscription}
          contractId={contractId}
          showToast={showToast}
          onComplete={(savedAction) => navigateWithSave(savedAction)}
          onCancel={() => goToPhase('remedies')}
        />
      </div>
    );
  }

  // ---- CHAT STEP ----
  if (phase === 'chat') {
    return (
      <div class="sp-card sp-cancel">
        <CancelHeader onBack={goBack} title="Let's talk about it" />
        <AlertBar />
        <ChatInterface
          messages={chatMessages} turn={chatTurn} maxTurns={chatMaxTurns}
          loading={chatLoading} onSend={sendChat}
          onCancel={() => goToPhase('confirm')}
          onKeep={() => { clearCaches(); router.navigate(detailUrl); }}
        />
      </div>
    );
  }

  // ---- CONFIRM STEP ----
  if (phase === 'confirm') {
    const inner = (
      <div class="sp-cancel-confirm__inner">
        <p class="sp-muted sp-cancel-confirm__copy">
          Are you sure? You can come back any time, but your current pricing and perks may not be available later.
        </p>
        <div class="sp-cancel-confirm__actions">
          <button type="button" class="sp-btn sp-btn-primary sp-btn--danger" disabled={busy} onClick={confirmCancel}>
            Cancel subscription
          </button>
          <button type="button" class="sp-btn sp-btn--ghost" onClick={goBack}>
            Keep my subscription
          </button>
        </div>
      </div>
    );

    return (
      <div class="sp-card sp-cancel sp-cancel-confirm">
        <CancelHeader onBack={goBack} title="Confirm cancellation" />
        {reviews.length > 0 ? (
          <div class="sp-cancel__layout">
            <div class="sp-cancel__left">{inner}</div>
            <div class="sp-cancel__right"><ReviewsList reviews={reviews} /></div>
          </div>
        ) : inner}
      </div>
    );
  }

  return null;
}
