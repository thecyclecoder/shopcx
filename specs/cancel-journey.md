# Cancel Journey — Feature Spec

## Overview

AI-powered subscription cancellation retention flow. Instead of hardcoded rebuttals, AI selects the best save offers per customer based on context + historical success rates. Open-ended reasons trigger a brief empathetic AI conversation. Product reviews provide social proof. Every remedy outcome is tracked so the system gets smarter over time.

**This is Phase 1**: Single subscription cancel + save. No multi-sub management — that becomes a standalone "Manage Subscription" journey later, chained onto cancel like account linking chains onto discount.

### Implementation Status: COMPLETE ✅
All items in this spec are implemented. Additional features beyond spec:
- **First-renewal detection** (see section below): aggressive save offers for pre-first-renewal customers
- **Default remedies seed data** in `journey-seed.ts` (`DEFAULT_REMEDIES` array, 9 types)
- **Anthropic API via raw fetch** (not SDK) — matches existing codebase pattern
- **Widget inline support**: `single_choice` and `subscription_select` step types in chat widget

---

## Top 4 Cancel Reasons (business critical)

1. Too much product
2. Too expensive
3. Not getting results
4. I've already reached my goals

Improving save rates on these 4 reasons changes the business. The remedy system + social proof are designed specifically to address them.

---

## Journey Flow

### Step 1: Select subscription
- Skip if customer has only one active sub
- Radio list with collapsible detail cards:
  - **Collapsed**: Product names, next renewal date, total price
  - **Expanded**: Full item list (title, variant, quantity), frequency, payment last 4 digits
  - **Shipping protection** items: NOT shown as line items. Render as green badge below items: "Shipping Protection activated — free replacements for items lost, damaged, or stolen during delivery"
- Query active subs across main customer + linked accounts

### Step 2: Why are you cancelling?
Single choice:
- Too expensive
- I have too much product
- I'm not seeing results
- I've already reached my goals
- I don't like the taste or texture
- My health needs have changed
- I just need a break
- Something else

### Step 3: AI Remedy Selection
**For concrete reasons** (too expensive, too much product, results, goals, taste, health):
- AI analyzes customer context + remedy success rates → picks top 3
- Present as clear options (17px text, short and punchy)
- Below the remedy options: surface one killer review as social proof
  - Featured reviews first, then best match for the cancel reason
  - Summarized if long (e.g., "Karen K. lost 35 pounds after 6 months")
  - "Read full review" link → collapsible div with full text
- Customer picks a remedy or "I still want to cancel"

**For open-ended reasons** ("just need a break", "something else", "reached my goals"):
- Mini-site: inline chat appears below the form step
- Live chat: form collapses, regular chat input takes over
- AI has full context: customer profile, products, subscription age, reviews, available remedies
- AI personality: empathetic friend, not pushy, references their specific products
- Max 3 turns. If can't save → "I understand. Let me cancel that for you."
- Uses Claude Sonnet (worth $2-5 per conversation to save a subscriber)

### Step 4: Resolution
- **Saved** → execute remedy via Appstle API → "We've [applied 20% off / paused for 60 days / etc.]"
- **Cancel confirmed** → "Are you sure?" final confirmation → Appstle DELETE
- Log remedy outcome (every remedy shown, accepted/declined)

### Step 5: Completion
- Saved: "We've updated your subscription. Thank you for staying with us!"
- Cancelled: "Your subscription has been cancelled. You won't be charged again. You're always welcome back."

---

## AI Remedy Selection

### How it works
1. Customer gives cancel reason
2. System queries `remedies` table (enabled only) + `remedy_outcomes` for success rates
3. Claude Haiku call with:
   - Cancel reason
   - Customer context: LTV, retention score, sub age (days), total orders, products
   - Available remedies with descriptions + historical success rates
   - Available coupons from coupon_mappings (AI-enabled, matching VIP tier)
   - Featured reviews for their products
4. AI returns top 3 remedies as structured JSON: `[{remedy_id, pitch_text, confidence}]`
5. System renders the pitches as options

### AI prompt structure
```
You are a subscription retention specialist. Based on the customer profile and cancel reason, pick the 3 remedies most likely to convince this customer to stay.

Customer: {LTV, score, sub_age, orders, products}
Cancel reason: "{reason}"
Available remedies: [{name, type, description, success_rate_for_this_reason}]
Available coupons: [{code, summary, value}]
Product reviews: [{rating, summary, product}]

Return JSON array of 3 remedies with:
- remedy_id: which remedy to offer
- pitch: 1-2 sentence pitch (casual, empathetic, specific to their situation). Max 25 words.
- coupon_code: if remedy is coupon type, which code to use
- confidence: 0-1 how likely to save
```

Use Haiku for this call (fast, structured output).

### Open-ended AI conversation prompt
```
You are a friendly subscription specialist for {workspace_name}. A customer wants to cancel their subscription.

Their reason: "{reason}"
Their products: {items}
They've been subscribed for {age} days with {orders} orders totaling {ltv}.

Available remedies you can offer: {remedies_list}
Relevant reviews: {reviews}

Be empathetic and genuine. Don't be pushy. Understand their real concern first, then naturally suggest a remedy that fits. Keep responses under 3 sentences. Reference their specific products when relevant.

If they're firm on cancelling after 2-3 exchanges, accept gracefully: "I completely understand. Let me go ahead and cancel that for you."
```

Use Sonnet for this (needs empathy + nuance).

---

## Database Tables

### `remedies`
```sql
CREATE TABLE public.remedies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('coupon', 'pause', 'skip', 'frequency_change', 'product_swap', 'free_gift', 'social_proof', 'ai_conversation', 'specialist')),
  config JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

Config examples:
- coupon: `{}` (references coupon_mappings, AI picks which one)
- pause: `{"days": [30, 60]}`
- skip: `{}`
- frequency_change: `{"options": ["MONTH/1", "MONTH/2"]}`

### `remedy_outcomes`
```sql
CREATE TABLE public.remedy_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id),
  subscription_id UUID REFERENCES subscriptions(id),
  cancel_reason TEXT NOT NULL,
  remedy_id UUID REFERENCES remedies(id),
  remedy_type TEXT NOT NULL,
  offered_text TEXT,
  accepted BOOLEAN NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('saved', 'cancelled', 'escalated')),
  customer_ltv_cents INTEGER,
  subscription_age_days INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_remedy_outcomes_reason ON remedy_outcomes(workspace_id, cancel_reason, remedy_type);
```

### `product_reviews`
```sql
CREATE TABLE public.product_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shopify_product_id TEXT NOT NULL,
  reviewer_name TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT,
  verified_purchase BOOLEAN DEFAULT false,
  featured BOOLEAN DEFAULT false,
  klaviyo_review_id TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, klaviyo_review_id)
);
CREATE INDEX idx_reviews_product ON product_reviews(workspace_id, shopify_product_id, featured, rating DESC);
```

---

## Klaviyo Integration

### Settings → Integrations → Klaviyo
- API Private Key (encrypted, stored per workspace as `klaviyo_api_key_encrypted`)
- Public Key / Site ID (stored as `klaviyo_public_key`)
- "Sync Reviews" button + last sync timestamp

### API Reference
Base URL: `https://a.]klaviyo.com/api/`
Auth: `Authorization: Klaviyo-API-Key {private_key}`
Revision header required: `revision: 2024-10-15`

**Get reviews for a product:**
```
GET /api/reviews/?filter=equals(product_external_id,"{shopify_product_id}")&sort=-rating
```

**Key fields in review response:**
- `attributes.rating` (1-5)
- `attributes.title`
- `attributes.body`
- `attributes.author` (reviewer name)
- `attributes.product_external_id` (Shopify product ID)
- `attributes.is_verified_buyer`
- `attributes.smart_featured` — this is the Klaviyo "featured" flag set by the team
- `attributes.created` (published date)

### Review Sync
- Inngest function: nightly sync or on-demand from settings
- For each Shopify product in the workspace, pull reviews from Klaviyo
- Upsert to `product_reviews` table
- Map `smart_featured` → `featured` boolean

### Review Usage in Cancel Flow
- When showing remedies, also show one relevant review below
- Priority: featured reviews first, then highest-rated matching the cancel reason context
- Review displayed as:
  - Summary (AI-generated, max 15 words, e.g., "Karen K. lost 35 pounds after 6 months")
  - Star rating
  - "Read full review" → collapsible div with full review text
- AI summarization: use Haiku to generate the summary line when syncing reviews (store as `summary` column)

---

## Appstle API Endpoints

Reference: https://appstle-docs.readme.io/reference/introduction

| Action | Method | Endpoint |
|--------|--------|----------|
| Cancel | DELETE | `/subscription-contracts/{id}?cancellationFeedback={reason}&cancellationNote={note}` |
| Pause | PUT | `/subscription-contracts-update-status?contractId={id}&status=PAUSED` |
| Resume | PUT | `/subscription-contracts-update-status?contractId={id}&status=ACTIVE` |
| Apply coupon | PUT | `/subscription-contracts-apply-discount?contractId={id}&discountCode={code}` |
| Remove coupon | PUT | `/subscription-contracts-remove-discount?contractId={id}&discountId={id}` |
| Skip next | PUT | `/subscription-contracts-skip?contractId={id}` |
| Change frequency | PUT | `/subscription-contracts-update-billing-interval?contractId={id}&interval={MONTH}&intervalCount={1\|2}` |
| Get contract details | GET | `/contract-raw-response?contractId={id}` |

All require header: `X-API-Key: {api_key}`
Cancel note format: "Cancelled by customer via ShopCX cancel journey. Reason: {reason}"

---

## Coupon Remedies

- Do NOT create new coupon config — reference existing `coupon_mappings` table
- AI picks from AI-enabled coupons based on customer VIP tier + context
- Same application logic as discount journey: remove old discounts first, then apply new
- Coupon remedy config in `remedies` table is just `{}` — the AI selects the specific coupon

---

## UI / UX Rules

- **17px minimum** for all text in the cancel flow — easy to read, no squinting
- **Short and punchy** — if people have to read a lot, they cancel. Max 2 sentences per step.
- **Remedy pitches**: max 25 words each
- **Review summaries**: max 15 words, AI-generated
- **Subscription cards**: collapsible, clean, shipping protection as badge not line item
- **AI chat** (open-ended): responses under 3 sentences
- **"Are you sure?"** confirmation: simple, not guilt-trippy

---

## Settings UI

**Settings → Journeys → Cancel** detail view:
- Standard journey fields (name, channels, match patterns, step ticket status)
- **Remedies section**: list of remedy types, enable/disable toggle, priority drag
- Coupon remedies auto-populated from Settings → Coupons (AI-enabled ones)
- Social proof toggle (requires Klaviyo integration active)
- AI conversation toggle + max turns (default: 3)
- Review display toggle

**Settings → Integrations → Klaviyo**:
- API Private Key (encrypted)
- Public Key
- "Sync Reviews Now" button
- Last synced timestamp
- Review count

---

## Tags

- `j:cancel` — cancel journey applied
- `jo:positive` — customer saved (accepted retention offer)
- `jo:negative` — customer cancelled

---

## Files to Create

| File | Purpose |
|------|---------|
| `supabase/migrations/YYYYMMDD_cancel_journey.sql` | remedies, remedy_outcomes, product_reviews tables + workspace klaviyo fields |
| `src/lib/cancel-journey-builder.ts` | Build multi-step cancel form from customer subs + remedies |
| `src/lib/remedy-selector.ts` | AI remedy selection (Claude Haiku) |
| `src/lib/klaviyo.ts` | Klaviyo API client (reviews) |
| `src/lib/inngest/sync-reviews.ts` | Nightly review sync from Klaviyo |
| `src/app/dashboard/settings/integrations/klaviyo/page.tsx` | Klaviyo integration settings |

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/journey-launcher.ts` | Add cancellation alongside discount_signup |
| `src/lib/email-journey-builder.ts` | Handle "cancellation" intent |
| `src/app/api/journey/[token]/complete/route.ts` | Process cancel responses, remedy outcomes, Appstle actions |
| `src/app/journey/[token]/page.tsx` | Subscription cards, AI chat mode, review display, shipping protection badge, 17px text |
| `src/app/widget/[workspaceId]/page.tsx` | Same updates for inline form |
| `CLAUDE.md` | Update with cancel journey, Klaviyo integration |
| `JOURNEYS.md` | Add cancel journey docs, remedy system |

---

## Seed Data

Seed default remedies for new workspaces:
1. Coupon (references coupon_mappings)
2. Pause 30 days
3. Pause 60 days
4. Skip next order
5. Change to monthly frequency
6. Change to every-other-month frequency
7. AI conversation (for open-ended)
8. Social proof (reviews)
9. Connect with specialist

---

## First-Renewal Cancellers (Critical Business Logic)

50% of subscription churn happens before the first renewal (month 0 to month 1). After surviving the first renewal, retention improves dramatically. These customers have NEVER renewed — they signed up, received their first order, and are about to bail.

### Detection
- `subscription_age_days < billing_interval_days` (e.g., < 30 for monthly, < 60 for bi-monthly)
- Implemented in `cancel-journey-builder.ts`, passed as `isFirstRenewal` + `subscriptionAgeDays` through metadata

### Psychology for first-renewal saves
1. **Loss aversion**: They haven't experienced the full benefit yet. "Most customers don't see results until their 2nd or 3rd month."
2. **Sunk cost**: "You've already started — giving up now means that first order was just a one-time purchase."
3. **Social proof**: Reviews from people who almost quit but didn't. "Sarah almost cancelled after her first month too."
4. **Risk reversal**: "What if we extend your next order by 30 days? No charge, no risk."
5. **Deeper discounts**: A new customer costs $30-80 to acquire. Giving 30-40% off next 2 orders is cheaper than replacement.

### Implementation
- AI remedy prompt (Haiku) includes aggressive first-renewal context when `first_renewal: true`
- Deeper discounts prioritized (25-40%, not 10-15%)
- Pauses framed as "extend your trial" not "take a break"
- Skips framed as "push your next order out so you can finish what you have"
- Subscription cards show "Your first shipment" instead of "Renews [date]" — avoids payment anxiety
- `first_renewal` boolean stored in `remedy_outcomes` for separate metrics tracking

### Review selection for first-renewal
AI should look for reviews containing: "almost cancelled", "glad I stayed", "took time", "after a few months", "didn't notice at first", "stick with it"

### Key metric
First-renewal save rate tracked separately in `remedy_outcomes` (filter `first_renewal = true`). Goal: move from ~50% churn to <30% on first renewal.

---

## Success Metrics

Track via remedy_outcomes:
- **First-renewal save rate** (THE metric — `remedy_outcomes WHERE first_renewal = true`)
- Save rate per cancel reason
- Save rate per remedy type
- Which coupons save most effectively
- AI conversation save rate vs structured remedies
- Review influence on save rate (when shown vs not)
- Average LTV of saved vs lost customers
- First-renewal vs established subscriber save rates compared
