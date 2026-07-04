---
name: sms-marketing
description: Use to plan, draft, and launch an SMS marketing blast in ShopCX — the end-to-end operator playbook for a promotional text send over the sms_campaigns pipeline (Twilio). Covers which segments actually convert (our OWN sends, not Klaviyo), the per-segment single-campaign pattern, the required message shape (block layout, CTA-link-in-the-middle, manufactured urgency, GSM-7 under 160 incl. the per-recipient shortlink), pre-existing Shopify coupon wiring, the superfd.co/{slug}/{short_code} attributed shortlink, and the mandatory pre-send segment-freshness check. Triggered by "send an SMS blast / marketing text", "launch the {sale} campaign", or drafting promo copy for a text send. NOT transactional/journey texts (that's journey-delivery) and NOT the crisis campaign (that's crisis-campaign).
---

# sms-marketing

The operator playbook for a promotional SMS blast. The machinery already exists — this skill is the *procedure + invariants* so a campaign goes out correctly every time without re-deriving them. Read the brain first: [[../../docs/brain/sms-segment-performance]] · [[../../docs/brain/inngest/marketing-text]] · [[../../docs/brain/tables/sms_campaigns]] · [[../../docs/brain/inngest/refresh-customer-segments]].

**Sending a blast texts tens of thousands of real customers — it is outward-facing and irreversible. Draft autonomously; get an explicit human go-ahead before the final `schedule` action.**

## The operator handoff (what the founder gives you → what you give back)

The founder hands you a compact brief and you run the flow. He should never have to spell out segments or copy — that's your job.

**He gives you (example):** "The coupon is `JULY4THVIP` (Shopify code). Destination: `https://superfoodscompany.com/discount/JULY4THVIP?redirect=/collections/july4thearlyaccess`. Promo is 'up to 60% off'. Send at 9am July 4th in customer local time."

**You give back, in one message, for approval:**
1. **All segments, ranked by CVR / success likelihood** — the full table (from [references/segment-playbook.md](references/segment-playbook.md)), each flagged **✅ recommend / ➖ optional / ❌ skip**, with a one-line why. Recommend the high rev/send buckets + `deep_lapsed` for volume; skip `cold` and (usually) exclude `active_sub`.
2. **A per-segment message draft** for every recommended segment — block layout, CTA + `{shortlink}` in the middle, urgency last, GSM-7, stored ≤140 chars, promo phrase woven in. Show a rendered char estimate (+~20 for the shortlink expansion).
3. **The config you'll write** — `coupon_enabled=false`, the `/discount/{CODE}` shortlink target, `send_date`, `target_local_hour`, timezone fallback — and any freshness/timing caveat (did the segment refresh finish? is 9am-local still reachable given the current time?).

**He approves (possibly editing segments/copy), then you schedule** — one single-segment campaign per approved segment. Get the explicit approval before the `schedule` action; the send is outward-facing and irreversible.

## How the pipeline works (one paragraph)

A row in `public.sms_campaigns` holds the body + audience + coupon + shortlink config. Hitting **Schedule** fires `marketing/text-campaign.scheduled` → [[../../docs/brain/inngest/marketing-text]] resolves the audience, reserves a per-campaign shortlink slug, (optionally) mints a coupon, and stages `sms_campaign_recipients`. A 1-min cron (`marketing-text-campaign-send-tick`) sends each recipient at their local `target_local_hour` via Twilio, expanding `{shortlink}` and `{coupon}` per recipient. Audience = customers with `sms_marketing_status='subscribed'`, a non-null phone, `phone_status` null/`good`, matching **≥1 Include segment AND none of the Exclude segments**; bad phones and anyone texted in the last 12h are dropped automatically. UI: `/dashboard/marketing/text/new`.

## Procedure

### 1. ⚠️ Refresh segments FIRST — never trust the daily cron blindly

Sends target `customers.segments`. **The daily refresh cron has a history of silently under-covering the book** (it once sent SUMMERFIT on a 15-day-old snapshot; see [[../../docs/brain/inngest/refresh-customer-segments]] and the `fix-segment-refresh-coverage` spec). **Before every campaign**, run the manual escape hatch (raw pg, no serverless/PostgREST cap) and confirm coverage:

```bash
npx tsx scripts/refresh-customer-segments.ts        # default scope = SMS-subscribed (the marketing audience)
```

Then verify freshness (the authoritative column is `segments_refreshed_at`, NOT `updated_at`):

```ts
// ≥99% of subscribable customers should have segments_refreshed_at within the last day.
// A large tail older than ~48h means the refresh didn't cover the book — re-run before sending.
```

Probe `segments_refreshed_at` by day (a healthy book is one fresh cohort, not a small cohort atop a stale tail).

### 2. Pick segments — one campaign per segment

**Always send single-segment campaigns** (`included_segments` = exactly one archetype). Two reasons: (a) it lets you tailor the hook per segment (step 4), and (b) per-segment CVR is only measurable because campaign = segment ([[../../docs/brain/sms-segment-performance]] attribution). Default `excluded_segments = ["active_sub"]` unless you're deliberately texting subscribers. To exclude prior-buyers of *this* sale, add a synthetic exclude tag (e.g. `mdw_buyer`) — see how past sends used `mdw_2026_buyer`.

Which segments earn a send (our OWN Twilio sends, n=42 orders — directional). Full table + copy bank in [references/segment-playbook.md](references/segment-playbook.md):

| Segment | Rev/send | Read |
|---|---|---|
| `cycle_hitter` | **$0.41** | top rev/send — at reorder window |
| `lapsed` | $0.37 | beats its Klaviyo reputation (0.10%) — don't under-weight |
| `engaged` | $0.35 | recent click/ATC/checkout |
| `just_ordered` | $0.21 | weak — usually skip or soft ask |
| `deep_lapsed` | $0.11 | low rate, huge volume → biggest TOTAL revenue |
| `single_order` | $0.03 | weakest converter |
| `storefront_signup` | new | warm opt-ins, no order yet |
| `cold` | ~0 | 127K of the 138K book — Klaviyo ~0.003%, spam tax. Don't blast. |

### 3. Wire the coupon + shortlink (pre-existing Shopify code)

For a code that already exists in Shopify (e.g. **`JULY4THVIP`**) you do **not** mint one. Set:

- `coupon_enabled = false` (nothing new is minted)
- `shortlink_target_url = https://superfoodscompany.com/discount/JULY4THVIP?redirect=/collections/<sale-collection>`

The scheduler auto-parses the code out of the `/discount/{CODE}` target and persists it to `sms_campaigns.coupon_code` so revenue attributes by coupon match ([[../../docs/brain/inngest/marketing-text]], `marketing-text.ts` "persist-shortlink-coupon"). The customer taps the link → lands on the store with the discount already applied. **This is the exact pattern every recent sale used** (FOUNDERVIP, SUMMERFIT, BIGMDW26 — all `coupon_enabled=false`, code in the `/discount/` target).

> **Gotcha — `coupon_code` is not editable via the API/UI** (`EDITABLE_DRAFT_FIELDS` omits it). It's set automatically from the shortlink target at schedule time. If you must record it before schedule, write it directly with a `scripts/_*.ts` admin update. Do NOT use `coupon_enabled=true` for a pre-existing code — that mints a second, unwanted Shopify discount.

### 4. Write the message — block layout, CTA link in the middle, urgency last

Composition is NON-NEGOTIABLE. See [references/segment-playbook.md](references/segment-playbook.md) for the per-segment copy bank.

**Shape** (never a word-blob — `\n\n` between blocks so it renders as clean stacked lines on the phone):

```
{hook — segment-specific, "you were chosen" energy}

{CTA label}
{shortlink}

{benefit-based signoff + urgency}
```

Real example (July 4th, `cycle_hitter`):
```
Happy 4th, time to restock!

Up to 60% off - grab your coupon:
{shortlink}

Shed lbs, feel great for summer! Only 39 left!
```

Rules:
- **Link is NEVER last.** It sits in the middle, built as a CTA (`Tap to claim:` / `Get Coupon:` / `tap for your code.`) immediately above/beside `{shortlink}`. The **urgency line is the last block.**
- **Always urgency, even if manufactured** — the two that work: a limited coupon count (`only 43 left!`, unverifiable by the customer) or a deadline (`ends midnight tonight!`, `1 day only`). Every send must have one.
- **Sign off with the benefit, not just the sale.** The last block pairs a benefit-based payoff with the urgency — for superfoods that's the weight/summer outcome (`Shed lbs, feel great for summer!`), not just "% off." Sell the result, then the deadline. Must still fit ≤160 rendered.
- **`{shortlink}`** expands per recipient to `https://superfd.co/{slug}/{short_code}` (~31 chars) — the trailing customer code is what makes clicks per-user attributable. Never write a bare link; always use the `{shortlink}` token.
- **GSM-7 only** — straight `'`, no emoji, curly quotes, or em-dashes. One non-GSM-7 char drops the segment limit from 160 → 70 and doubles cost.
- **Under 160 chars rendered.** ⚠️ The UI char counter counts the literal token `{shortlink}` (11 chars) but it renders as ~31 → **budget +20 chars**. Keep the **stored body ≤ 140 chars** to stay in one segment. (Recent sends: 105–137 stored.)
- **Only `{shortlink}` and `{coupon}` are substituted.** `{first_name}` and any other merge tag render **literally** — do not use them.

### 5. Draft the row, preview audience, then (gated) schedule

Create via the UI (`/dashboard/marketing/text/new`) or POST `/api/workspaces/{id}/sms-campaigns`. Always **Preview audience size** before scheduling (`action: "preview_audience"`) — a sanity check on the segment counts. Set `send_date`, `target_local_hour` (recipient-local; 9–11 typical), fallback hour + timezone (`America/Chicago`).

**Get explicit go-ahead, then** POST `action: "schedule"`. Monitor at `/dashboard/marketing/text/{id}` — status breakdown, shortlink clicks, attributed conversions.

### 6. After the send — recompute performance

Once orders land, recompute per-segment CVR and update [[../../docs/brain/sms-segment-performance]] (the recipe is in that page's "How it's computed" section). This keeps the segment guidance honest for the next blast.

## Pre-send checklist

- [ ] `scripts/refresh-customer-segments.ts` ran; `segments_refreshed_at` fresh for ≥99% of the book
- [ ] One segment per campaign; `active_sub` excluded (unless targeting subs); this-sale buyers excluded
- [ ] `coupon_enabled=false`; code lives in the `/discount/{CODE}` shortlink target
- [ ] Body: block layout (`\n\n`), CTA + `{shortlink}` in the middle, urgency line last
- [ ] GSM-7 only; stored body ≤ 140 chars (rendered ≤ 160, one segment)
- [ ] No `{first_name}` or other unsupported merge tags
- [ ] Audience previewed; send hour/timezone set
- [ ] **Explicit human go-ahead before `schedule`**

## The autonomous agent (Margo, under Iris/CMO)

This whole flow is also automated by **Margo**, the SMS marketing agent — a dormant cadence engine that picks a theme (VIP / Weekend), builds per-segment campaigns from the DB-driven template library, and schedules 1-2 sends/week within a bounded policy. It ships **dormant** (`sms_marketing_policy.active=false`, placeholder theme codes). To go live: set real Shopify codes + collections in `theme_config`, then flip `active=true` (+ `function_autonomy('cmo')` live) via [[../../docs/brain/libraries/sms-marketing-policy-authoring]]. It enforces the SAME invariants this skill documents (single-segment, block layout, GSM-7 ≤160, segment-freshness rail, `coupon_enabled=false` + code-in-target) and escalates to Iris on a stale book or missing coupon. See [[../../docs/brain/inngest/sms-marketing]] · [[../../docs/brain/tables/sms_marketing_policy]]. Use this skill for a **one-off / manual** blast; the agent is the **recurring cadence**.

## Related

[[../../docs/brain/sms-segment-performance]] · [[../../docs/brain/inngest/marketing-text]] · [[../../docs/brain/inngest/refresh-customer-segments]] · [[../../docs/brain/inngest/sms-wave-promote]] · [[../../docs/brain/tables/sms_campaigns]] · [[../../docs/brain/tables/sms_campaign_recipients]] · [[../../docs/brain/tables/marketing_shortlinks]] · [[../../docs/brain/libraries/marketing-coupons]] · [[probe-db]] · [[script-conventions]]
