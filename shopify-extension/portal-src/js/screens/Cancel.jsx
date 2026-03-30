// screens/Cancel.jsx — AI-powered cancel retention flow
//
// Flow: skeleton → reason → remedies|chat → confirm → done
// Backend: GET/POST /api/portal?route=cancelJourney&contractId={id}

import { useState, useEffect, useContext, useRef, useCallback } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { requestJson, postJson, clearCaches } from '../core/api.js';
import { shortId } from '../core/utils.js';
import { SkeletonCancelScreen } from '../components/Skeleton.jsx';
import ReviewsCard from '../cards/ReviewsCard.jsx';

const OPEN_ENDED = ['just_need_a_break', 'something_else', 'reached_goals'];

const DEFAULT_REASONS = [
  { id: 'too_expensive', label: "It\u2019s too expensive" },
  { id: 'too_much_product', label: 'I have too much product' },
  { id: 'not_seeing_results', label: "I\u2019m not seeing results" },
  { id: 'reached_goals', label: 'I already reached my goals' },
  { id: 'just_need_a_break', label: 'I just need a break' },
  { id: 'tired_of_flavor', label: "I\u2019m tired of the flavors" },
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
  specialist: '\uD83D\uDC64', social_proof: '\u2B50', ai_conversation: '\uD83D\uDCAC',
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
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
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
          <input ref={inputRef} type="text" class="sp-chat__input" placeholder="Type your message\u2026"
            value={text} onInput={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSend(); } }} />
          <button type="button" class="sp-btn sp-btn-primary sp-chat__send" onClick={handleSend}>Send</button>
        </div>
      )}
      <div class="sp-chat__actions">
        {ended && (
          <button type="button" class="sp-btn sp-btn-primary" onClick={onKeep}>Keep my subscription</button>
        )}
        {!loading && (
          <button type="button" class="sp-btn sp-btn--ghost sp-chat__cancel-link" onClick={onCancel}>
            I still want to cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Headers ----

function CancelHeader({ contractId, title, onBack }) {
  return (
    <div class="sp-cancel__header">
      <button type="button" class="sp-btn sp-btn--ghost sp-cancel__back" onClick={onBack}>
        {'\u2190'} Back to subscription
      </button>
      <div class="sp-cancel__title sp-title2">{title || 'Cancel subscription'}</div>
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
  const [phase, setPhase] = useState('loading'); // loading, reason, remedies, chat, confirm
  const [journey, setJourney] = useState(null);
  const [reason, setReason] = useState('');
  const [remedies, setRemedies] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [busy, setBusy] = useState(false);

  // Chat state
  const [chatMessages, setChatMessages] = useState([]);
  const [chatTurn, setChatTurn] = useState(0);
  const [chatMaxTurns, setChatMaxTurns] = useState(3);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatTicketId, setChatTicketId] = useState(null);

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

  // Fetch journey data on mount
  useEffect(() => {
    if (!contractId) return;
    scrollTop();
    requestJson('cancelJourney', { contractId }, { force: true })
      .then(resp => {
        if (resp?.ok) {
          setJourney(resp);
          if (resp.reviews) setReviews(resp.reviews);
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

    if (OPEN_ENDED.includes(reasonId)) {
      goToPhase('chat');
      setChatMessages([]);
      setChatTurn(0);
      setChatLoading(true);

      try {
        const resp = await postJson('cancelJourney', { step: 'reason', reason: reasonId, startChat: true }, { contractId });
        if (resp?.reply) {
          setChatMessages([{ role: 'ai', text: resp.reply }]);
          setChatTurn(resp.turn || 1);
          if (resp.maxTurns) setChatMaxTurns(resp.maxTurns);
        } else {
          setChatMessages([{ role: 'ai', text: "I understand. Can you tell me more about what\u2019s going on?" }]);
          setChatTurn(1);
        }
        if (resp?.ticketId) setChatTicketId(resp.ticketId);
      } catch {
        setChatMessages([{ role: 'ai', text: "I\u2019d love to help. Can you tell me more?" }]);
        setChatTurn(1);
      }
      setChatLoading(false);
    } else {
      goToPhase('remedies');
      setBusy(true);
      try {
        const resp = await postJson('cancelJourney', { step: 'reason', reason: reasonId }, { contractId });
        if (resp?.remedies) setRemedies(resp.remedies);
        if (resp?.reviews) setReviews(resp.reviews);
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
        step: 'chat', message: text, reason, turn: chatTurn, ticketId: chatTicketId,
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
      await postJson('cancelJourney', { step: 'remedy', remedyId: remedy.id, accepted: true, reason }, { contractId });
      showToast('Your subscription has been updated!', 'success');
      clearCaches();
      router.navigate(detailUrl);
    } catch {
      showToast('Something went wrong. Please try again.', 'error');
      setBusy(false);
    }
  }

  // ---- Hard cancel ----
  async function confirmCancel() {
    setBusy(true);
    try {
      await postJson('cancelJourney', { step: 'confirm_cancel', reason, ticketId: chatTicketId }, { contractId });
      showToast('Your subscription has been cancelled.', 'success');
      clearCaches();
      router.navigate(detailUrl);
    } catch {
      showToast("Sorry \u2014 we couldn\u2019t cancel your subscription. Please try again.", 'error');
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
    if (busy && !remedies.length) {
      return (
        <div class="sp-cancel">
          <CancelHeader onBack={goBack} title="Before you go\u2026" />
          <SkeletonCancelScreen />
        </div>
      );
    }
    return (
      <div class="sp-card sp-cancel">
        <CancelHeader onBack={goBack} title="Before you go\u2026" />
        <AlertBar />
        {remedies.length > 0 && (
          <div class="sp-cancel__remedies-section">
            <div class="sp-cancel__remedies-title">We have a few options that might help:</div>
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

  // ---- CHAT STEP ----
  if (phase === 'chat') {
    return (
      <div class="sp-card sp-cancel">
        <CancelHeader onBack={goBack} title="Let\u2019s talk about it" />
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
