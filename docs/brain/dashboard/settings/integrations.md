# Settings · settings/integrations

All external integrations: Shopify, Resend, Klaviyo, Twilio, EasyPost, Braintree, Avalara, Slack, Meta, Amazon, Google, Census, Versium. Per-integration: connect + status + key fields.

**Route:** `/dashboard/settings/integrations`

## Features

**Page title:** Integrations

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[slug]/` → [[settings/integrations/[slug]]]
- `google-seo/` → [[settings/integrations/google-seo]]
- `meta/` → [[settings/integrations/meta]]
- `meta-ads/` → [[settings/integrations/meta-ads]]

## API endpoints called

- `/api/workspaces/:x/integrations`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/settings/integrations/page.tsx` — the page itself
- `src/app/dashboard/settings/integrations/[slug]/page.tsx` — sub-route
- `src/app/dashboard/settings/integrations/google-seo/page.tsx` — sub-route
- `src/app/dashboard/settings/integrations/meta/page.tsx` — sub-route
- `src/app/dashboard/settings/integrations/meta-ads/page.tsx` — sub-route
- `src/app/dashboard/settings/integrations/_page-full.tsx` — component

---

[[../README]] · [[../../CLAUDE]]
