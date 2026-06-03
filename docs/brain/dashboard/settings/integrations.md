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

## Ad tool — Higgsfield card

A **Higgsfield** card (powering the [[../../lifecycles/ad-render|ad tool]]) sits alongside the others. Unlike the single-key integrations, Higgsfield is **dual-credential**: an API key **and** a secret, both pasted, both stored AES-256-GCM encrypted on `workspaces` (`higgsfield_api_key_encrypted` + `higgsfield_secret_encrypted`). A **Verify connection** button calls `probeHiggsfieldAuth` (`GET /v1/motions`) to confirm the pair before saving. See [[../../integrations/higgsfield]].

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

## Related

[[../../integrations/shopify]] · [[../../integrations/appstle]] · [[../../integrations/klaviyo]] · [[../../integrations/resend]] · [[../../integrations/twilio]] · [[../../integrations/easypost]] · [[../../integrations/braintree]] · [[../../integrations/avalara]] · [[../../integrations/meta-graph]] · [[../../integrations/meta-marketing]] · [[../../integrations/anthropic]] · [[../../integrations/openai]] · [[../../integrations/inngest]]

---

[[../README]] · [[../../CLAUDE]]
