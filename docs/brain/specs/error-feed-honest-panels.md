# Error-Feed Panels: "Not Connected" ≠ "0 Errors" 🚧

**Owner:** [[../functions/platform]] · **Parent:** extends [[error-feed-monitoring]] + the supervisable-autonomy north star ([[../operational-rules]] § North star). Closes a Goodhart trap in our own observability.

The Control Tower's three error panels (Vercel · Inngest · Supabase) show **green "0 errors"** even when the **source isn't actually connected** — `error_events` has 0 rows because the feeds are forward-only AND partly unwired (the Vercel log drain isn't created, the Supabase Management token isn't set). A disconnected monitor reading "all clear" is the *exact* silent-failure the Control Tower exists to catch. Make the panels honest: distinguish **"we're watching and it's clean" (green)** from **"we're not watching" (amber).**

## Model — each feeder reports liveness, not just errors
- **A feed "received" heartbeat.** Each source records a lightweight "last received a delivery at" timestamp (separate from error rows): the Vercel drain on any POST (even a clean batch), the Inngest failure-capture is implicitly live (its presence in the function list + the cron-freshness of Inngest itself), the Supabase poller on each successful poll. Store per-source (a small `error_feed_status` row or reuse `loop_heartbeats` with a `feed:<source>` id).
- **Panel state derives from connection + recency, not just count:**
  - **No secret / not configured** (e.g. `VERCEL_LOG_DRAIN_SECRET` unset, or `SUPABASE_MANAGEMENT_TOKEN` unset) → **amber "not configured"** + a one-line "how to wire" hint. Never green.
  - **Configured but zero deliveries ever** → **amber "awaiting first event — not yet verified live."**
  - **Received deliveries, zero errors in window** → **green "0 errors · connected (last delivery Ns ago)."** ← the only true green.
  - **Errors present** → red/amber by recency (today's behavior).
- **Self-honest count:** the dashboard header "N healthy / M alerting" must not count an unconfigured panel as healthy.

## Guardrail
This is the north star applied to our own tooling: a monitor must never present **proxy-success ("0 rows") as objective-success ("system healthy")** when it isn't even observing. A panel that can't see its source says so, loudly (amber), and tells the owner how to connect it.

## Verification
- With `VERCEL_LOG_DRAIN_SECRET` unset → Vercel panel is **amber "not configured"**, not green; header doesn't count it healthy.
- Configure the drain + set the secret, before any log arrives → **amber "awaiting first event."** Send a clean (non-error) batch → **green "0 errors · connected, last delivery Ns ago."**
- Force a 500 → red with the grouped signature (today's behavior), unchanged.
- Supabase panel with no `SUPABASE_MANAGEMENT_TOKEN` → amber "not configured"; with the token + a successful poll + no errors → green "connected."
- Inngest panel: green "connected" only once the failure-capture fn is confirmed registered (in the deployed function list) — else amber.

## Phase 1 — connection-aware panel states + received-heartbeats ✅
Per-source "received" heartbeat + the configured/awaiting/connected/error state machine in [[../libraries/control-tower]] `buildErrorFeedSnapshot`; the panel renders amber "not configured"/"awaiting first event" vs green "connected · 0 errors"; the header health count excludes unconfigured panels. Brain: [[../dashboard/control-tower]] · [[../libraries/control-tower]] · [[error-feed-monitoring]].

**Shipped:** `recordFeedDelivery(source)` / `feedLoopId(source)` write `feed:<source>` liveness beats to [[../tables/loop_heartbeats]] (`kind='feed'`) — emitted on each clean Vercel drain POST (`/api/webhooks/vercel-logs`) and each successful Supabase-logs poll (`pollSupabaseLogs`). `buildErrorFeedSnapshot` now returns connection-aware panels (`connectionState`/`configured`/`lastReceivedAt`/`statusText`/`hint`): **errors** → red/amber by recency (unchanged) · **not configured** (`VERCEL_LOG_DRAIN_SECRET` unset · no stored Supabase token) → amber + how-to-wire hint · **configured + 0 deliveries ever** → amber "awaiting first event" · **configured + received + clean** → green "connected · 0 errors (last delivery Ns ago)". Inngest liveness is proxied by the latest `cron` beat (failure-only feed, no clean delivery to observe); the app-layer `supabase` panel needs no receipt (`reportDbError` is wired unconditionally). `GET /api/developer/control-tower` folds the panel colors into the header health count so an unconfigured (amber) panel is never counted healthy. Dashboard renders `statusText` + `hint`. `npx tsc --noEmit` clean.
