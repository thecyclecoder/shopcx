# Segment playbook + copy bank

Canonical performance lives in [[../../../docs/brain/sms-segment-performance]] — recompute it after each send. This file is the operator's quick-reference: what each segment is, how it converts on OUR sends, and the proven per-segment hook.

## Per-segment performance (our own Twilio sends)

From 32 single-segment campaigns over 5 sale events (2026-05-16 → 05-31). **n = 42 attributed orders total — directional, not precise.** Only `deep_lapsed` / `single_order` have enough volume to trust the rate; the top three are a statistical tie.

| Segment | Sent | Click % | CVR | Rev/send | Definition |
|---|---:|---:|---:|---:|---|
| `cycle_hitter` | 2,449 | 22.0% | 0.33% | **$0.41** | Orders ≥2, at expected reorder window |
| `lapsed` | 1,441 | 26.6% | 0.35% | $0.37 | Orders ≥2, 1.5–3× past reorder gap |
| `engaged` | 1,727 | 43.4% | 0.35% | $0.35 | Orders ≥1 + recent click / ATC / checkout / 2× product-view |
| `just_ordered` | 1,473 | 26.7% | 0.14% | $0.21 | Orders ≥2, ordered recently vs cadence |
| `deep_lapsed` | 17,850 | 18.1% | 0.10% | $0.11 | Orders ≥2, >3× past reorder gap — low rate, **biggest total revenue** by volume |
| `single_order` | 6,178 | 20.5% | 0.05% | $0.03 | Exactly 1 prior order — weakest |
| `active_sub` | 927 | 32.3% | 0.11% | $0.17 | Has an active subscription. Default EXCLUDE on archetype sends (they're already on the best price), but a valid **deliberate INCLUDE** as its own campaign with a thank-you/loyalty hook. |
| `storefront_signup` | — | — | — | new | In `storefront_leads` — warm opt-in, often no order. First data: 2026-06-15 Founder's VIP |
| `cold` | — | — | — | ~0 | 0 orders (~127K of the book). Klaviyo ~0.003%. **Don't blast.** |

**Takeaways:** send `cycle_hitter` / `lapsed` / `engaged` first; include `deep_lapsed` for the volume revenue despite the rate; `single_order` only when marginal cost is trivial; never blast `cold`. Exclude `active_sub` (they already get the best price) unless the message is a subscriber-thank-you.

## Per-segment hook customization

The offer + CTA + urgency stay **identical** across segments in a sale; only the **hook line** changes to match the relationship. Proven hooks from the Memorial Day "Final" send (all shared: `62% OFF MSRP - tap for your code.` / `{shortlink}` / `Ends midnight!`):

| Segment | Hook line |
|---|---|
| `engaged` | `Superfoods: FINAL hours on our Memorial Day Sale.` |
| `cycle_hitter` | `Superfoods: Memorial Day Sale - last call to restock.` |
| `lapsed` | `Superfoods: come back - Memorial Day Sale ends tonight.` |
| `deep_lapsed` | `Superfoods: one last call - Memorial Day Sale ends tonight.` |
| `just_ordered` | `Superfoods: Memorial Day Sale ends tonight.` |
| `single_order` | `Superfoods: Memorial Day Sale - your last shot tonight.` |
| `active_sub` | `Superfoods VIPs: thanks for subscribing - sale ends tonight!` (+ closer `You got our biggest discount!`) |

Framing logic: loyalty/thanks for subs, `come back` for lapsed, `restock` for cycle_hitter, `your last/first shot` for single_order, `FINAL hours` urgency for the already-engaged.

## Message templates (block layout, link in the middle, urgency last)

All GSM-7, stored body ≤ 140 chars (`{shortlink}` renders ~31, so it fits under 160). `\n\n` = blank line between blocks.

**A — "you were chosen" + coupon-count urgency** (Founder's VIP):
```
OMG! You're specially picked for the biggest coupon in our Founder's VIP sale!

Tap to claim:
{shortlink}

Hurry, only 43 left!
```

**B — deadline urgency, compact** (SUMMERFIT):
```
Get summer-ready with our natural superfoods - 1 day only sale.

Get Coupon: {shortlink}

Only 43 coupons left!
```

**C — hook + offer + CTA + deadline** (BIG MDW):
```
{segment hook}
62% OFF MSRP - tap for your code.
{shortlink}

Ends midnight tonight!
```

**Urgency bank** (always include one; manufactured is fine, per founder):
- Limited coupons: `only 43 left!`, `Only 39 coupons left!`, `Hurry, almost gone!` (a count the customer can't verify)
- Deadline: `Ends midnight tonight!`, `1 day only`, `this weekend only`, `Expires 11:59PM tonight!`

## Benefit-based signoff (required)

The last block sells the **result**, not just the discount, then rides the urgency. For superfoods the payoff is weight/summer. Bank:
- `Shed lbs, feel great for summer! Only 39 left!`
- `Get summer-ready - ends tonight!`
- `Feel lighter by summer. Today only!`

Keep it ≤160 rendered — shorten the hook before the signoff if needed.

## July 4th worked example (JULY4THVIP · "up to 60% off" · early-access)

- `included_segments`: one per campaign — `cycle_hitter`, `lapsed`, `engaged`, `deep_lapsed`, `single_order`, and a dedicated `active_sub` (loyalty framing).
- `excluded_segments`: `["active_sub"]` on the 5 archetype campaigns (subscribers get their own send, no double-text) + a `july4th_buyer` tag once the sale starts converting. The `active_sub` campaign excludes nothing.
- `coupon_enabled`: `false` — code already exists in Shopify.
- `shortlink_target_url`: `https://superfoodscompany.com/discount/JULY4THVIP?redirect=/collections/july4thearlyaccess`
- Shared blocks: CTA `Up to 60% off - grab your coupon:` + `{shortlink}`; signoff `Shed lbs, feel great for summer! Only 39 left!`
- Per-segment hooks (≤45 chars so total stays ≤160 rendered):

  | Segment | Hook (block 1) |
  |---|---|
  | `cycle_hitter` | `Happy 4th, time to restock!` |
  | `lapsed` | `Happy 4th - come back and save!` |
  | `engaged` | `Happy 4th! You're in early access.` |
  | `deep_lapsed` | `Happy 4th, we miss you!` |
  | `single_order` | `Happy 4th! Ready for order #2?` |
  | `active_sub` | `Happy 4th, thanks for subscribing!` |

  Full body (cycle_hitter, ~122 stored → ~142 rendered):
  ```
  Happy 4th, time to restock!

  Up to 60% off - grab your coupon:
  {shortlink}

  Shed lbs, feel great for summer! Only 39 left!
  ```
