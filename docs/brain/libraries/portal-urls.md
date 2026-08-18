# libraries/portal-urls

Canonical customer-facing portal URLs.

**File:** `src/lib/portal-urls.ts`

## File header

```
Canonical customer-facing portal URLs.
Ticket c969f235 (G esposito) is the ground-truth case: she was sent to
`account.superfoodscompany.com/profile` — the SHOPIFY account page — to
tidy up her saved cards. That page is not ours, we have no write access to
the vault behind it, and its "Payment Methods" section does not behave the
way our AI described. She looped for two days looking for a delete button
that was never going to be there.
Shopify is a sunsetting origin (CLAUDE.md § Internal joins use UUIDs), so
there is no longer any reason to hand a customer a Shopify-owned URL. Every
surface that tells a customer where to manage their account — the portal
API payloads, the dunning payload, the orchestrator's knowledge block —
resolves through THIS module so the answer cannot drift per call site.
Host resolution mirrors `getMagicLinkUrl` in [[magic-link]] exactly, so a
link we email and a link we quote in a reply always land on the same host:
1. portal_config.minisite.custom_domain  (e.g. portal.superfoodscompany.com — bare paths)
2. help_custom_domain                    (legacy — paths keep the /portal prefix)
3. {help_slug}.shopcx.ai                 (multi-tenant subdomain)
4. NEXT_PUBLIC_SITE_URL / shopcx.ai      (last-resort fallback)
```

## Exports

### `getPortalUrl` — function

```ts
async function getPortalUrl(workspaceId: string, section: PortalSection = "home", slug?: string | null,) : Promise<string>
```

### `getPaymentMethodsUrl` — function

```ts
async function getPaymentMethodsUrl(workspaceId: string, slug?: string | null) : Promise<string>
```

### `PORTAL_PATHS` — const

```ts
const PORTAL_PATHS
```

### `PortalSection` — type

## Callers

- `src/lib/portal/handlers/dunning-status.ts`
- `src/lib/portal/handlers/subscription-detail.ts`
- `src/lib/sonnet-orchestrator-v2.ts`

## Why

Ticket `c969f235` (G esposito) is the ground-truth case. She asked five times over
two days how to delete two duplicate saved cards. Every surface we had — the
portal payload, the dunning payload, and the orchestrator's knowledge block —
pointed her at `https://account.superfoodscompany.com/profile`, the **Shopify**
account page. That page is not ours: we have no write access to the vault behind
it, so the "scroll to Payment Methods and remove them" steps we described could
never work. She looped looking for a delete button that was never going to exist.

Shopify is a sunsetting origin, so there is no remaining reason to hand a
customer a Shopify-owned URL. This module is the single chokepoint that answers
"where do I send a customer": add a call site here rather than composing a host
inline, so the link we email (via [[magic-link]]) and the link an agent quotes in
a reply can never diverge.

## Gotchas

- **Never hardcode a customer-facing host.** The four surfaces this replaced each
  built their own string; two hardcoded `account.superfoodscompany.com/profile`
  and two composed `https://{shopify_myshopify_domain}/account`. Both land on the
  Shopify account page. If you need a new customer-facing destination, add a
  `PORTAL_PATHS` entry here.
- **Host resolution mirrors [[magic-link]] `getMagicLinkUrl` deliberately.** The
  dedicated portal subdomain (`portal_config.minisite.custom_domain`) serves
  **bare** paths because the middleware rewrites `/payment-methods` →
  `/portal/{slug}/payment-methods` internally; the legacy `help_custom_domain` and
  `{help_slug}.shopcx.ai` hosts keep the `/portal` prefix. `prefixed` on the
  internal `PortalHost` carries that distinction — do not flatten it.
- **`slug` is only meaningful on a prefixed host.** On the portal subdomain it is
  ignored, which is why callers that only hold a workspace id can safely omit it.
- Section paths must stay in sync with `SECTION_PATHS` in
  `src/app/portal/[slug]/portal-client.tsx`.

---

[[../README]] · [[../../CLAUDE]]
