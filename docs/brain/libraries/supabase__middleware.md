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

- **Every upstream call is bounded by 2 s.** The middleware runs on Vercel Node.js Fluid Compute with a 300s invocation ceiling; without a per-call timeout, a stalled Supabase REST call, Edge Config lookup, or GoTrue auth check would lock the whole invocation until that ceiling (fingerprint: 8 identical `/_middleware` 300s timeouts in a burst, signature `vercel:8c4e9b78a6be0b94`). Each caller's existing `try/catch` (or, for the auth call, the existing unauthenticated branch) already routes the timeout to the same `null`/empty-manifest fallback the code has always used — so a brief upstream stall only degrades the single request, not the whole invocation. Applies to: `resolveShortlinkWorkspaceByDomain`, `resolveStorefrontSlugByDomain`, the help/portal OR-filter workspace lookup inside `updateSession`, both branches of `loadExperimentManifest` (Edge Config item + same-origin manifest fallback), and `supabase.auth.getUser()` inside `updateSession`. The direct `fetch` calls use `AbortSignal.timeout(2_000)`; supabase-js's auth methods do not accept an `AbortSignal`, so `supabase.auth.getUser()` is bounded via a `Promise.race` against a 2 s timer that resolves to `{ data: { user: null } }` — on timeout the middleware falls through to the existing unauthenticated code path (public routes pass, protected routes redirect to `/login`).

---

[[../README]] · [[../../CLAUDE]]
