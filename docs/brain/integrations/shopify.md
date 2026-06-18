# shopify

Shopify Admin API (GraphQL + REST + Bulk Operations) + Storefront API + Customer Account API.

## Auth

**Per-workspace OAuth.** Each workspace installs the ShopCX app on their store; we store the access token encrypted.

- **Encrypted credentials on `workspaces`:**
  - `shopify_client_id_encrypted` — app's Client ID
  - `shopify_client_secret_encrypted` — app's Client Secret
  - `shopify_access_token_encrypted` — long-lived per-shop access token
  - `shopify_multipass_secret_encrypted` — Multipass SSO secret (customer portal login)
- **Plain text on `workspaces`:**
  - `shopify_domain` — myshopify subdomain (e.g. `superfoodscompany`)
  - `shopify_myshopify_domain` — resolved canonical domain
  - `shopify_primary_domain` — store's primary (custom) domain
  - `shopify_scopes` — granted scope list (text)
  - `shopify_oauth_state` — in-flight OAuth state nonce
- **App-level (no per-workspace fallback):** None — must be configured per workspace.
- **HMAC verification** for OAuth redirect + webhooks: `verifyShopifyHmac()` in `src/lib/shopify.ts` uses Client Secret.

Scopes: see `SHOPIFY_SCOPES` in `src/lib/shopify.ts` — read_all_orders, write_customers, write_discounts, write_draft_orders, read_inventory, `read_content` (blog import — see [[../lifecycles/blog-resources]]), `read_themes`/`write_themes` (theme management, below), etc.

## API version

`SHOPIFY_API_VERSION = "2025-07"` (`src/lib/shopify.ts`).

## Key endpoints we call

| Surface | Where | Purpose |
|---|---|---|
| GraphQL Admin | `https://{shop}.myshopify.com/admin/api/{version}/graphql.json` | Most reads + mutations. `shopifyGraphQL()` in `src/lib/shopify-sync.ts`. |
| Bulk Operations | GraphQL `bulkOperationRunQuery` | Customer + order + product imports (free, async). `startBulkOperation()` / `pollBulkOperation()`. |
| REST Admin | `https://{shop}.myshopify.com/admin/api/{version}/...` | Rarely — used when GraphQL is missing the surface. |
| Storefront API | `https://{shop}.myshopify.com/api/{version}/graphql.json` | Public-side cart bridge for landing pages (Storefront access token). |
| App Proxy | `https://shopcx.ai/api/portal` | Shopify forwards customer portal requests (subpath `portal-v2`, prefix `apps` → storefront `/apps/portal-v2`), HMAC-signed. `SHOPIFY_APP_PROXY_SECRET` env. Sub-actions are **query params** (`?route=…`), not path tails. `?route=sso` → storefront→portal SSO: the theme account drawer links to `/apps/portal-v2?route=sso`, the [[../libraries/portal__handlers__sso]] handler mints a magic-link from the verified `logged_in_customer_id` and 302s into `portal.superfoodscompany.com` already logged in. |
| Multipass | `https://{shop}.myshopify.com/account/login/multipass/...` | SSO for customer portal. Uses `shopify_multipass_secret_encrypted`. |

Common mutations used:
- `customerEmailMarketingConsentUpdate` / `customerSmsMarketingConsentUpdate` — see `src/lib/shopify-marketing.ts`
- `customerPaymentMethods` — for dunning card rotation
- `orderCreate` / `orderUpdate` / `refundCreate`
- `returnCreate` / `reverseFulfillmentOrderCreate` — see `src/lib/shopify-returns.ts`
- `tagsAdd` / `tagsRemove` — for fraud holds
- `subscriptionContractUpdate` + `subscriptionDraftLineAdd/Remove/Update` + `subscriptionDraftCommit` — see `src/lib/shopify-subscriptions.ts`
- `storeCreditAccountCredit` — see `src/lib/store-credit.ts`

## Rate limits + retry

- GraphQL: leaky bucket, 1000 cost units bucket, refills 50/sec. Per-app per-shop.
- REST: 40 calls/sec burst, 2/sec leak.
- `fetchWithRetry()` in `src/lib/shopify-sync.ts` retries on 429 + 5xx with exponential backoff.
- Bulk Operations are queued — only one per shop at a time. `cancelBulkOperation()` clears a stuck one.

## Webhooks

Registered via `src/lib/shopify-webhook-register.ts`. Handled in `src/lib/shopify-webhooks.ts`. Topics include:
- `customers/create`, `customers/update`, `customers/merge`
- `orders/create`, `orders/updated`, `orders/cancelled`, `orders/fulfilled`
- `customer_payment_methods/create`, `customer_payment_methods/update` — drive dunning recovery
- `disputes/create`, `disputes/update` — chargebacks
- `app/uninstalled`

Webhook HMAC verified with Client Secret.

## Gotchas

- **Bulk operation 1-at-a-time per shop.** A stale poll can leave one stuck; call `cancelBulkOperation()` and restart.
- **Online Store channel only** for product sync — we filter via `publications` API to skip POS-only / draft products.
- **GraphQL `id` fields are GIDs** (`gid://shopify/Customer/123`). Use `extractShopifyId()` in `src/lib/shopify-sync.ts` to get the numeric id.
- **`shopify_customer_id` / `shopify_order_id` etc. stored as numeric strings**, never as ints. Joins to our tables use UUIDs — see [[../tables/customers]] gotchas.
- **Webhook delivery is at-least-once.** Handlers must be idempotent.
- **Multipass tokens are short-lived** (5 min). Generate fresh per portal redirect.
- **Don't push during active syncs.** Vercel deployment kills running Inngest functions mid-flight.

## Files

- `src/lib/shopify.ts` — OAuth URL builder, HMAC verifier, constants
- `src/lib/shopify-sync.ts` — Bulk ops + GraphQL helper + paginated sync
- `src/lib/shopify-webhooks.ts` — Webhook handlers
- `src/lib/shopify-webhook-register.ts` — Webhook registration
- `src/lib/shopify-marketing.ts` — Marketing consent mutations
- `src/lib/shopify-order-actions.ts` — Refunds, cancellations, address updates
- `src/lib/shopify-order-tags.ts` — `tagsAdd` / `tagsRemove`
- `src/lib/shopify-returns.ts` — Return creation + label + refund
- `src/lib/shopify-subscriptions.ts` — Subscription draft workflow
- `src/lib/shopify-draft-orders.ts` — Draft order creation
- `src/lib/shopify-customer-update.ts` — Customer mutations
- `src/lib/multipass.ts` — Multipass SSO
- `src/lib/shopify-theme.ts` — theme read (Shopify) + write (GitHub commit) — see Theme management

## Theme management (via ShopCX)

The live theme (`theme-superfoodscompany.com/master`, role MAIN) is managed through its **GitHub repo** (`thecyclecoder/theme-superfoodscompany.com@master`) — Shopify's GitHub integration auto-deploys commits. ShopCX reads the live theme via the Shopify theme-files API (`read_themes`) and writes by committing to the repo (`GITHUB_TOKEN`). Lib: `src/lib/shopify-theme.ts` (`getLiveTheme` / `listLiveThemeFiles` / `readThemeFile` / `commitThemeFiles` / `verifyDeployed`). Reconcile drift with `scripts/reconcile-shopify-theme.ts` (semantic JSON diff — Shopify serves JSON theme files as JSONC with a `/* auto-generated */` header). How-to + the single-writer guardrail: [[../recipes/edit-shopify-theme]]. Short-term until the in-house storefront retires Shopify.

## Related

[[../tables/customers]] · [[../tables/orders]] · [[../tables/products]] · [[../tables/product_variants]] · [[../tables/subscriptions]] · [[../tables/customer_payment_methods]] · [[../tables/store_credit_log]] · [[../tables/import_jobs]] · [[../tables/posts]] · [[../lifecycles/blog-resources]] · [[../libraries/shopify-theme]] · [[../recipes/edit-shopify-theme]] · [[../inngest/sync-shopify]] · [[../inngest/today-sync]] · [[../inngest/sync-inventory]]
