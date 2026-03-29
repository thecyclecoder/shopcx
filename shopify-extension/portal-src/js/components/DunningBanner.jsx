// components/DunningBanner.jsx — Payment recovery awareness

export function DunningBadge() {
  return <span class="sp-pill sp-pill--dunning">Payment Issue</span>;
}

export function DunningBanner({ dunning }) {
  if (!dunning) return null;

  if (dunning.recovered) {
    return (
      <div class="sp-dunning-banner sp-dunning-banner--recovered">
        <div class="sp-dunning-banner__icon">{'\u2713'}</div>
        <div class="sp-dunning-banner__text">
          <div class="sp-dunning-banner__title">Payment recovered</div>
          <div class="sp-dunning-banner__sub sp-muted">Your payment has been successfully processed.</div>
        </div>
      </div>
    );
  }

  const message = dunning.recovery_failed
    ? "We couldn\u2019t process your recent payment. Please update your payment method to keep your subscription active."
    : "We\u2019re working on your payment. You can also update your payment method.";

  return (
    <div class="sp-dunning-banner">
      <div class="sp-dunning-banner__icon">{'\u26A0'}</div>
      <div class="sp-dunning-banner__text">
        <div class="sp-dunning-banner__title">Payment issue</div>
        <div class="sp-dunning-banner__sub sp-muted">{message}</div>
      </div>
      {dunning.payment_update_url && (
        <a class="sp-btn sp-btn-primary sp-dunning-banner__btn" href={dunning.payment_update_url} target="_blank" rel="noopener noreferrer">
          Update Payment Method
        </a>
      )}
    </div>
  );
}
