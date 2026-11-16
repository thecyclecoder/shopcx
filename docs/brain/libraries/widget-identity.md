# widget-identity.ts

`src/lib/widget-identity.ts` — verifies the chat widget's **signed identity pass**, the only trusted proof of who is chatting.

**Why:** In ShopGrowth's embedded Shopify admin app the person chatting is staff of a specific store, and only ShopGrowth can prove which (via the Shopify session token). The widget previously trusted whatever email was typed/passed, so anyone could pose as any store — unacceptable once the AI reads store data and takes actions. ShopGrowth mints a short-lived HMAC-SHA256 pass signed with a per-workspace secret; the widget API verifies it and keys the contact to the store, so the merchant never types an email.

Backed by [[../tables/workspaces]] `widget_identity_secret_encrypted` (AES-256-GCM via [[crypto]]). The **signing side lives in ShopGrowth**, which holds the same secret via its env.

## Token format

```
v1.<base64url(payloadJSON)>.<base64url(sig)>
```

- `payloadJSON` = JSON of `{ shop, app, email, name?, exp }`
  - `shop` — the merchant's myshopify domain (e.g. `acme.myshopify.com`)
  - `app` — the ShopGrowth app slug the staff member is chatting from
  - `email` — the staff member's email (the contact key; lowercased on verify)
  - `name` — optional display name
  - `exp` — expiry, **epoch seconds**; must be in the future and **≤ 15 min ahead**
- `sig` = `HMAC-SHA256(secret, "v1.<base64url(payloadJSON)>")`, base64url-encoded

## Exports

| Export | Signature | Notes |
|---|---|---|
| `WidgetIdentityPayload` | `type { shop, app, email, name?, exp }` | The signed payload shape. `exp` is epoch seconds. |
| `VerifiedWidgetIdentity` | `type { shop, app, email, name \| null }` | What a verified pass resolves to. `email` is lowercased/trimmed. |
| `MAX_IDENTITY_EXP_SKEW_MS` | `15 * 60 * 1000` | A pass may expire at most this far ahead — rejects unbounded-lifetime passes. |
| `signWidgetIdentityToken` | `(secret, payload) => string` | Mints a pass. For tests + ShopGrowth parity docs — production signing happens in ShopGrowth. |
| `verifyWidgetIdentityToken` | `(secret, token, nowMs?) => VerifiedWidgetIdentity \| null` | **Pure** verify: constant-time (`timingSafeEqual`) signature compare, exp-in-future-and-≤15min check, shape validation. `nowMs` is injectable for deterministic tests. Fails closed to `null`. |
| `verifyWidgetIdentity` | `(workspaceId, token) => Promise<VerifiedWidgetIdentity \| null>` | Reads `workspaces.widget_identity_secret_encrypted`, decrypts via [[crypto]], delegates to the pure verifier. `null` when no secret is configured, the read fails, or the token is invalid/expired. |
| `identityTags` | `(pass) => string[]` | `['shop:<shop>', 'app:<app>']` — the verified store tags stamped on the customer + ticket. |

Tests: `src/lib/widget-identity.test.ts`, registered as `npm run test:widget-identity` (`tsx --test`). Hermetic (no DB): valid, tampered payload, expired, >15-min-ahead, wrong secret, malformed tokens.

## Callers

- [[../../../src/app/api/widget/[workspaceId]/messages/route.ts]] (POST) — reads the pass from the request body. On **software** workspaces ([[support-mode]]) a valid pass is **required** (401 otherwise); the typed email is never trusted. On **cpg** workspaces the pass is optional but, when valid, its email wins over any typed one. When a pass is present the contact (the `customers` row for `(workspace, pass.email)`) and the ticket both get the `shop:<shop>` + `app:<app>` tags (union merge — no new columns), so the orchestrator tools read shop/app from verified data.

## Client wiring

- `public/widget.js` reads the host's `data-identity` attribute and passes it through to the iframe as `?identity=`.
- `src/app/widget/[workspaceId]/page.tsx` reads `identity` from the URL, hides the email field when a pass is present ("Chatting as your verified store account"), and returns it with every POST/GET.

## Gotchas

- `verifyWidgetIdentityToken` is the security boundary — it is pure and injectable so it is unit-tested directly. Never verify by comparing strings without `timingSafeEqual` (length-guarded, since it throws on mismatch).
- A null secret (column unset) means **every pass fails**. Enable verified identity by setting `widget_identity_secret_encrypted` and sharing the plaintext with ShopGrowth's env.
- Phase 2 (`widget-signed-identity-pass`) extends the same verify to the past-chats `chats` route; see that spec.

---

[[../README]] · [[../../CLAUDE]]
