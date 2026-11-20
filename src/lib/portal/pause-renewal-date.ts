// Pure helper: where does a portal "pause N days" land the next renewal?
//
// The portal pause used to anchor the resume date to TODAY (today + pauseDays), so a customer
// whose next renewal was weeks away saw a "pause" that barely moved their charge — and auto-resume
// then re-derived the date off the cycle grid, so the real pause length never matched what the
// portal showed (Laura Light, ticket b74b5a1c). The pause now counts from the next renewal:
// base = max(next renewal, today), then + pauseDays. A customer who picks "60 days" gets exactly
// 60 days added to the order they were actually waiting on.
export function computePausedRenewalDate(
  nextBillingDate: string | null,
  pauseDays: number,
  now: Date,
): string {
  const nextMs = nextBillingDate ? new Date(nextBillingDate).getTime() : NaN;
  // base = max(nextBillingDate, now): a future renewal anchors the pause; a past/missing one
  // falls back to today so the pause is still the full length the customer chose.
  const base =
    !Number.isNaN(nextMs) && nextMs > now.getTime() ? new Date(nextMs) : new Date(now.getTime());
  base.setUTCDate(base.getUTCDate() + pauseDays);
  return base.toISOString();
}
