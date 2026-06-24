# Storefront session → journey → attribution

How a storefront visitor becomes a tracked session, how their journey is logged, how an order links back to it, and how experiment arms + conversions are attributed. **Written 2026-06-23 to close a real knowledge gap** that was masking a reporting bug (verified against the code; file:line cited).

## 1. Session — every visitor gets one
- Created in **`src/app/api/pixel/route.ts`** (`persistEvents`, ~256-385) on the first pixel hit. Upserted on **`(workspace_id, anonymous_id)`**.
- **`anonymous_id`** = a client UUID in the **`sid` cookie** (`src/lib/storefront-pixel.ts` `getOrCreateAnonymousId`, 365-day, first-party). This is the identity everything keys on pre-purchase.
- **`customer_id`** = null until identified; back-stamped on checkout (`/api/checkout` `stitchVisitor`, ~1002-1007) or `identify()`.
- **`is_internal`** (from `sx_internal=1` cookie) + **`is_bot`** (datacenter-IP check) are set at insert and **stick**. ⚠️ Both **silently drop `experiment_exposure` events at write** (`api/pixel.ts:390-398`, `SKIP_FOR_INTERNAL_BOT`).
- `storefront_sessions` columns: `id · workspace_id · anonymous_id · customer_id · first_seen_at · last_seen_at · device/os/browser/viewport · ip_country/region/city · landing_url · referrer · utm_* · fbclid/gclid/ttclid/fbp/fbc · is_internal · is_bot · advertorial_page_id · ad_campaign_id`. **(No `converted`, no `landing_path`, no `experiment_*` — don't query those.)**

## 2. Journey — `storefront_events`
- Written via the same `/api/pixel` POST batch. Columns: `id · workspace_id · session_id (→ storefront_sessions.id) · anonymous_id · customer_id · event_type · product_id · **meta (jsonb)** · url · created_at`. **The jsonb column is `meta`, NOT `metadata`.** Idempotent upsert (`ignoreDuplicates`).
- Event types (the funnel): `pdp_view → chapter_view/chapter_dwell/scroll_depth → pdp_engaged → pack_selected → add_to_cart → cta_click → checkout_view → order_placed` (+ `lead_captured`, `experiment_exposure`).

## 3. Order ↔ session link
- `order_placed` event (emitted server-side at `/api/checkout`, ~1083-1098) carries `meta.{order_id, order_number, total_cents, cart_token, product_id}` + **`session_id` + `anonymous_id`**.
- **`orders.session_id` + `orders.anonymous_id` are now first-class** (experiment-session-stamped-attribution Phase 2) — written at `/api/checkout` § 10c from the converting session it resolves for the `order_placed` event. The indirect join (`orders.cart_token` → `order_placed` event → `session_id`) is retired for new orders; `scripts/backfill-order-session-link.ts` fills the back catalogue from each order's `order_placed` event.

## 4. Experiment arm stamp + attribution (the fix)
- **Session stamp (canonical):** the arm is persisted on `storefront_sessions.experiment_assignments` (jsonb `[{experiment_id, variant_id, arm, assigned_at, surface}]`) server/edge-side at **`/api/pixel`** the moment it's known — from the edge `sx_variant` cookie (PDP) and from the `experiment_assignments` field the pixel flush carries (advertorial, resolved in `resolveExperimentsForRender`). **Sticky: first assignment per experiment wins.** NOT dependent on the client `experiment_exposure` event (kept only as a secondary signal). Internal/bot sessions ARE stamped but excluded at the reporting layer.
- **Attribution** ([[../libraries/storefront-experiment-attribution]]): a variant's **sessions = `storefront_sessions` stamped to that arm** (excluding `is_internal`/`is_bot`); a **conversion = an `orders` row whose `session_id` is one of those stamped sessions** (in-session, no 14-day `anonymous_id` window). Funnel rates ([[../libraries/storefront-experiment-funnel]]) key off the same stamped-session spine.
- **History — THE BUG (verified 2026-06-23, now fixed):** attribution used to rest *entirely* on the client `experiment_exposure` event keyed by `anonymous_id` — 157 sessions/24h produced only **3** exposures (a real converting session `aac6f348` had **0**), so ~all sessions + conversions went uncounted. The session stamp replaces it.

## 5. Order-detail Journey panel (Phase 4)
- On a storefront/`SHOPCX` order at `/dashboard/orders/[id]`, a **Journey panel** joins `orders.session_id` → the session + its `storefront_events` timeline: **source** (lander + `?variant=`, UTM/ad), **experiment + arm** (from the session stamp), and the **funnel steps** (landing → pdp_view → chapters engaged → add_to_cart → checkout → order_placed, with timestamps). A synced Shopify order with no `session_id` shows no panel. See [[../dashboard/orders]].

## Status / open work
- **Shipped:** session arm stamp ([[../tables/storefront_sessions]]`.experiment_assignments`), first-class [[../tables/orders]]`.session_id`, session-stamped attribution ([[../libraries/storefront-experiment-attribution]]) + funnel ([[../libraries/storefront-experiment-funnel]]), and the order-detail Journey panel (Phases 1–4). ✅ Folded + archived 2026-06-24 → [[../archive]].
- **Known gap / not yet run (spec Phase 3.5):** historical-session backfill. Assignment is a **pure deterministic** `assignVariant(anonymous_id, experiment, variants)` (sticky hash, no stored state), so any past `storefront_session` that hit a running experiment's surface (matching product × lander_type × audience, within the run window) can have its arm **recomputed from `anonymous_id`** — using the *same* render params (holdout/conservative bands) — and stamped, recovering the ~107/day previously-untracked sessions + their conversions. One-off idempotent backfill script.
