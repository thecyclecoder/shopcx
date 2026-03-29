# Portal Frontend Rewrite — Feature Spec

## Overview

Rewrite the customer portal frontend JS (`shopify-extension/portal-src/`) to use the upgraded ShopCX backend. Current code is vanilla JS with manual DOM, built without context of journeys, AI remedies, dunning, or linked accounts.

## Safe Deployment

Deploy into the ShopCX Shopify app (already installed on the store). The existing portal stays live on the old app.

1. Update `shopify-extension/shopify.app.toml`: set `client_id` to ShopCX app's client ID (from workspace DB)
2. Set `app_proxy.url` to `https://shopcx.ai/api/portal`
3. Register app proxy on ShopCX app in Shopify Partners: prefix=apps, subpath=portal
4. Deploy: `cd shopify-extension && shopify app deploy`
5. Add "Subscriptions Portal" block to a hidden `/pages/portal-test` page
6. Test there. Customers stay on old portal at `/pages/portal`

## Key Upgrades

### Cancel Flow → AI-Powered Retention
- Fetch AI remedies from `GET /api/portal?route=cancelJourney&contractId={id}`
- Render reason selection → top 3 AI-selected remedies → product reviews as social proof
- Open-ended reasons → inline AI chat (empathetic, max 3 turns)
- Only hard-cancel after full journey completion
- 17px text, max 25 words per remedy pitch, no guilt trips

### Dunning Awareness
- Subscriptions in recovery show amber "Payment Issue" badge
- Banner: "We're working on your payment. You can also update your payment method."
- [Update Payment Method] button → Shopify secure flow
- Fetch from `GET /api/portal?route=dunningStatus&contractId={id}`

### Linked Accounts
- Subscription list includes linked customer profiles
- Subtle "Linked account" label on linked subs

## Architecture

```
portal-src/js/
├── core/           — api, router, ui helpers, state
├── screens/        — home, detail, cancel (REWRITTEN), manage
├── components/     — subscription-card, remedy-card, review-card, chat-widget, dunning-banner
├── actions/        — API mutation wrappers
└── portal-entry.js — bootstrap + mount
```

## UI Rules
- 17px minimum body text
- Short and punchy — max 2 sentences
- Mobile-first
- Skeleton loaders, not spinners
- Shipping protection as green badge (preserve current behavior)

## Backend Endpoints
- `GET /api/portal?route=subscriptions` — DB-first list with dunning badges
- `GET /api/portal?route=subscriptionDetail&id={id}` — enriched detail
- `GET /api/portal?route=cancelJourney&contractId={id}` — AI remedies + reviews
- `POST /api/portal?route=cancelJourney&contractId={id}` — process cancel journey
- `GET /api/portal?route=dunningStatus&contractId={id}` — recovery info
- `GET /api/portal?route=reviews&productIds={ids}` — reviews from DB
