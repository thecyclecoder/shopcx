# ShopCX Commerce Independence
## Build Spec & Migration Playbook

**Superfoods Company — Confidential — April 2026**

- **Replaces:** Shopify · Appstle · Klaviyo · Gorgias · Siena AI
- **Stack:** Next.js · Vercel Edge · Supabase · Braintree · Avalara · Anthropic
- **Timeline:** 6 phases · ~6 months build · single cutover

---

## Executive Summary

Build everything on ShopCX while Shopify stays running. ShopCX already syncs all orders, customers, and subscription data continuously. When we cut over, the data is already there. The only migration is payment methods — a well-defined PCI-to-PCI export from Shopify Payments to Braintree taking 5-10 business days.

We are not rebuilding a store. We are unwrapping what we already have.

| | |
|---|---|
| Why leave Shopify | Data control, Shop Pay token lock-in, Subscription API requires Shopify approval, ~$3K/month for increasingly restrictive infrastructure |
| Payment strategy | Braintree (existing account, low chargeback history, supplement-friendly). Drop-in UI handles PCI — card data never hits our servers |
| Tax strategy | Avalara (existing account). Server-side calculation. Handles economic nexus automatically |
| Shop Pay risk | Identify % of subscribers on Shop Pay FIRST. Run payment update campaign 60 days before cutover. This is the only real migration risk |
| Speed target | LCP < 1.2s, CLS = 0, Lighthouse 95+. Achieved via Next.js SSG + Vercel Edge — not AMP |
| Data ownership | First-party pixel on pixel.superfoodscompany.com. All events owned. Server-side forwarding to Meta CAPI, Google, TikTok |

---

## Phase Overview

| Phase | What Ships | Timeline |
|---|---|---|
| Phase 1 | Product Intelligence Engine — ingredient research, review analysis, benefit selection, content generation | Weeks 1-3 |
| Phase 2 | Landing Page System — DB-driven template, 10 sections, benefit focus angles, floating bar, A/B testing | Weeks 3-6 |
| Phase 3 | First-Party Pixel + Event Clearinghouse — identity resolution, Meta CAPI, Google, TikTok fan-out | Weeks 5-8 |
| Phase 4 | Custom Checkout — Braintree Drop-in, Avalara tax, thank you page, order confirmation | Weeks 7-10 |
| Phase 5 | Native Subscription Manager — replacing Appstle, Braintree billing, customer portal, dunning | Weeks 9-14 |
| Phase 6 | Shopify Cutover — DNS switch, payment method migration, Shop Pay sunset, Shopify cancelled | Week 16+ |

---

## Phase 1 — Product Intelligence Engine
**Weeks 1-3 · Build the source of truth for all product content**

### What This Is

A system inside ShopCX where you input product name and ingredients. AI researches the scientifically validated benefits of each ingredient, surfaces what your existing customers say in reviews, and lets you select which benefits to focus on. Every downstream asset — landing page content, knowledge base articles, support macros, email copy — derives from this single selection.

**The key insight:** Scientific claim + customer voice = two separate data streams you reconcile. Science tells you what's true. Reviews tell you what customers feel and talk about. Where both overlap is your strongest copy. The AI does the research. You make the editorial call.

### The 5 Stages

**Stage 1 — Product Input**

Fields: product name, target customer (pre-filled from workspace default, editable), certifications, ingredient list with dosages. That is all. Everything else is generated.

**Stage 2 — Ingredient Research (Inngest + Claude Sonnet)**

For each ingredient in parallel, Claude researches:
- Mechanism of action
- Clinically studied benefits
- How this product's dosage compares to studied ranges
- Peer-reviewed citations
- Contraindications for target customer (women 60+)
- Confidence score: 1.0 = multiple RCTs, 0.3 = traditional use only

**Stage 3 — Review Analysis (Inngest + Claude Sonnet)**

Batch analysis of all existing ShopCX reviews for this product. Returns:
- Top 5 benefits customers mention by frequency with exact customer phrases
- Before/after pain points
- Skeptics who became believers
- Surprise benefits not in official marketing
- Most powerful copywriting phrases

Runs in parallel with Stage 2.

**Stage 4 — Benefit Reconciliation UI**

3-column table: **Science** | **Customers** | **Your Selection**

- Benefits confirmed by both science AND customer voice → flagged green → strongest lead claims
- Benefits only in science, not customer voice → flagged yellow → use with caution
- Benefits only in reviews, not in science → testimonial angle only, not a lead claim

Per benefit, you select: **Lead** / **Supporting** / **Skip**. Drag to reorder lead benefits. This is the editorial layer — you are the editor, not the AI.

**Stage 5 — Content Generation**

One Claude Sonnet call with full context generates all downstream assets simultaneously:
- Landing page sections: hero headline (outcome-focused, customer language), benefit bar, mechanism copy, ingredient cards, comparison table rows, FAQ, guarantee copy
- Full knowledge base article for AI support agent context
- 5 support macro templates for most common question types

All output is editable before publishing. Nothing auto-publishes. Macros go into the existing macro approval queue (pending, not active).

### Database Tables

| Table | Purpose | Key Fields |
|---|---|---|
| `products` | Core product record | name, sku, certifications, target_customer |
| `product_ingredients` | Ingredient list per product | name, dosage_mg, dosage_display, display_order |
| `product_ingredient_research` | AI-generated benefit cards per ingredient | benefit_headline, mechanism_explanation, citations, ai_confidence |
| `product_benefit_selections` | Your editorial selections | role (lead/supporting/skip), science_confirmed, customer_confirmed, customer_phrases[] |
| `product_review_analysis` | Aggregated review intelligence | top_benefits, customer_profiles, surprise_benefits, most_powerful_phrases |
| `product_page_content` | Generated landing page content | hero_headline, benefit_bar, faq_items, approved_at |
| `product_media` | Image asset slots per product | slot (hero/lifestyle/ingredient/ugc), url, alt_text |

### Image Management

Defined upload slots per product: `hero` (1), `lifestyle_1`, `lifestyle_2`, `packaging`, `ingredient_[name]` (auto-created per ingredient), `ugc_[1-6]`, `comparison`. Each slot shows upload area, current preview, alt text field. Images stored in Supabase Storage at `/products/{product_id}/{slot}/`. Landing page renderer pulls by slot name. Solve content first — layer in AI image generation for ingredient cards later.

### Constraints

- Never display a scientific claim with confidence score below 0.5 as a lead claim
- All landing page health claims include the standard FDA disclaimer footer
- Knowledge base article must include a "What this product DOESN'T do" section
- Review quotes must come from actual ShopCX reviews — AI surfaces them, never invents them
- Ingredient research regenerates only on manual trigger — never auto-regenerate silently

---

## Phase 2 — Landing Page System
**Weeks 3-6 · DB-driven template, adaptive benefit focus, A/B testing**

### Architecture

A single Next.js template renders all 6 products. All content pulled from the database — zero hardcoded product content in the template. Changing a headline is a database update, not a code deploy.

**Speed architecture:**
- Static generation (SSG) at build time — HTML pre-rendered, served from Vercel Edge in <50ms
- Above-fold renders with zero JavaScript — pure HTML + CSS. Hero image priority-loaded, fonts via `next/font`
- Floating bar, pixel, and A/B logic load AFTER paint — they never delay LCP
- Video facade pattern: thumbnail renders immediately, video loads only on click or scroll-into-view
- Run Lighthouse CI on every deploy. Fail build if LCP > 2.5s or CLS > 0.1

### The 10-Section Template (in order)

| # | Section | Purpose | Content Source |
|---|---|---|---|
| 1 | Hero | Stop scroll, establish promise. Outcome headline, benefit bar chips, social proof count, press logos, CTA scrolls to pricing | `product_page_content.hero_headline` + benefit bar |
| 2 | Mechanism | Why this works before showing price. "Why superfood coffee works differently" | `mechanism_headline` + body |
| 3 | How It Works | 3-step visual: problem → mechanism → result | `how_it_works_steps` |
| 4 | Price Table | 3-column quantity break (1/3/6 bags). Subscribe vs one-time toggle. Middle column highlighted. **Hero CTA scrolls here.** | `product_pricing_tiers` |
| 5 | UGC / Real People | Video testimonials + real customer photos. For your demographic: women their age, real results | `product_media` (ugc slots) + top reviews |
| 6 | Comparison Table | vs Regular Coffee (not vs competitors). Leads with active angle's most relevant rows | `comparison_rows` |
| 7 | Ingredients Deep Dive | Per-ingredient card with benefit, source, research citation. For the researchers in your 60+ demographic | `product_ingredient_research` (lead + supporting) |
| 8 | More Reviews | Full review section, photo reviews, filterable by benefit tag | ShopCX reviews for this product |
| 9 | FAQ | Top 6 objections. Angle-specific items float first when benefit focus is active | `faq_items` |
| 10 | Final CTA | Catch bottom-of-page visitors. Repeat price table or simplified CTA + guarantee | `guarantee_copy` |

### Adaptive Benefit Focus

Each product has multiple benefit angles (e.g., energy, inflammation, joint-health, weight, sleep). The focus state can be set two ways:

- **Query string:** `/amazing-coffee?focus=joint-health` — from ad links, email links
- **Floating bar:** user selects their goal as they scroll — self-segmentation

When a focus state is active, the page reweights content hierarchy: hero headline swaps, relevant ingredients float first, matching reviews surface, comparison rows reorder. Template structure never changes.

**Permanent SEO URLs** are also generated: `/amazing-coffee/for-joint-health`, `/amazing-coffee/for-energy`. These are indexable, statically generated at build time, and rank for long-tail benefit searches. Query string `?focus=` versions are `noindex` — canonical is the `/for-[angle]` URL.

### The Floating Benefit Bar

A floating bar that travels with the user as they scroll. Not a quiz, not a gate — a persistent ambient preference selector.

- **Appears:** after 15% scroll depth (never interrupts the hero)
- **Mobile:** fixed `bottom-0`, full width, thumb zone
- **Desktop:** fixed `top` just below nav

**Three states:**
1. **Idle:** All benefit pills unselected. "Personalize for your goal:" label on desktop. Horizontally scrollable on mobile.
2. **Selected (transition, 200ms):** Chosen pill fills with accent color, others dim to 40% opacity
3. **Collapsed:** Bar shrinks to slim indicator showing active angle + ✕ to clear. Tapping expands back to idle with current selection highlighted.

On pill click: URL updates via `history.replaceState` (no reload), page content reweights with CSS transitions, focus event fires to pixel async (never blocks UI).

**Content reweighting uses CSS `order` property changes + opacity transitions. Never a page reload. Never layout shift.**

### A/B Testing — Edge Middleware

A/B assignment happens at the Vercel Edge — before cache lookup, before any JavaScript runs. Zero flicker. Zero layout shift. Zero speed penalty.

Middleware reads `ab_[test_id]` cookie. If not assigned, assigns variant randomly and sets 30-day cookie. Rewrites to the variant's pre-generated static page. The user always gets a statically served HTML file — never a JavaScript-modified page.

Test config lives in Vercel Edge Config — updated instantly without redeployment when tests are created or winners declared.

### Database Tables

| Table | Purpose | Key Fields |
|---|---|---|
| `product_benefit_angles` | Angle-specific content per product | benefit_key, hero_headline, featured_ingredient_ids, lead_review_keywords |
| `benefit_focus_events` | Every focus selection tracked | session_id, customer_id, benefit_key, set_by, converted |
| `ab_tests` | A/B test definitions | test_name, element, status, traffic_split, winner |
| `ab_variants` | Content per variant | variant_key, content (jsonb), page_path |
| `ab_results` | Daily aggregated results | sessions, add_to_carts, purchases, revenue_cents per variant per day |

---

## Phase 3 — First-Party Pixel + Event Clearinghouse
**Weeks 5-8 · Own your data. Forward to everywhere.**

### Why First-Party

The pixel script must be served from `pixel.superfoodscompany.com` — NOT from `shopcx.ai`. A third-party domain gets blocked by Safari ITP, Firefox ETP, and ad blockers. Your own subdomain is treated as first-party, giving full cookie lifetime and 20-40% more signal reaching Meta and Google CAPI.

**DNS Setup:**
```
pixel.superfoodscompany.com  CNAME  cname.vercel-dns.com
```
Add `pixel.superfoodscompany.com` as a custom domain in the ShopCX Vercel project. Vercel issues SSL automatically. ShopCX admin shows verification status and install instructions with your custom domain once DNS resolves.

### System Architecture

```
CLIENT (browser)
  shopcx-pixel.js (~8kb, vanilla JS, no deps)
    ↓ POST to:

YOUR DOMAIN (first-party, avoids blockers)
  pixel.superfoodscompany.com/collect
    ↓ validates, dedupes, fires Inngest:

EVENT CLEARINGHOUSE (Inngest: pixel/process-event)
    ↓ fan-out in parallel:

DESTINATIONS
  Meta CAPI
  Google Enhanced Conversions
  TikTok Events API
  ShopCX customer_events (source of truth)
```

### Pixel Script — Auto-Captured Events

The pixel auto-captures on load:
- `PageView` — immediately on load
- `ScrollDepth` — at 25/50/75/90/100% thresholds (once per page load each)
- `TimeOnPage` — at 30s/60s/120s/300s (pauses when tab hidden)
- UTM params — captured on first load, stored in sessionStorage, sent with every subsequent event

Exposes `window.scxPixel` globally:
- `scxPixel.track(eventName, properties)` — manual events
- `scxPixel.identify(email)` — email capture → triggers identity stitching
- `scxPixel.page()` — manual pageview for SPAs

### Collection Endpoint

`POST /api/pixel/collect` — public, no auth required.

On receipt:
1. Validate required fields (session_id, event_name, event_id, timestamp)
2. Deduplicate by `event_id` — if already seen, return 200 immediately
3. Enrich server-side: capture real IP from headers (never trust client-sent IP)
4. Identity resolution: check if session maps to known customer via email hash
5. Upsert `pixel_sessions`, write `pixel_events`
6. Fire Inngest `pixel/event.received`
7. Return 200 in **under 50ms always** — Inngest fan-out is async, never blocks response

Returns 200 for ALL valid requests including on internal errors. Never 4xx/5xx to the browser — it causes retry storms.

### Identity Resolution

A visitor arrives anonymously → selects benefit focus (behavioral) → scrolls 70% (engagement) → submits email for the energy guide (identified).

The moment their email is captured, all prior anonymous events in that session are retroactively stitched to their customer profile via `pixel/stitch-identity` Inngest function. By the time they buy, you know: sessions before purchase, benefit angle that brought them in, content they engaged with, which trigger captured their email.

Session ID is stored in `sessionStorage` (not localStorage — does not persist across sessions). Identified user stored in `localStorage` as `scx_uid` (email hash only).

### Email Capture — Benefit-Aware Timing

Four triggers, first match wins per session:

| Trigger | Condition | Delay | Copy |
|---|---|---|---|
| A | Benefit selected AND ScrollDepth 50 fired | 8 seconds | Angle-specific: "Get the [Energy] guide — free" |
| B | ScrollDepth 75 AND TimeOnPage 60s AND no benefit selected | None | Curiosity hook |
| C | Return visitor (localStorage `scx_seen` exists) | 15 seconds | "Welcome back" + 10% discount |
| D | Exit intent: mouse leaves top of viewport (desktop only, TimeOnPage 30s min) | None | Discount offer, once per session |

Copy map by angle:
- `energy` → "Get the energy protocol — free"
- `inflammation` → "Your inflammation guide"
- `joint-health` → "Joint health starter guide — what to expect in weeks 1, 2, and 4"
- `weight` → "The metabolic support guide"
- `default` → "10% off your first order"

On submit: `scxPixel.identify(email)` → `EmailCaptured` fires → identity stitching runs → `POST /api/leads` creates customer record tagged with benefit angle, enrolls in angle-specific email flow. Inline confirmation only — never redirect, never reload.

### Meta CAPI

- `event_id` matches between browser pixel fire and server CAPI fire → Meta deduplicates, maximizing signal without double-counting
- All PII hashed (SHA-256) before sending: email, phone, city, state, zip, country
- Client IP captured server-side, never trusted from client
- `_fbp` and `fbclid` captured by pixel, forwarded in CAPI payload
- `benefit_focus` sent as `custom_data` — shows which angle correlates with purchases in Meta audience insights

### Funnel Analytics

`/analytics/funnel` in ShopCX admin. Filterable by date range, UTM source, product, benefit angle, A/B variant, device type.

| Stage | Key Metrics |
|---|---|
| Awareness | Sessions, source breakdown, device split |
| Engagement | % past hero, % reached pricing, % used benefit bar, video plays, avg time on page |
| Intent | % clicked CTA, % email captured, % add to cart |
| Conversion | % initiated checkout, % purchased, subscription vs one-time split |
| Retention | Repeat purchase 30/60/90d, subscription tenure, LTV by acquisition angle |

The benefit angle filter is the key insight — shows CVR by angle, letting you put ad spend behind data-proven angles.

### Database Tables

| Table | Purpose |
|---|---|
| `pixel_sessions` | One row per browser session. Links to customer once identified. |
| `pixel_events` | Append-only event log. Never updated except to set customer_id on stitch. |
| `pixel_destination_log` | Per-event delivery status to each destination. |
| `pixel_destination_config` | API keys, enabled destinations, events to forward per workspace. |

Add to `customers` table:
- `benefit_interests text[]` — accumulated from pixel events
- `primary_interest text` — most recent or most frequent
- `acquisition_angle text` — angle active at first purchase
- `acquisition_source text` — utm_source at first purchase
- `pre_purchase_sessions int` — sessions before buying
- `email_capture_trigger text` — which trigger got their email

---

## Phase 4 — Custom Checkout
**Weeks 7-10 · Braintree + Avalara. PCI-compliant. No Shopify.**

### Stack Rationale

| | |
|---|---|
| Braintree | Existing account with clean processing history. Supplement-friendly. Drop-in UI means checkout pages are out of PCI scope for card data — tokens only hit our servers. Supports credit/debit, Apple Pay, Google Pay, PayPal. |
| Avalara | Existing account. Server-side tax calculation. Handles economic nexus across all US states. Integrated at checkout before payment capture — never post-order. |
| PCI Scope | Braintree Drop-in UI = SAQ-A compliance level. Card data never touches our servers. Tokens only. |

### Checkout Flow

1. Customer clicks Buy Now on landing page (price table CTA)
2. Checkout page loads: email, shipping address, order summary
3. On address entry: Avalara calculates tax in real time, updates order total
4. Braintree Drop-in UI renders in card field — hosted by Braintree, not us
5. Customer enters card: Braintree tokenizes client-side, returns nonce to our server
6. Our server calls Braintree with nonce + order total — never sees card number
7. On success: order created in ShopCX, subscription contract created if subscribe option
8. Thank you page: confirmation, next steps, subscription details
9. Pixel fires `Purchase` event with value, product, benefit_focus, A/B variant
10. Clearinghouse forwards to Meta CAPI, Google, TikTok

Checkout is SSR (not SSG — dynamic order data). Target: interactive in under 1.5s. Braintree Drop-in loads after form paint. Avalara called on address blur, not keystroke.

### What Replaces Shop Pay

Shop Pay's value was saved payment methods + one-click reorder. Replaced by:
- Customer login to ShopCX portal → saved Braintree payment method on file → one-click reorder
- Braintree Drop-in natively supports Apple Pay and Google Pay
- Subscription portal in ShopCX replaces Appstle's customer portal

> **Note:** Shop Pay's stored card tokens CANNOT be exported. See Phase 6 for the Shop Pay sunset plan.

---

## Phase 5 — Native Subscription Manager
**Weeks 9-14 · Replace Appstle. Own the billing layer.**

### Why Build It

Appstle relies on Shopify's Subscription API, which requires Shopify's approval and forces Shopify Payments for new subscription checkouts. Building natively on Braintree means we own subscription contracts, billing schedule, dunning logic, and customer portal — no approval gates, no platform dependency.

### Customer Portal Features

- Pause subscription (1-12 weeks)
- Skip next order
- Swap product variant
- Change frequency
- Update shipping address
- Update payment method (new Braintree token on file)
- Cancel with save offer (cancellation journey — already built in ShopCX)

All portal actions log to `customer_events`, feeding Retention Score and AI agent context.

### Billing Engine (Inngest)

On each billing date: attempt charge via Braintree using stored payment method token.

- **Success:** create order, trigger fulfillment webhook to Amplifier 3PL
- **Failure:** initiate dunning sequence

Dunning sequence:
- Day 1: Email (payment failed, please update)
- Day 3: SMS
- Day 7: Final notice email
- Day 10: Cancel subscription, trigger win-back flow

### Webhook Events

| Event | Trigger | Actions |
|---|---|---|
| `payment_failed` | Braintree charge fails | Create ticket, send dunning email 1, reduce retention score |
| `payment_recovered` | Charge succeeds after failure | Close billing tickets, send confirmation, restore score |
| `subscription_cancelled` | Customer cancels in portal | Tag churned, trigger win-back flow (+1d, +7d, +30d) |
| `subscription_paused` | Customer pauses | Suppress marketing, queue re-engagement before pause ends |
| `subscription_created` | New subscription checkout | Set retention score 60, trigger onboarding flow |
| `order_shipped` | Amplifier fulfills | Send tracking notification, log to customer timeline |

### Appstle Migration Strategy

> **Warning: Never cancel Appstle before Braintree has payment method confirmed. Double-billing is fixable. Broken billing is not.**

1. New subscribers go onto ShopCX/Braintree from Phase 5 launch
2. Existing Appstle subscribers stay on Appstle during parallel run
3. Migrate existing subscribers in cohorts of 50 — start with most recent (lowest risk)
4. Before migrating any cohort: Braintree must confirm payment method on file
5. Only after Braintree confirmation: cancel the Appstle subscription
6. **Exception:** Shop Pay subscribers in Appstle cannot be auto-migrated (see Phase 6)

---

## Phase 6 — Shopify Cutover
**Week 16+ · The single coordinated switch.**

### Pre-Cutover Checklist

All of these must be complete before initiating cutover:

- [ ] ShopCX subscription manager running for all new customers (Phase 5 live)
- [ ] Custom checkout tested with real Braintree transactions
- [ ] Landing pages live on staging domain, Lighthouse 95+
- [ ] Pixel live and confirmed firing (check `/settings/pixel` event stream)
- [ ] Meta CAPI connected and showing good EMQ score
- [ ] Shop Pay subscriber count identified — payment update campaign complete (see below)
- [ ] Appstle migration to ShopCX complete for all non-Shop-Pay subscribers
- [ ] Braintree PCI export from Shopify Payments confirmed ready
- [ ] Avalara tax nexus configured for all active shipping states
- [ ] Amplifier 3PL webhook connected to ShopCX (not Shopify)
- [ ] DNS TTL reduced to 60 seconds, 48 hours before cutover

### The Shop Pay Problem — Solve First

Shop Pay payment tokens **cannot be exported**. They are vaulted by Shopify's infrastructure, not your merchant account. When you leave Shopify, those tokens become invalid. Any subscriber still on Shop Pay at cutover will have their subscription fail.

Steps:

1. **Pull the report now:** How many active subscribers are paying via Shop Pay? Check Appstle subscriber list filtered by payment method.

2. **Turn off Shop Pay for new customers immediately:** Shopify admin → Settings → Payments → Shopify Payments → Manage → Manage payment methods → Deactivate Shop Pay. This stops the problem growing.
   > WARNING: Do this carefully — deactivating breaks billing for existing Shop Pay subscribers. Identify and notify them first.

3. **Run 60-day payment update campaign:** Email + SMS to Shop Pay subscribers asking them to update their payment method in the subscription portal. Frame as "security upgrade." Offer incentive if needed (skip order, 10% off).

4. **Remaining subscribers at cutover:** Reach out proactively, offer free month, ask to re-enter card. Accept that a small % will churn — this is unavoidable.

### Cutover Week Timeline

| Day | Action | Notes |
|---|---|---|
| Day 1 | Initiate Shopify Payments → Braintree PCI card export | Contact Shopify Professional Services. They coordinate with Braintree directly. 5-10 business days. |
| Day 5-10 | Braintree confirms card import complete | Verify: Braintree customer IDs + payment method tokens match subscription records in ShopCX |
| Day 10 | DNS cutover: superfoodscompany.com → new Next.js storefront | 60s TTL = propagation in 1-2 minutes. Monitor error rates in real time. |
| Day 10 | Shopify store set to password-protected | Not cancelled yet — keep for in-flight orders and disputes |
| Day 10 | Confirm all billing routing through Braintree | Test a real charge via ShopCX portal |
| Day 14 | Appstle cancelled | Confirm zero active Appstle subscriptions first |
| Day 14 | Shopify Payments deactivated | Download final transaction export first for accounting |
| Day 30 | Shopify plan downgraded or cancelled | Keep for 30 days post-cutover. $29 Basic plan if needed. |

### Rollback Plan

If anything goes wrong in the first 24 hours:

- **DNS:** Revert to Shopify's nameservers — propagates in under 5 minutes at 60s TTL
- **Payments:** Shopify Payments stays active for 30 days post-cutover
- **Subscriptions:** Appstle stays installed (not cancelled) for 14 days post-cutover
- **Orders:** All ShopCX orders written to database regardless — no data loss risk

---

## Technical Reference

### Full Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | Next.js 14+ App Router | Static generation, Edge middleware, React Server Components |
| Hosting | Vercel Edge Network | 300+ edge locations, <50ms TTFB globally, custom domains |
| Database | Supabase Postgres + pgvector | Structured data, RLS multi-tenancy, realtime, embeddings |
| Background jobs | Inngest | Durable functions, subscription billing, AI processing, pixel fan-out |
| Payments | Braintree | Existing account, Drop-in UI, token vault, subscriptions, Apple/Google Pay |
| Tax | Avalara | Existing account, real-time calculation, nexus management |
| AI | Anthropic Claude Sonnet | Ingredient research, content generation, support agent, classification |
| Embeddings | pgvector + text-embedding-3-small | Knowledge base RAG, product classification, macro matching |
| Email | Resend | Transactional and marketing email, React Email templates |
| SMS | Twilio | Subscription dunning, marketing SMS, two-way messaging |
| 3PL | Amplifier | Fulfillment webhooks directly from ShopCX, not via Shopify |
| Pixel | Custom (ShopCX) | First-party, served from pixel.superfoodscompany.com CNAME |

### Environment Variables

| Variable | Source | Used In |
|---|---|---|
| `BRAINTREE_MERCHANT_ID` | Braintree dashboard | Checkout, subscription billing |
| `BRAINTREE_PUBLIC_KEY` | Braintree dashboard | Drop-in UI token generation |
| `BRAINTREE_PRIVATE_KEY` | Braintree dashboard | Server-side transaction processing |
| `AVALARA_ACCOUNT_ID` | Avalara account | Tax calculation at checkout |
| `AVALARA_LICENSE_KEY` | Avalara account | Tax calculation at checkout |
| `ANTHROPIC_API_KEY` | Anthropic console | All AI features |
| `META_PIXEL_ID` | Meta Events Manager | CAPI event forwarding |
| `META_CAPI_TOKEN` | Meta Events Manager | CAPI event forwarding |
| `GOOGLE_ADS_CUSTOMER_ID` | Google Ads | Enhanced conversions |
| `TIKTOK_PIXEL_CODE` | TikTok Events | TikTok event forwarding |
| `TIKTOK_ACCESS_TOKEN` | TikTok Events | TikTok event forwarding |
| `SUPABASE_URL` | Supabase dashboard | All database operations |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard | Server-side DB operations |
| `INNGEST_SIGNING_KEY` | Inngest dashboard | Background job security |
| `RESEND_API_KEY` | Resend dashboard | Email sending |
| `TWILIO_ACCOUNT_SID` | Twilio console | SMS sending |
| `TWILIO_AUTH_TOKEN` | Twilio console | SMS sending |

### Key Decisions

| Decision | Rationale |
|---|---|
| Why not Stripe? | Stripe classifies supplements/nutraceuticals as restricted with broad automated flagging. With a clean Braintree history and existing account, no reason to introduce Stripe risk. |
| Why not AMP? | AMP prohibits custom JavaScript — kills the floating bar, A/B testing, pixel, and benefit focus system. Same speed achievable via Next.js SSG + Vercel Edge with zero restrictions. AMP is deprecated as a ranking signal anyway. |
| Why SSG vs SSR? | Product pages change infrequently (hourly revalidation is fine). Static = <50ms TTFB from edge cache vs 200-400ms for SSR. A/B testing handled at edge middleware layer, not page render time. |
| Why Inngest? | Durable functions with automatic retry, step-level memoization, fan-out patterns, and observability. Billing failures need reliable retry logic. Pixel fan-out needs parallel execution with independent failure handling. |
| Why first-party pixel? | 20-40% more signal vs third-party hosted. Safari ITP gives full cookie lifetime. No block-list fingerprint since this is a custom tool. Server-side CAPI forwarding adds signal that browser-side pixels lose post-iOS14. |
| Why pgvector for RAG? | Already in Supabase — no separate vector DB to manage. Sufficient for knowledge base scale. Simplifies architecture significantly. |
| Why leave Shopify Subscription API? | Requires Shopify approval even for custom apps on your own store. Protected scopes `read_customer_payment_methods` and `write_own_subscription_contracts` need explicit approval that can be denied or revoked. Forces Shopify Payments for new subscription checkouts. Building on Braintree removes all these constraints. |

---

## Start Here Tomorrow

Do not start with the landing page. Do not start with the pixel. Start with the Product Intelligence Engine — it is the source of truth that everything else derives from. One day of work here saves weeks of guessing on copy, positioning, and knowledge base content.

### Day 1 Build Order

1. Create Supabase migration for all Phase 1 tables: `products`, `product_ingredients`, `product_ingredient_research`, `product_benefit_selections`, `product_review_analysis`, `product_page_content`, `product_media`

2. Build `/products/[id]/intelligence/setup` — the ingredient input UI

3. Build `intelligence/research-ingredients` Inngest function (Claude Sonnet per ingredient, parallel, concurrency 5)

4. Build `intelligence/analyze-reviews` Inngest function (batch existing ShopCX reviews for this product)

5. Build the Benefit Reconciliation UI — the 3-column science / customer / selection table

6. **Run it on Amazing Coffee first. See what comes back. Iterate the prompt.**

By end of Day 1 you will have scientifically validated, customer-confirmed benefit selections for Amazing Coffee. Everything else in this spec builds on top of that foundation.

---

**Do not build for Shopify. Do not integrate what you build with Shopify. Build for the future stack from day one. ShopCX is already syncing all the data you need. The Shopify integration is read-only reference data until cutover.**

Each phase is independently valuable. None requires the next one to be complete before it ships internally. Ship Phase 1. Ship Phase 2. Test on a staging domain. Then Phase 3 and 4. Then begin the Appstle migration (Phase 5). Then set the cutover date (Phase 6).
