# Storefront: survey chapter + converter-first PDP reorder

**Goal:** lift PDP engagement and price-step conversion by (1) making the lead-capture **survey a visible PDP chapter** (instead of a popup variant that never fires), (2) **reordering chapters converter-first** so the content that drives people to pricing comes before attention decays, and (3) relocating low-reach detail chapters **below the price table** as opt-in "learn more" content (not cut). Plus the analytics to measure it.

Phase legend: ⏳ planned · 🚧 in progress · ✅ shipped

**Status (2026-06-15): all phases shipped.** Pending fold into [[../lifecycles/storefront-checkout]] + [[../libraries/popup-decide]] (then delete this spec, per [[../project-management]]). New file: `src/app/(storefront)/_sections/SurveyChapter.tsx`; new route: `src/app/api/popup/offer/route.ts`.

---

## Why (the data, audited 2026-06-15)

Storefront launched 2026-06-11; numbers are directional (~4 days, 646 PDP views, 4 orders). Re-validate the cliffs before/after each change.

- **Money drop-off: engaged → pack_selected = 340 → 18 (5.3%).** People engage but won't pick a price.
- **Pricing chapter: 124 reach, 27.8s dwell (longest on page), only 18 select** — intense price hesitation. The discount popup correctly fires here.
- **Hero → first content chapter: ~70% cliff (568 → 167).** Most leave right after the hero.
- **Top price-drivers:** why-this-works (19.2% view→pricing), ingredients (17.1%). **UGC** holds attention (18.3s dwell) but barely sells (2.1%). Middle chapters (comparison/endorsement/expect) get low reach + ~2s skim.
- **The quiz popup is structurally dead** (3 shows ever): the client fires + locks the decision on the first *discount*-level signal (`price_dwell ≥ 15s`, `tab_away_return`, 3 reversals), so the stricter quiz thresholds (`rage_clicks ≥ 2` or `25s + 4 reversals`) never accumulate. Moving the survey to a chapter sidesteps this entirely and finally captures zero-party data (currently 0 quiz leads, 0 survey answers stored).

---

## Phase 1 — Popup funnel dashboard panel ✅ (built, pending commit)

Done in this session. `/dashboard/storefront/funnel` now has a **Lead-capture popup** panel: shown → engaged → email(step 1) → phone(step 2), split by variant (Offer/Survey) with per-step %, via `/api/workspaces/[id]/storefront-funnel` joining [[../tables/popup_decisions]] + [[../tables/storefront_leads]]. (Commit separately from the build below.)

## Phase 2 — Converter-first chapter reorder ✅

Edit the standard-PDP branch of `src/app/(storefront)/_lib/render-page.tsx` (the `!advertorial` block). Keep every section — **relocate, don't delete**. Leave the advertorial / before-after layout modes unchanged.

**New order:**
```
Hero
SurveyChapter            ← NEW (Phase 3)
HowItWorks (why-this-works)   ← converter, moved up
Ingredients                   ← converter, moved up
UpsellChapter (if configured)
PriceTableSection         ← price table
BundlePriceTableSection
── "Learn more" zone (below price) ──
UGCSection                ← high dwell, low price-intent → reinforce after price
ComparisonSection         ← was low-reach middle; now opt-in below price
NutritionistEndorsementSection (endorsement)   ← below price
WhatToExpectTimeline (expect)                   ← below price
ReviewsSection
FAQSection
FinalCTASection
BrandTrustSection
```

Rationale: front-load the two chapters that actually drive to pricing; get price in view sooner; keep the detail/social-proof chapters for shoppers who scroll past price wanting more (Dylan's call — don't cut them). `chapter_index` is DOM order via `StorefrontChapterTracker`, so reordering JSX automatically re-sequences the analytics; no tracker change needed.

**Acceptance:** PDP renders in the new order; `chapter_view`/`chapter_dwell` events show the new indices; advertorial modes untouched; `npx tsc --noEmit` clean.

## Phase 3 — Survey as a visible chapter ✅

New section `src/app/(storefront)/_sections/SurveyChapter.tsx`, rendered after the hero (Phase 2), `data-section="survey"` (so chapter tracking works for free).

- **UI:** reuse the `SurveyStep` pattern from `SmartPopup.tsx` (cups/day + health goal from `data.benefit_selections`). Inline, not a modal.
- **On completion:** show a **personalized recommendation** — **framing copy only** (decided: no `health_goal → product/pack` mapping). Reflect the customer's answers back in encouraging copy, then a primary CTA **"Unlock my code →"**.
- **Coupon is gated (decided):** the customer **must provide email OR phone** to reveal/deliver the signup code — no free reveal. Reuse `/api/lead` (email) + `/api/popup/claim` (phone) with **`source: "survey_chapter"`** (new source, distinct from `popup_quiz`/`popup_discount`). At least one contact required; once captured, reveal the code and scroll to the price table (`#pricing`). Implementation note: the existing flow mints the coupon at the email step and delivers via SMS / 5-min email fallback — to honor "email **or** phone," allow a phone-first unlock too (mint + SMS without an email). The build decides the exact mint trigger; the invariant is *no contact → no code*.
- **Persist answers immediately on completion** (not only at contact capture — that's the current blind spot): fire a pixel event `survey_completed` with answers in `meta` (no PII), and keep passing `quiz_answers` to `/api/lead` if they continue to email.
- **On every PDP (decided):** render in the standard-PDP branch for all products. Advertorial / before-after landers keep their own flow (out of scope here).
- **Mobile-first**, matches storefront theming (`--storefront-primary`).

**Acceptance:** survey renders as a chapter after the hero on every standard PDP; completing it persists answers (queryable in `storefront_events`); the code is **only** revealed/delivered after email or phone is captured; that capture writes a `storefront_leads` row with `source='survey_chapter'`; then scrolls to price; tsc clean.

## Phase 4 — Survey chapter analytics ✅

Add pixel events: `survey_shown` (or reuse `chapter_view` for `data-section="survey"`), `survey_started`, `survey_completed`. Surface a small **Survey chapter** block on the funnel dashboard: shown → started → completed → (email → phone via `source='survey_chapter'`), with %. Extend `/api/workspaces/[id]/storefront-funnel` to compute it from `storefront_events` + `storefront_leads`. This closes the "survey drop-off invisible" gap from the audit.

**Acceptance:** dashboard shows survey completion rate + lead conversion for `source='survey_chapter'`.

## Phase 5 — Retire/contain the popup quiz variant ✅

With the survey now a chapter, the popup-quiz variant in `src/lib/popup/decide.ts` is redundant (and dead). Either remove the `quiz` branches from `decideByRules`/`challengeWithHaiku` (popup becomes discount-only — its real job is the price-moment intervention), or leave them (they almost never fire). Recommended: simplify to discount-only and note the survey moved to a chapter. Update `SmartPopup.tsx` if the `quiz` variant is removed.

**Acceptance:** decide if removing; if removed, popup still fires discount correctly and tsc is clean.

---

## Files touched

| File | Phase | Change |
|---|---|---|
| `src/app/api/workspaces/[id]/storefront-funnel/route.ts` | 1,4 | popup funnel (done); survey-chapter funnel |
| `src/app/dashboard/storefront/funnel/page.tsx` | 1,4 | popup panel (done); survey block |
| `src/app/(storefront)/_lib/render-page.tsx` | 2,3 | reorder standard PDP; insert SurveyChapter after hero |
| `src/app/(storefront)/_sections/SurveyChapter.tsx` | 3 | NEW — inline survey + recommendation + scroll-to-price |
| `src/app/api/lead/route.ts` | 3 | accept `source='survey_chapter'`; persist answers on completion |
| `src/lib/storefront-pixel.ts` | 3,4 | `survey_shown/started/completed` events |
| `src/lib/popup/decide.ts` · `SmartPopup.tsx` | 5 | optional: drop quiz variant |

## Decisions (settled with Dylan 2026-06-15)

- **Gate the coupon:** yes — the code is only revealed/delivered after the customer gives **email or phone**. No free reveal.
- **Recommendation:** **framing copy only** — no `health_goal → product/pack` mapping.
- **Placement:** **every standard PDP** (after the hero). Advertorial/before-after landers keep their own flow.

## Open questions

- Phone-first unlock vs. email-required: the existing mint flow keys on the email step. Honoring "email **or** phone" may need a small tweak to allow minting on a phone-only capture (see Phase 3 note). The build decides the exact trigger; invariant = no contact → no code.

## Related

[[../tables/popup_decisions]] · [[../tables/storefront_leads]] · [[../tables/storefront_sessions]] · [[../libraries/popup-decide]] · [[../lifecycles/storefront-checkout]]
