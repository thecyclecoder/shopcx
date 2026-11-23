# libraries/winback-shortlink

One SMS shortlink that sends each customer to their own win-back restart page.

**File:** `src/lib/winback-shortlink.ts` · test: `npm run test:winback-shortlink`

## Why

The win-back restart is a per-customer journey session (`/journey/{token}`, bound to one customer
and one subscription — [[reactivate-journey-builder]]). A marketing text has ONE shortlink per
campaign (`sprfd.co/SLUG/CUSTCODE`) with one `target_url` for everyone, so texts could not deep-link
each customer to their own restart page (CEO 2026-11-23, Wave 1 SMS leg).

## How

Set the campaign's shortlink target to the sentinel path `/journey/@winback`, e.g.
`https://shopcx.ai/journey/@winback?fallback=https%3A%2F%2Fsuperfoodscompany.com`. At click time
`/api/sl/[slug]` resolves the customer from the `/CUSTCODE` segment (`customers.short_code`) and
redirects to their newest **pending, unexpired** session of a reactivate journey
(`journey_definitions.trigger_intent` in `REACTIVATE_JOURNEY_TYPES`), keeping the query string (UTMs).
A completed session (restarted or declined) never matches. No customer or no live session → the
`fallback` param, else the site root.

## Exports

- `WINBACK_JOURNEY_SENTINEL_PATH`, `isWinbackSentinel(targetUrl)`
- `buildWinbackRedirect(targetUrl, token | null)` — pure
- `findWinbackToken(admin, workspaceId, customerId)`
- `resolveWinbackTarget(admin, workspaceId, customerId | null, targetUrl)` — never throws

## Audience

Pair with `sms_campaigns.audience_filter.customer_ids` (an allowlist applied in
[[../inngest/marketing-text]] after the consent + phone gates — it can only narrow, never add a
non-subscriber).

[[winback-reactivate-choice]] · [[../README]]
