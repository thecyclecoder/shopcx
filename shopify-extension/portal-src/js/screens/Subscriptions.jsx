// screens/Subscriptions.jsx — List view with tabs, dunning badges, linked accounts
import { useState, useEffect, useContext } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { requestJson } from '../core/api.js';
import { pickBuckets, normalizeContracts, bucket as getBucket, billingLabel, fmtDate, shortId, money, safeStr, splitLines, getLineImage, isShippingProtectionLine } from '../core/utils.js';
import { SkeletonSubCard } from '../components/Skeleton.jsx';
import Pill from '../components/Pill.jsx';
import { DunningBadge } from '../components/DunningBanner.jsx';

function getStatusFromUrl() {
  const p = new URLSearchParams(window.location.search);
  const s = (p.get('status') || 'active').toLowerCase();
  return ['active', 'paused', 'cancelled'].includes(s) ? s : 'active';
}

function statusFromContract(contract) {
  const b = getBucket(contract);
  if (b === 'cancelled') return { kind: 'cancelled', text: 'Cancelled' };
  if (b === 'paused') return { kind: 'paused', text: 'Paused' };
  if (b === 'active') return { kind: 'active', text: 'Active' };
  return { kind: 'neutral', text: contract?.status || 'Unknown' };
}

function billingMeta(contract) {
  const b = getBucket(contract);
  if (b === 'paused') {
    const resumeAt = contract?.pause_resume_at ? fmtDate(contract.pause_resume_at) : '';
    if (resumeAt) return 'Paused until ' + resumeAt;
    const until = contract?.nextBillingDate ? fmtDate(contract.nextBillingDate) : '';
    return until ? 'Paused until ' + until : 'Paused';
  }
  const label = billingLabel(contract?.billingPolicy) || 'Billing schedule';
  const next = contract?.nextBillingDate ? fmtDate(contract.nextBillingDate) : '';
  return next ? label + ' \u2022 Next: ' + next : label;
}

function SubscriptionCard({ contract }) {
  const { router } = useContext(PortalContext);
  const st = statusFromContract(contract);
  const { lines, shipLine } = splitLines(contract);
  const needsAttention = !!contract?.portalState?.needsAttention;
  const recoveryStatus = contract?.portalState?.recoveryStatus;
  const showDunning = recoveryStatus === 'in_recovery' || recoveryStatus === 'failed';
  const isLinked = !!contract?.portalState?.isLinkedAccount;

  const detailHref = router.base + '/subscription?id=' + encodeURIComponent(shortId(contract?.id));

  return (
    <div class="sp-card sp-subcard">
      {needsAttention && (
        <div class="sp-alert sp-alert--danger">
          <div class="sp-alert__title">Action needed</div>
          <div class="sp-alert__body">{safeStr(contract?.portalState?.attentionMessage) || 'Action needed: payment failed'}</div>
        </div>
      )}
      {contract?.crisisBanner && (
        <div class="sp-alert sp-alert--crisis">
          <div class="sp-alert__body">{contract.crisisBanner.message}</div>
        </div>
      )}
      <div class="sp-subcard__header sp-row">
        <div class="sp-subcard__header-left">
          <div class="sp-subcard__title">
            Superfoods
            {isLinked && <span class="sp-subcard__linked-label sp-muted">Linked account</span>}
          </div>
          <div class="sp-subcard__meta sp-muted">{billingMeta(contract)}</div>
        </div>
        <div class="sp-subcard__pills">
          <Pill kind={st.kind}>{st.text}</Pill>
          {showDunning && <DunningBadge />}
        </div>
      </div>
      <div class="sp-subcard__lines">
        {!lines.length ? (
          <p class="sp-muted sp-subcard__empty">No items found on this subscription.</p>
        ) : (
          <>
            {lines.slice(0, 3).map((ln, i) => (
              <div key={i} class="sp-line">
                {getLineImage(ln) && (
                  <img class="sp-line__img" src={getLineImage(ln)} alt={safeStr(ln.title) || 'Item'} />
                )}
                <div class="sp-line__meta">
                  <div class="sp-line__title">{safeStr(ln.title) || 'Item'}</div>
                  <div class="sp-line__subwrap sp-muted">
                    {ln.variantTitle && <div class="sp-line__variant">{safeStr(ln.variantTitle)}</div>}
                    <div class="sp-line__qty">Qty {ln.quantity || 1}</div>
                  </div>
                </div>
                <div class="sp-line__price">{ln.currentPrice ? money(ln.currentPrice) : ''}</div>
              </div>
            ))}
            {lines.length > 3 && (
              <div class="sp-subcard__more sp-muted">
                + {lines.length - 3} other {lines.length - 3 === 1 ? 'item' : 'items'}
              </div>
            )}
          </>
        )}
      </div>
      <div class="sp-subcard__actions">
        <a class="sp-btn" href={detailHref}
          onClick={(e) => { e.preventDefault(); router.navigate(detailHref); }}>
          View details
        </a>
        {shipLine && (
          <div class="sp-shipprot">
            {getLineImage(shipLine)
              ? <img class="sp-shipprot__img" src={getLineImage(shipLine)} alt="Shipping Protection" />
              : <div class="sp-shipprot__img sp-shipprot__img--placeholder" />
            }
            <div class="sp-shipprot__text">
              <div class="sp-shipprot__title">Shipping Protection</div>
              <div class="sp-shipprot__sub sp-muted">Orders are protected from loss or theft during shipping</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Subscriptions() {
  const { router } = useContext(PortalContext);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState(getStatusFromUrl);

  useEffect(() => {
    requestJson('subscriptions', {}, { force: true })
      .then(d => setData(d))
      .catch(() => setError(true));
  }, []);

  if (error || (data && !data.ok)) {
    return (
      <div class="sp-wrap sp-grid">
        <div class="sp-card">
          <h2 class="sp-title">Could not load subscriptions</h2>
          <p class="sp-muted">Please refresh. If this keeps happening, contact support.</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div class="sp-wrap">
        <div class="sp-card sp-subs-header">
          <div class="sp-skeleton-line" style={{ width: '200px', height: '32px' }} />
        </div>
        <div class="sp-grid sp-subs-list">
          <SkeletonSubCard />
          <SkeletonSubCard />
        </div>
      </div>
    );
  }

  const buckets = pickBuckets(data);
  const contracts = status === 'paused' ? buckets.paused : status === 'cancelled' ? buckets.cancelled : buckets.active;

  function switchTab(tab) {
    const href = router.base + '/subscriptions?status=' + tab;
    router.navigate(href);
    setStatus(tab);
  }

  return (
    <div class="sp-wrap">
      <div class="sp-card sp-subs-header">
        <div class="sp-subs-header__tabs">
          <div class="sp-tabs">
            {['active', 'paused', 'cancelled'].map(tab => (
              <a key={tab}
                class={'sp-tab' + (status === tab ? ' is-active' : '')}
                href={router.base + '/subscriptions?status=' + tab}
                onClick={(e) => { e.preventDefault(); switchTab(tab); }}>
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </a>
            ))}
          </div>
        </div>
      </div>
      <div class="sp-grid sp-subs-list">
        {!contracts.length ? (
          <div class="sp-card">
            <div class="sp-empty-title">No subscriptions found</div>
            <p class="sp-muted sp-empty-sub">
              {status === 'cancelled' ? "You don\u2019t have any cancelled subscriptions."
                : status === 'paused' ? "You don\u2019t have any paused subscriptions."
                : "You don\u2019t have any active subscriptions."}
            </p>
          </div>
        ) : contracts.map(c => (
          <SubscriptionCard key={shortId(c.id)} contract={c} />
        ))}
      </div>
    </div>
  );
}
