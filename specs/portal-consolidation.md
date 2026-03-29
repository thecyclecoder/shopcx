# Customer Portal Consolidation — Feature Spec

## Overview

Bring the customer-facing subscription portal (currently split across 2 repos) into ShopCX. The backend routes become ShopCX API endpoints. The Shopify theme extension lives in a `shopify-extension/` subfolder. The portal gains access to our entire infrastructure: DB, dunning, journeys, AI remedies, reviews, linked accounts, event logging.

**Current state:**
- Backend: `github.com/thecyclecoder/subscriptions-portal` → Vercel at `subscriptions-portal-nine.vercel.app`
- Extension: `github.com/thecyclecoder/shopify-subscriptions-portal` → Shopify theme extension

**Target state:**
- Backend: `shopcx.ai/api/portal` (same repo, same deployment)
- Extension: `shopcx/shopify-extension/` subfolder (deployed via `shopify app deploy`)

---

## Backend Migration

### Route mapping
All portal routes live at `/api/portal` with query param routing (same pattern as current):

`GET/POST /api/portal?route={routeName}`

| Route | Current | ShopCX Upgrade |
|-------|---------|---------------|
| bootstrap | Echo auth context | + Return dunning status, linked account count |
| home | Basic app info | + Active sub count, needs-attention count from DB |
| subscriptions | Appstle contracts lookup | + DB-first for speed, Appstle as fallback. Include dunning badges, linked account subs |
| subscriptionDetail | Single contract from Appstle | + DB enrichment: dunning status, payment failures, customer events timeline |
| pause | Reschedule billing + custom attrs | + Log to customer_events, create internal ticket note |
| resume | Reschedule + clear pause | + Log to customer_events, create internal ticket note |
| cancel | Status → CANCELLED | **UPGRADE**: Trigger cancel journey instead of hard cancel. AI remedies, reviews, save offers. Fall back to hard cancel only if journey completed with cancellation outcome |
| reactivate | Reschedule + status → ACTIVE | + Log event, resume dunning if was paused for payment |
| address | Update shipping address | + Update in our DB too, log event |
| replaceVariants | Swap line items | + Log event, track product swap analytics |
| coupon | Apply/remove discount | + Use our coupon_mappings, log event |
| frequency | Change billing interval | + Log event |
| reviews | Klaviyo featured reviews | **UPGRADE**: Use our `product_reviews` table (already synced). No more direct Klaviyo calls. Featured reviews prioritized. |

### Auth
Port `requireAppProxy.ts` — Shopify HMAC-SHA256 signature verification on query params. This is the same auth pattern, just in our codebase.

Required env var: `SHOPIFY_APP_PROXY_SECRET` (the app's client secret used for HMAC)

### Key upgrades over current backend

**1. DB-first lookups**
Current portal hits Appstle for every subscription list/detail. ShopCX has the data in Supabase (synced via webhooks). Use DB first, Appstle only for mutations and fresh data when needed.

**2. Cancel → Journey**
Instead of `PUT update-status CANCELLED`, trigger the cancel journey. Customer sees AI-selected remedies, reviews, save offers. Only cancels if they go through the full flow and confirm. This is the single biggest upgrade — every portal cancel becomes a save opportunity.

**3. Dunning awareness**
Portal shows payment status on subscriptions. If a sub is in dunning recovery, show "We're working on your payment" instead of a scary error. Include "Update payment method" button that triggers Shopify's secure update flow.

**4. Linked accounts**
Show subscriptions across all linked customer profiles. Customer sees everything in one place.

**5. Event logging**
Every portal action (pause, resume, cancel attempt, address change, item swap, coupon apply) logged to `customer_events`. Agents see full timeline. Dashboard tracks portal usage.

**6. Internal notes**
When a customer takes an action in the portal, create an internal note on their most recent open ticket (if one exists). Agents stay informed.

---

## Shopify Extension

### Folder structure in ShopCX repo
```
shopcx/
├── shopify-extension/
│   ├── shopify.app.toml          (updated: app_proxy.url → shopcx.ai)
│   ├── extensions/
│   │   └── subscriptions-portal-theme/
│   │       ├── shopify.extension.toml
│   │       ├── blocks/subscription-portal.liquid
│   │       ├── snippets/stars.liquid
│   │       ├── assets/
│   │       │   ├── subscription-portal.js  (compiled)
│   │       │   └── portal.min.css          (compiled)
│   │       └── locales/en.default.json
│   ├── portal-src/               (source JS + SCSS)
│   │   ├── js/
│   │   │   ├── core/             (api.js, ui.js, utils.js)
│   │   │   ├── screens/          (home, subscriptions, detail, cancel, router)
│   │   │   ├── cards/            (items, pause, resume, address, coupon, frequency, etc.)
│   │   │   ├── modals/           (remove, add-swap, quantity, review)
│   │   │   ├── actions/          (pause, resume, cancel, coupon, frequency, etc.)
│   │   │   └── portal-entry.js
│   │   └── styles/               (SCSS)
│   ├── package.json              (build deps: esbuild, sass)
│   └── .gitignore
├── src/                          (ShopCX main app)
├── ...
```

### Deployment
- **Backend**: Deploys with ShopCX on Vercel (same domain)
- **Extension**: Deploy separately via `cd shopify-extension && shopify app deploy`
- **Build step**: `portal-src/` → compiled JS/CSS → `extensions/.../assets/`

### Config change
In `shopify.app.toml`:
```toml
[app_proxy]
url = "https://shopcx.ai/api/portal"   # was subscriptions-portal-nine.vercel.app
subpath = "portal"
prefix = "apps"
```

---

## Portal Cancel → Cancel Journey Integration

The biggest upgrade. When a customer clicks "Cancel" in the portal:

### Current flow (hard cancel)
1. Portal calls `POST /api/portal?route=cancel` with `{ contractId }`
2. Backend calls Appstle `PUT update-status CANCELLED`
3. Done. Customer lost.

### New flow (AI-powered retention)
1. Portal calls `POST /api/portal?route=cancel` with `{ contractId }`
2. Backend creates a cancel journey session
3. Returns `{ ok: true, journey: true, journeyUrl: "/journey/{token}" }` or inline steps
4. Portal renders the cancel journey UI:
   - Why are you cancelling? (reasons)
   - AI-selected remedies (top 3 based on customer context + success rates)
   - Featured product reviews (social proof)
   - Open-ended AI chat for ambiguous reasons
5. If saved → execute remedy (pause, discount, skip, etc.)
6. If still wants to cancel → confirm → THEN cancel via Appstle
7. Log remedy outcome for system learning

### Portal UI for cancel journey
The portal already has a cancel screen (`portal-src/js/screens/cancel.js`). Upgrade it to:
- Fetch cancel journey steps from backend
- Render reason selection, remedy cards, review cards
- Handle AI chat inline (text input + responses)
- All within the existing portal UI (no redirect to mini-site)

---

## Portal-Specific API Additions

### `GET /api/portal?route=cancelJourney&contractId={id}`
Returns the cancel journey steps for this subscription:
- Subscription details
- Cancel reasons
- Available remedies (AI-selected)
- Featured reviews for the subscription's products

### `POST /api/portal?route=cancelJourney&contractId={id}`
Processes cancel journey responses:
- Submit reason
- Submit remedy selection
- Submit AI chat messages
- Submit final cancellation confirmation

### `GET /api/portal?route=dunningStatus&contractId={id}`
Returns dunning recovery status for a subscription:
- Is it in recovery?
- What cards have been tried?
- Is a payment update needed?
- Secure payment update URL

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/app/api/portal/route.ts` | Main portal route handler (replaces standalone backend) |
| `src/lib/portal/auth.ts` | Shopify App Proxy HMAC verification |
| `src/lib/portal/handlers/*.ts` | One file per route handler (ported from subscriptions-portal) |
| `shopify-extension/` | Entire extension directory (copied from shopify-subscriptions-portal) |

## Files to Modify

| File | Change |
|------|--------|
| `shopify-extension/shopify.app.toml` | Update app_proxy URL to shopcx.ai |
| `shopify-extension/portal-src/js/core/api.js` | No change needed (uses relative /apps/portal path) |
| `shopify-extension/portal-src/js/screens/cancel.js` | Upgrade to fetch/render cancel journey |
| `shopify-extension/portal-src/js/actions/cancel.js` | Route through journey instead of hard cancel |
| `CLAUDE.md` | Update with portal integration |

---

## Migration Checklist

1. [ ] Copy extension repo into `shopify-extension/`
2. [ ] Port backend route handlers into `src/lib/portal/handlers/`
3. [ ] Create `/api/portal` route with auth + routing
4. [ ] Replace Appstle client with our `appstle.ts`
5. [ ] Add DB-first lookups for subscriptions/detail
6. [ ] Add event logging to all mutation handlers
7. [ ] Upgrade cancel route to trigger cancel journey
8. [ ] Add dunning status to subscription responses
9. [ ] Add linked account subscriptions
10. [ ] Use `product_reviews` table for reviews endpoint
11. [ ] Update `shopify.app.toml` app proxy URL
12. [ ] Test with Shopify App Proxy signature verification
13. [ ] Deploy backend (Vercel)
14. [ ] Deploy extension (`shopify app deploy`)
15. [ ] Verify end-to-end on storefront

---

## Environment Variables (new)

| Var | Purpose |
|-----|---------|
| `SHOPIFY_APP_PROXY_SECRET` | HMAC verification for portal requests |

Already have: `APPSTLE_API_KEY` (per workspace, encrypted), `KLAVIYO_PRIVATE_KEY` (per workspace, encrypted)

---

## Analytics

Track portal usage in `customer_events`:
- `portal.viewed` — customer opened the portal
- `portal.subscription.paused` — paused via portal
- `portal.subscription.resumed` — resumed via portal
- `portal.subscription.cancelled` — cancelled (went through journey)
- `portal.subscription.saved` — cancel attempted but saved (remedy accepted)
- `portal.subscription.reactivated` — reactivated cancelled sub
- `portal.items.swapped` — product swap
- `portal.items.added` — item added
- `portal.items.removed` — item removed
- `portal.address.changed` — address updated
- `portal.coupon.applied` — coupon applied
- `portal.coupon.removed` — coupon removed
- `portal.frequency.changed` — frequency changed

These feed into the automation analytics dashboard (roadmap item).
