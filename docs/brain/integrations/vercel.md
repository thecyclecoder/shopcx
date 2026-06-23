# integrations/vercel

The hosting + edge platform. This page covers **Vercel Edge Config** as used by the PDP edge-served A/B ([[../libraries/experiment-manifest]]); the broader Vercel surface (deploys, ISR, log drain) is covered in [[vercel-log-drain]] and the deploy notes in `CLAUDE.md`.

## Edge Config — the active-experiment manifest store

**What:** a globally-replicated, ultra-low-latency read-only KV that the edge middleware can read without a network round-trip to origin. Used to hold the **active-experiment manifest** (`storefront_experiment_manifest` key) so `src/lib/supabase/middleware.ts` can sticky-assign a PDP variant at the edge per request (pdp-edge-served-experiments).

### Status — NOT YET PROVISIONED (owner step)
As of 2026-06-23 no Edge Config store is connected (`EDGE_CONFIG` is unset). The system runs the **cached-JSON-blob fallback**: the middleware fetches `GET /api/storefront/experiment-manifest` (short `s-maxage`, module-cached 15s) instead of Edge Config. This is correct but adds one same-origin fetch per ~15s per edge instance and propagates state changes within ~15s rather than sub-second.

**To provision (optimal):**
1. Vercel dashboard → project `shopcx` → Storage → **Create Edge Config** (e.g. `shopcx-experiments`), connect it to the project. This injects the `EDGE_CONFIG` connection string env automatically.
2. Add two more env vars for the optimizer's write path: `EDGE_CONFIG_ID` (the `ecfg_…` id) and `VERCEL_API_TOKEN` (a token with Edge Config write scope).
3. Redeploy. `isEdgeConfigWriteConfigured()` flips true → `publishExperimentManifest` PATCHes the Edge Config item on every experiment state change (sub-second, no deploy); the middleware reads the item directly via the connection string's HTTP endpoint (no origin fetch).

No code change is needed — both the read path (middleware) and the write path (`publishExperimentManifest`) already branch on the env and activate automatically once the store + tokens are present.

### Endpoints
- **Read (middleware):** `GET ${EDGE_CONFIG}/item/storefront_experiment_manifest` (the connection string carries the read token in its query).
- **Write (optimizer):** `PATCH https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items` with `Authorization: Bearer ${VERCEL_API_TOKEN}`, body `{ items: [{ operation: "upsert", key, value }] }`.

### Credentials
- `EDGE_CONFIG` — connection string (read token embedded). Injected on connect.
- `EDGE_CONFIG_ID` — `ecfg_…` store id (write path).
- `VERCEL_API_TOKEN` — Vercel API token, Edge Config write scope (write path).

### Gotchas
- **Read-only at the edge.** Edge Config is for reads; writes go through the Vercel REST API from the server (the optimizer), never the middleware.
- **Fallback is always safe.** If the manifest read fails (missing key, fetch error) the middleware degrades to "no experiment → the real cached PDP" — never an error to the shopper.
- **Propagation, not transactions.** Edge Config upserts replicate within ~seconds; the manifest is advisory (the page re-guards `_sxv` against the DB), so a brief staleness only means a visitor lands on control until replication completes.
