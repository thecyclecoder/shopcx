# libraries/portal/handlers/sso

Shopify storefront → in-house portal SSO bridge. Logs a Shopify-logged-in customer into `portal.superfoodscompany.com` with no second login.

**File:** `src/lib/portal/handlers/sso.ts` · **Route:** `/api/portal?route=sso` (registered in [[portal__handlers__index]] `routeMap`)

## How it's reached

The Shopify theme account drawer links to the App Proxy at **`/apps/portal-v2?route=sso`** (the proxy can't carry a path tail after `/api/portal`, so SSO is a query-param route like every other handler). Shopify appends the HMAC-verified `logged_in_customer_id`; the dispatcher's `resolveAuth()` validates the signature via `requireAppProxy` ([[portal__auth]]) and hands the handler `{ loggedInCustomerId, workspaceId }`.

## Exports

### `sso` — const

```ts
const sso: RouteHandler
```

Looks up `customers` by `workspace_id` + `shopify_customer_id`, mints a signed magic-link via [[magic-link]] `generateMagicLinkURL`, and returns a **302** to `portal.superfoodscompany.com/login?token=…` (the login page auto-exchanges the token — same path payment-recovery uses). The App Proxy relays the `Location` header back to the browser.

Optional `next` query param (validated same-origin-relative downstream by `magic-login`) deep-links into a portal section.

## Gotchas

- **Returns a redirect, not JSON** — the only portal handler that does. The dispatcher's 4xx error-logging/ticket block only fires on `status >= 400`, so the 302 is untouched.
- **Identity is App-Proxy-verified only.** Never trust a client-supplied customer id — that would be account takeover. Forged/invalid signatures are rejected upstream by `requireAppProxy` (→ 401).
- **Fail-safe fallbacks** always 302 to the bare portal (so a stale or logged-out click never errors): no `loggedInCustomerId`, or no internal `customers` row for that Shopify id yet → the customer signs in normally on the portal.
- The bare-portal host is resolved the same way `generateMagicLinkURL` resolves it (`portal_config.minisite.custom_domain` → `help_custom_domain` → `{help_slug}.shopcx.ai` → `NEXT_PUBLIC_SITE_URL`).

## Callers

Reached via the Shopify App Proxy (theme drawer CTA). No internal callers.

---

[[../README]] · [[portal__handlers__index]] · [[portal__auth]] · [[magic-link]] · [[../lifecycles/customer-portal]]
