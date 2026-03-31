// cards/RewardsCard.jsx — Interactive loyalty widget
// Shows points balance, redemption tiers, and unused loyalty coupons
import { useState, useEffect, useContext } from 'preact/hooks';
import { PortalContext } from '../App.jsx';
import { requestJson, postJson, clearCaches } from '../core/api.js';

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso));
  } catch { return ''; }
}

function StatusBadge({ status }) {
  if (status === 'active') {
    return <span class="sp-loyalty__badge sp-loyalty__badge--active">Ready to use</span>;
  }
  if (status === 'applied') {
    return <span class="sp-loyalty__badge sp-loyalty__badge--applied">Applied to subscription</span>;
  }
  return null;
}

export default function RewardsCard({ contractId, onCouponApplied, hideRedeem, showRedeemOverride }) {
  const { showToast } = useContext(PortalContext);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // tier index or 'redeem-{id}'

  useEffect(() => {
    requestJson('loyaltyBalance', {}, { force: true })
      .then(resp => {
        if (resp?.ok && resp?.enabled) setData(resp);
        else if (resp && !resp.enabled) console.log('[RewardsCard] loyalty not enabled for this workspace');
      })
      .catch(err => console.error('[RewardsCard] failed to load loyalty balance:', err?.status, err?.details || err?.message))
      .finally(() => setLoading(false));
  }, []);

  async function redeemTier(tierIndex) {
    setBusy(tierIndex);
    try {
      const resp = await postJson('loyaltyRedeem', { tierId: tierIndex });
      if (resp?.ok) {
        showToast(`Coupon ${resp.code} created! $${resp.discount_value} off.`, 'success');
        // Refresh balance
        const fresh = await requestJson('loyaltyBalance', {}, { force: true });
        if (fresh?.ok && fresh?.enabled) setData(fresh);
      } else {
        showToast(resp?.error || 'Could not redeem.', 'error');
      }
    } catch (e) {
      showToast(e?.message || 'Redemption failed.', 'error');
    }
    setBusy(null);
  }

  if (loading || !data) return null;

  const { points_balance, dollar_value, tiers, unused_coupons } = data;
  const hasCoupons = unused_coupons?.length > 0;

  const showRedeem = showRedeemOverride || !hideRedeem;

  return (
    <div class="sp-card sp-detail__card sp-rewards">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Rewards</div>
        <p class="sp-muted sp-detail__section-sub">Your points and perks.</p>
      </div>

      {/* Premium banner */}
      <div class="sp-rewards__banner">
        <div class="sp-rewards__banner-icon">&#127873;</div>
        <div>
          <div class="sp-rewards__banner-title">
            You have <strong>{points_balance.toLocaleString()}</strong> reward points
          </div>
          {dollar_value > 0 && (
            <div class="sp-rewards__banner-sub sp-muted">
              That's worth <strong>${dollar_value.toFixed(2)}</strong> in rewards
            </div>
          )}
        </div>
        {dollar_value > 0 && (
          <div class="sp-rewards__pill">${dollar_value.toFixed(0)} value</div>
        )}
      </div>

      {/* Redemption tiers */}
      {showRedeem && tiers?.length > 0 && (
        <div class="sp-loyalty__tiers">
          <div class="sp-loyalty__tiers-title">Redeem your points</div>
          <div class="sp-loyalty__tier-list">
            {tiers.map((t, i) => (
              <button key={i} type="button"
                class={'sp-loyalty__tier' + (t.affordable ? ' sp-loyalty__tier--premium' : ' sp-loyalty__tier--disabled')}
                disabled={!t.affordable || busy != null}
                onClick={() => redeemTier(t.index)}>
                <div class="sp-loyalty__tier-label">{t.label}</div>
                <div class="sp-loyalty__tier-cost">
                  {t.affordable
                    ? `${t.points_cost.toLocaleString()} pts`
                    : `Need ${t.points_needed.toLocaleString()} more`}
                </div>
                {busy === t.index && <div class="sp-loyalty__tier-busy">Redeeming\u2026</div>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Unused coupons */}
      {hasCoupons && (
        <div class="sp-loyalty__coupons">
          <div class="sp-loyalty__coupons-title">Your coupons</div>
          {unused_coupons.map(c => (
            <div key={c.id} class="sp-loyalty__coupon-row">
              <div class="sp-loyalty__coupon-info">
                <span class="sp-loyalty__coupon-code" title={c.code}>{c.code}</span>
                <span class="sp-loyalty__coupon-val">${Number(c.discount_value).toFixed(0)} off</span>
              </div>
              <div class="sp-loyalty__coupon-meta">
                <StatusBadge status={c.status} />
                {c.expires_at && <span class="sp-loyalty__coupon-exp sp-muted">Exp {fmtDate(c.expires_at)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
