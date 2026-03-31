# Minisite Routing + Portal Auth — Spec

## Overview

Consolidate the two minisite concepts (help center + customer portal) under a shared subdomain with prefixed paths. Add Shopify Multipass authentication for the portal minisite. Add breadcrumbs to the portal.

**Before**: `superfoods.shopcx.ai` → help center only (rewrite to `/help/{slug}`)
**After**: `superfoods.shopcx.ai/kb/` → help center, `superfoods.shopcx.ai/portal/` → customer portal

---

## 1. Subdomain Routing Changes

### 1a. Middleware update (`src/lib/supabase/middleware.ts`)

Current: subdomain `superfoods.shopcx.ai` rewrites everything to `/help/superfoods{path}`

New routing logic for subdomains:
- `superfoods.shopcx.ai/kb/*` → rewrite to `/help/superfoods/*` (help center, existing pages)
- `superfoods.shopcx.ai/portal/*` → rewrite to `/portal/superfoods/*` (new portal minisite pages)
- `superfoods.shopcx.ai/` → landing page that links to both `/kb/` and `/portal/`
- `superfoods.shopcx.ai/api/portal*` → pass through (existing portal API)
- `superfoods.shopcx.ai/api/help*` → pass through

Same logic for custom domains (e.g., `help.superfoodscompany.com/kb/*`, `help.superfoodscompany.com/portal/*`)

### 1b. Backwards compatibility

- `superfoods.shopcx.ai/article-slug` (old help center URLs without `/kb/` prefix) → 301 redirect to `superfoods.shopcx.ai/kb/article-slug`
- `superfoods.shopcx.ai/` currently shows the help center home → redirect to `/kb/` OR show a landing page

### 1c. Help center internal links

Update all help center pages to use `/kb/` prefix in their internal links:
- `src/app/help/[slug]/page.tsx` — category links, article links
- `src/app/help/[slug]/[articleSlug]/page.tsx` — breadcrumbs, back links
- `src/app/help/[slug]/help-search.tsx` — search result links
- `src/app/help/[slug]/ticket-form.tsx` — form action

Links should be relative to the subdomain, so `/kb/article-slug` (not `/help/superfoods/article-slug`).

---

## 2. Portal Minisite Pages

### 2a. New Next.js pages at `src/app/portal/[slug]/`

The portal minisite is a server-rendered wrapper around the existing Preact portal app. Pages:

- `src/app/portal/[slug]/layout.tsx` — branded layout (logo, colors from workspace config, login/logout)
- `src/app/portal/[slug]/page.tsx` — portal home (redirects to login if not authenticated, otherwise loads the portal Preact app)
- `src/app/portal/[slug]/login/page.tsx` — Shopify Multipass login page
- `src/app/portal/[slug]/callback/page.tsx` — Multipass callback handler

### 2b. How the portal app loads

The portal Preact app currently loads via Shopify App Proxy (`/apps/portal-v2`). On the minisite, it needs to load differently:
- The portal JS bundle (`subscription-portal.js`) is loaded on the page
- The portal API endpoint changes from `/apps/portal-v2?route=X` to `/api/portal?route=X` (direct, no App Proxy HMAC)
- Auth is handled via Multipass session cookie instead of Shopify HMAC

### 2c. Portal auth middleware

For `/portal/{slug}/*` routes:
- Check for session cookie (`portal_session`)
- If valid session: pass through, inject customer ID into portal API calls
- If no session: redirect to `/portal/{slug}/login`

---

## 3. Shopify Multipass Authentication

### 3a. How Multipass works

Shopify Plus feature. We encrypt customer data (email, etc.) with the Multipass secret, generate a token, redirect customer to `https://{shop}/account/login/multipass/{token}`. Shopify logs them in and redirects back to our return URL.

### 3b. Environment / settings

- `SHOPIFY_MULTIPASS_SECRET` — env var or per-workspace encrypted setting
- The Multipass secret is found in Shopify admin > Settings > Customer accounts > Multipass

### 3c. Login flow

1. Customer visits `superfoods.shopcx.ai/portal/`
2. No session → redirected to `/portal/superfoods/login`
3. Login page: "Enter your email to manage your subscription"
4. Customer enters email → we look up the customer in our DB
5. If found: generate Multipass token with their email, redirect to Shopify Multipass URL
6. Shopify authenticates them and redirects back to `superfoods.shopcx.ai/portal/superfoods/callback?token=...`
7. Callback: verify the customer is logged in (via Shopify customer session or our own verification), create session cookie
8. Redirect to portal home

### 3d. Multipass token generation (`src/lib/multipass.ts`)

```typescript
import crypto from "crypto";

export function generateMultipassToken(
  multipassSecret: string,
  customerData: { email: string; return_to: string; created_at?: string }
): string {
  // Derive encryption and signing keys from multipass secret
  const keyMaterial = crypto.createHash("sha256").update(multipassSecret).digest();
  const encryptionKey = keyMaterial.subarray(0, 16);
  const signingKey = keyMaterial.subarray(16, 32);

  // Encrypt customer data
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", encryptionKey, iv);
  const json = JSON.stringify({ ...customerData, created_at: customerData.created_at || new Date().toISOString() });
  const encrypted = Buffer.concat([iv, cipher.update(json, "utf8"), cipher.final()]);

  // Sign
  const signature = crypto.createHmac("sha256", signingKey).update(encrypted).digest();

  // Encode
  return Buffer.concat([encrypted, signature]).toString("base64url");
}
```

### 3e. Session management

After Multipass callback:
- Set `portal_session` cookie with: `{ shopify_customer_id, email, workspace_slug, exp }`
- Signed/encrypted cookie (use our existing ENCRYPTION_KEY)
- Expiry: 24 hours (configurable)
- Session cookie is httpOnly, secure, sameSite=lax

### 3f. Portal API auth for minisite

Currently portal API uses Shopify HMAC verification. For minisite requests:
- Add a second auth path in `src/lib/portal/auth.ts`: if no HMAC params, check for `portal_session` cookie
- Both auth paths resolve to the same `{ workspaceId, loggedInCustomerId, shop }` result
- App Proxy path (HMAC) continues to work for the Shopify-embedded version

---

## 4. Portal Breadcrumbs

### 4a. Breadcrumb component (`shopify-extension/portal-src/js/components/Breadcrumbs.jsx`)

Reusable breadcrumb component matching the old portal style (from the screenshot):
- Person icon → "Manager" → "Subscriptions" → "View"
- Each segment is a link except the last (current page)
- Arrow separator between segments
- Styled to match portal design (muted text, compact)

### 4b. Breadcrumb data per screen

- **Home/Subscriptions list**: Person → Manager → Subscriptions
- **Subscription detail**: Person → Manager → Subscriptions → View
- **Cancel flow**: Person → Manager → Subscriptions → Cancel
- **Banned view**: Person → Manager → Restricted

### 4c. Integration

- Pass breadcrumb data from `App.jsx` router based on current screen
- Render above the main content in each screen
- Clickable segments navigate via the portal router

---

## 5. File Changes Summary

| File | Change |
|------|--------|
| `src/lib/supabase/middleware.ts` | Subdomain routing: `/kb/*` → help, `/portal/*` → portal, backwards compat redirects |
| `src/app/help/[slug]/page.tsx` | Update internal links to use `/kb/` prefix |
| `src/app/help/[slug]/[articleSlug]/page.tsx` | Update links to `/kb/` prefix |
| `src/app/help/[slug]/help-search.tsx` | Update search result links |
| `src/app/portal/[slug]/layout.tsx` | New: branded portal layout |
| `src/app/portal/[slug]/page.tsx` | New: portal home (loads Preact app) |
| `src/app/portal/[slug]/login/page.tsx` | New: email login → Multipass |
| `src/app/portal/[slug]/callback/page.tsx` | New: Multipass callback |
| `src/lib/multipass.ts` | New: Multipass token generation |
| `src/lib/portal/auth.ts` | Add session cookie auth path alongside HMAC |
| `shopify-extension/portal-src/js/components/Breadcrumbs.jsx` | New: breadcrumb component |
| `shopify-extension/portal-src/js/App.jsx` | Pass breadcrumb data to screens |
| `shopify-extension/portal-src/js/screens/SubscriptionDetail.jsx` | Render breadcrumbs |
| `shopify-extension/portal-src/js/screens/Home.jsx` | Render breadcrumbs |
| `shopify-extension/portal-src/js/screens/Cancel.jsx` | Render breadcrumbs |
| `shopify-extension/portal-src/styles/components/_breadcrumb.scss` | Breadcrumb styles |

## Implementation Order

1. Middleware routing changes (kb/ and portal/ prefixes, backwards compat redirects)
2. Help center link updates (all internal links use /kb/ prefix)
3. Portal breadcrumbs (Preact component + integration in all screens + build)
4. Multipass token generation library
5. Portal minisite pages (layout, home, login, callback)
6. Portal auth: session cookie path in auth.ts
7. Portal settings: wire up Multipass secret storage
