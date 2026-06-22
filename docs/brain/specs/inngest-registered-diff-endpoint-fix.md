# Fix the Inngest in-code-vs-registered diff — wrong REST endpoint (404) 🚧

**Owner:** [[../functions/platform]] · **Parent:** fixes the ⚠️-flagged gap in [[control-tower-complete-coverage]] (P2 self-audit).

[[control-tower-complete-coverage]] P2 shipped `diffInngestRegistered()` (the CODE↔INNGEST-registered diff that catches a function served-in-code but not registered with Inngest — the `control-tower-monitor` "never registered" class). The spec **flagged it ⚠️ "needs prod verification."** A live probe (human-queue workflow, 2026-06-22) confirmed the bug: it calls **`GET https://api.inngest.com/v1/apps` → HTTP 404**, so the diff **can never reach `status:'ok'`** — it always falls to `{status:'unverified', missing:[]}`. The fail-safe half is correct (no false alarm without the key), but the diff **never actually runs**, so the registration-gap check is dead.

## Fix
- **Correct endpoint:** `GET https://api.inngest.com/v1/apps/shopcx/functions` (auth with `INNGEST_SIGNING_KEY`). Returns a **flat array of ~136 functions keyed by `id`** (e.g. `shopcx-sync-shopify`), with **no `slug` field** — so parse `id`, not `slug`.
- **Match against our served set** by the same `id` shape (the app-prefixed function id), reusing `registered-functions.ts`. A served function whose `id` is absent from the Inngest list ⇒ `missing` (the real "served but not registered" signal).
- Keep the fail-safe: no `INNGEST_SIGNING_KEY` ⇒ `unverified` (no false alarm), unchanged. After the fix, with the key set, the diff returns `status:'ok'` + the true missing set.

## Verification
- With `INNGEST_SIGNING_KEY` in prod, `diffInngestRegistered()` returns `status:'ok'` (not `'unverified'`) and `missing:[]` when everything's registered; a `GET /v1/apps/shopcx/functions` returns the ~136-function array (HTTP 200, not 404).
- Serve a new function in code without deploying/syncing it to Inngest → it appears in `missing` (the gap the check exists to catch).
- No key → still `unverified`, no false alarm (unchanged).

## Phase 1 — correct endpoint + id-keyed parsing ✅
Fixed `fetchInngestRegisteredFnIds` (`src/lib/control-tower/self-audit.ts`): endpoint now `GET /v1/apps/shopcx/functions`, parses the flat array (each function keyed by an app-prefixed `id`, no `slug`), strips the `shopcx-` prefix, and matches against the served ids — so `diffInngestRegistered` reaches `status:'ok'` instead of always falling to `'unverified'`. Fail-safe unchanged (no key / non-2xx / unexpected shape ⇒ `unverified`). `npx tsc --noEmit` clean. Brain library page [[../libraries/control-tower-self-audit]] updated. Awaiting prod verification (see ## Verification — needs `INNGEST_SIGNING_KEY`, no creds on the build box). Brain: [[../libraries/control-tower-self-audit]] · [[../integrations/inngest]] · [[control-tower-complete-coverage]].
