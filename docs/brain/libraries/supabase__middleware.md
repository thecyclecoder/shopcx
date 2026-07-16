# libraries/supabase/middleware

Auth + workspace + sandbox + subdomain routing middleware.

**File:** `src/lib/supabase/middleware.ts`

## Exports

### `updateSession` — function

```ts
async function updateSession(request: NextRequest)
```

## Callers

- `src/middleware.ts`

## Gotchas

- **Auth swap to local JWT verify (`db-load-getclaims`, [[db-load-cut-getuser-reauth-fanout]] shipped 2026-07-16).** The middleware now calls `supabase.auth.getClaims()` (local JWT verification against a cached JWKS on asymmetric signing keys — zero auth-table reads) instead of the prior `supabase.auth.getUser()` (five auth-table reads per call). Maps `{ claims.sub → id, claims.email → email, claims.app_metadata }` into a local `user` shape. On legacy HS256 keys `getClaims()` internally falls back to `getUser()` — identical behavior, regression-safe before the key migration. Local verify has no upstream to hang on, so the 2s `Promise.race` timeout the prior `getUser()` call needed is no longer present. Full elimination of auth-table reads lands once the project toggles to asymmetric signing keys in the Supabase dashboard (zero-downtime toggle, not a code change).

- **Other upstream calls are bounded by 2 s.** The middleware runs on Vercel Node.js Fluid Compute with a 300s invocation ceiling; without a per-call timeout, a stalled Supabase REST call or Edge Config lookup would lock the whole invocation until that ceiling (fingerprint: 8 identical `/_middleware` 300s timeouts in a burst, signature `vercel:8c4e9b78a6be0b94`). Each caller's existing `try/catch` already routes the timeout to the same `null`/empty-manifest fallback the code has always used — so a brief upstream stall only degrades the single request, not the whole invocation. Applies to: `resolveShortlinkWorkspaceByDomain`, `resolveStorefrontSlugByDomain`, the help/portal OR-filter workspace lookup inside `updateSession`, and both branches of `loadExperimentManifest` (Edge Config item + same-origin manifest fallback). The direct `fetch` calls use `AbortSignal.timeout(2_000)`.

---

[[../README]] · [[../../CLAUDE]]
