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

- **Every upstream `fetch` is bounded by `AbortSignal.timeout(2_000)`.** The middleware runs on Vercel Node.js Fluid Compute with a 300s invocation ceiling; without a per-fetch timeout, a stalled Supabase REST call or Edge Config lookup would lock the whole invocation until that ceiling (fingerprint: 8 identical `/_middleware` 300s timeouts in a burst, signature `vercel:8c4e9b78a6be0b94`). The 2s bound is well under any reasonable middleware budget and each caller's existing `try/catch` already routes an `AbortError` to the same `null`/empty-manifest fallback the code has always used — so a brief upstream stall only degrades the single request, not the whole invocation. Applies to: `resolveShortlinkWorkspaceByDomain`, `resolveStorefrontSlugByDomain`, the help/portal OR-filter workspace lookup inside `updateSession`, and both branches of `loadExperimentManifest` (Edge Config item + same-origin manifest fallback).

---

[[../README]] · [[../../CLAUDE]]
