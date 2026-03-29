// cards/RewardsCard.jsx — Smile.io rewards integration

export default function RewardsCard() {
  function openRewards() {
    try {
      if (window.SmileUI?.openPanel) { window.SmileUI.openPanel(); return; }
    } catch {}
    window.location.href = 'https://superfoodscompany.com/pages/rewards';
  }

  return (
    <div class="sp-card sp-detail__card sp-rewards">
      <div class="sp-detail__sectionhead">
        <div class="sp-title2">Rewards</div>
        <p class="sp-muted sp-detail__section-sub">Your points and perks.</p>
      </div>
      <div class="sp-rewards__banner">
        <div class="sp-rewards__banner-icon" aria-hidden="true">{'\u2728'}</div>
        <div class="sp-rewards__banner-text">
          <div class="sp-rewards__banner-title">You've got rewards waiting</div>
          <div class="sp-rewards__banner-sub sp-muted">
            Redeem points for coupons and apply them to your subscription.
          </div>
        </div>
        <div class="sp-rewards__pill">Save on your next order</div>
      </div>
      <div class="sp-detail__actions sp-detail__actions--stack sp-rewards__actions">
        <button type="button" class="sp-btn sp-btn--primary sp-rewards__cta" onClick={openRewards}>
          {'\uD83C\uDF89'} View My Points
        </button>
        <div class="sp-rewards__helper sp-muted">
          Tip: applying a coupon here can reduce your next subscription charge instantly.
        </div>
      </div>
    </div>
  );
}
