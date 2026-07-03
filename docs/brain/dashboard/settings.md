# Settings · settings

Settings hub — cards linking to every workspace-level configuration page.

**Route:** `/dashboard/settings`

## Features

**Page title:** Settings

**Visible buttons (heuristic — actual labels in source):**
- Save

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `ad-tool/` → [[settings/ad-tool]]
- `ai/` → [[settings/ai]]
- `amazon-pricing/` → [[settings/amazon-pricing]]
- `auto-close/` → [[settings/auto-close]]
- `cancel-flow/` → [[settings/cancel-flow]]
- `chargebacks/` → [[settings/chargebacks]]
- `chat-widget/` → [[settings/chat-widget]]
- `coupons/` → [[settings/coupons]]
- `dunning/` → [[settings/dunning]]
- `email-filters/` → [[settings/email-filters]]
- `fraud/` → [[settings/fraud]]
- `import/` → [[settings/import]]
- `integrations/` → [[settings/integrations]]
- `journeys/` → [[settings/journeys]]
- `knowledge-base/` → [[settings/knowledge-base]]
- `loyalty/` → [[settings/loyalty]]
- `order-sources/` → [[settings/order-sources]]
- `patterns/` → [[settings/patterns]]
- `playbooks/` → [[settings/playbooks]]
- `policies/` → [[settings/policies]]
- `portal/` → [[settings/portal]]
- `pricing-rules/` → [[settings/pricing-rules]]
- `response-delay/` → [[settings/response-delay]]
- `rules/` → [[settings/rules]]
- `sandbox/` → [[settings/sandbox]]
- `slack/` → [[settings/slack]]
- `storefront-design/` → [[settings/storefront-design]]
- `storefront-domain/` → [[settings/storefront-domain]]
- `subscription-settings/` → [[settings/subscription-settings]]
- `tags/` → [[settings/tags]]
- `text-marketing/` → [[settings/text-marketing]]
- `tracking-sla/` → [[settings/tracking-sla]]
- `views/` → [[settings/views]]
- `workflows/` → [[settings/workflows]]

## API endpoints called

- `/api/workspaces/:x/integrations`
- `/api/workspaces/:x/scrape-help-center`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/settings/page.tsx` — the page itself
- `src/app/dashboard/settings/ad-tool/page.tsx` — sub-route
- `src/app/dashboard/settings/ai/page.tsx` — sub-route
- `src/app/dashboard/settings/amazon-pricing/page.tsx` — sub-route
- `src/app/dashboard/settings/auto-close/page.tsx` — sub-route
- `src/app/dashboard/settings/cancel-flow/page.tsx` — sub-route
- `src/app/dashboard/settings/chargebacks/page.tsx` — sub-route
- `src/app/dashboard/settings/chat-widget/page.tsx` — sub-route
- `src/app/dashboard/settings/coupons/page.tsx` — sub-route
- `src/app/dashboard/settings/dunning/page.tsx` — sub-route
- `src/app/dashboard/settings/email-filters/page.tsx` — sub-route
- `src/app/dashboard/settings/fraud/page.tsx` — sub-route
- `src/app/dashboard/settings/import/page.tsx` — sub-route
- `src/app/dashboard/settings/integrations/page.tsx` — sub-route
- `src/app/dashboard/settings/journeys/page.tsx` — sub-route
- `src/app/dashboard/settings/knowledge-base/page.tsx` — sub-route
- `src/app/dashboard/settings/loyalty/page.tsx` — sub-route
- `src/app/dashboard/settings/order-sources/page.tsx` — sub-route
- `src/app/dashboard/settings/patterns/page.tsx` — sub-route
- `src/app/dashboard/settings/playbooks/page.tsx` — sub-route
- `src/app/dashboard/settings/policies/page.tsx` — sub-route
- `src/app/dashboard/settings/portal/page.tsx` — sub-route
- `src/app/dashboard/settings/pricing-rules/page.tsx` — sub-route
- `src/app/dashboard/settings/response-delay/page.tsx` — sub-route
- `src/app/dashboard/settings/rules/page.tsx` — sub-route
- `src/app/dashboard/settings/sandbox/page.tsx` — sub-route
- `src/app/dashboard/settings/slack/page.tsx` — sub-route
- `src/app/dashboard/settings/storefront-design/page.tsx` — sub-route
- `src/app/dashboard/settings/storefront-domain/page.tsx` — sub-route
- `src/app/dashboard/settings/subscription-settings/page.tsx` — sub-route
- `src/app/dashboard/settings/tags/page.tsx` — sub-route
- `src/app/dashboard/settings/text-marketing/page.tsx` — sub-route
- `src/app/dashboard/settings/tracking-sla/page.tsx` — sub-route
- `src/app/dashboard/settings/views/page.tsx` — sub-route
- `src/app/dashboard/settings/workflows/page.tsx` — sub-route
- `src/app/dashboard/settings/layout.tsx` — component
- `src/app/dashboard/settings/layout.tsx` — layout wrapper

---

[[../README]] · [[../../CLAUDE]]
