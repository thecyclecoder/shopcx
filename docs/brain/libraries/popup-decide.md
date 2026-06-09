# libraries/popup-decide + popup-offer

The smart-popup decision engine + offer computation (storefront-mvp Phase 4).

**Files:** `src/lib/popup/decide.ts`, `src/lib/popup/offer.ts`

## decide.ts

| Export | Purpose |
|---|---|
| `disqualifyReason(t)` | The candidacy gate (4a) — cheap, no AI. Returns a reason when the visitor is disqualified (bot, already selecting, already shown, returning subscriber, dwell < 20s, no engagement), else null. |
| `decideByRules(t)` | Deterministic decision. Quiz triggers (rage taps, long-compare-no-select) checked before discount triggers (cta-to-price-no-select = highest confidence, customize-then-back, price-dwell, price-yoyo, tab-away-return). Returns `{ show, variant, reason, decided_by:"rules" }`. |
| `challengeWithHaiku(t)` | The A/B challenger — Haiku classifies the hesitation type from the raw timeline. Fails CLOSED to null (→ caller uses rules) on timeout/error/missing key. |

`PopupTimeline` is the session-signal payload the client builds (dwell, scroll reversals, price dwell, scroll-to-price clicks, customize-back, tab-away, rage clicks, pack_selected, bot, already_shown, returning_sub).

**Budget** is enforced by `/api/popup/decide`, not here: one decision per session (the [[../tables/popup_decisions]] unique key), Haiku only on a stable per-session A/B split within a daily cap.

## offer.ts — `computePopupOffer(workspaceId, productId)`

Computes the **full stacked value** live from [[../tables/product_pricing_tiers]] + [[../tables/pricing_rules]]:
- price discount = quantity-break × subscribe-and-save × the 15% signup coupon (`POPUP_COUPON_PCT`), applied **multiplicatively** (≈44% off product MSRP — adding them overstates at 52%);
- + free shipping (representative waived rate — no address at popup time);
- + free gift (the product's `free_gift_variant_id` MSRP).

Returns `{ effective_pct (off the full retail bundle), total_savings_cents, product_discount_cents, shipping_value_cents, gift_value_cents, gift_title, pack_quantity, … }`. Null when the product has no pricing tiers.

## Flow

`SmartPopup` (client) → `/api/popup/decide` (rules + Haiku + offer, logs [[../tables/popup_decisions]]) → render → `/api/lead` (email step, mints the coupon via [[coupons]], arms [[../inngest/popup-coupon-fallback]]) → `/api/popup/claim` (phone step: [[twilio-lookup]] gates mobile, SMS the code, auto-apply cookie).

---

[[../README]] · [[../lifecycles/storefront-checkout]] · [[../tables/popup_decisions]] · [[../libraries/coupons]] · [[../libraries/twilio-lookup]] · [[../inngest/popup-coupon-fallback]] · [[../../CLAUDE]]
