# investors-auth

`src/lib/investors/auth.ts` — the gate primitives for the [[../lifecycles/investors-area]]. Mirror of [[../libraries/../lifecycles/showcase]]'s `src/lib/showcase/auth.ts`, but the credential is a per-person magic link, not a shared password.

## Exports

- `INVESTOR_COMP_ROLES = ["investor","owner"]` + `isInvestorRole(role)` — the allowlist check against the `comp_role` enum ([[../tables/customers]]).
- `INVESTORS_COOKIE_NAME = "investors_session"`, `INVESTORS_COOKIE_MAX_AGE` (30 days), `INVESTOR_MAGIC_EXPIRY_HOURS` (40 days — intentionally longer than the cookie so a late monthly send doesn't strand anyone).
- `mintInvestorSession(customerId, now?)` → `"<customerId>.<issuedAt>.<hmac>"` — signed httpOnly session value; carries the viewer's id so the page/data endpoint can scope to them, no DB hit needed in the proxy.
- `verifyInvestorSession(token, now?)` → `{ customerId } | null` — constant-time HMAC + max-age window.
- `generateInvestorMagicLink(customerId, email, workspaceId)` → `"<SITE>/investors/enter?token=<magicToken>"` — reuses [[magic-link]] `generateMagicToken` (so the entry route verifies with the standard `verifyMagicToken`).
- Re-exports `verifyMagicToken` for the entry route.

Signing key: `ENCRYPTION_KEY` (same fallback discipline as showcase — the cookie holds no secret, just a signed "you clicked a valid link" token scoped to a customer id).

## Callers

- `src/app/investors/enter/route.ts` (mint), `src/proxy.ts` (verify — the gate), `src/app/investors/page.tsx` + `src/app/api/investors/pnl/route.ts` (verify + role-check), `src/app/api/investors/request/route.ts` + [[../inngest/investor-monthly-invite]] (`generateInvestorMagicLink`).

## Related

[[../lifecycles/investors-area]] · [[magic-link]] · [[../lifecycles/showcase]] · [[../tables/customers]]
