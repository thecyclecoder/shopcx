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
- `order_placed` event (emitted server-side at `/api/checkout`, ~1083-1098) carries `meta.{order_id, order_number, total_cents, cart_token, product_id}` + **`session_id` + `anonymous_id`**. **This is the only place the order ties to a session.**
- ⚠️ **The `orders` table has NO `session_id` / `anonymous_id` — only `cart_token`.** So order→session today is an indirect join: `orders.cart_token` → `order_placed` event (`meta.cart_token`) → `session_id`.

## 4. Experiment exposure + attribution (where it breaks)
- **Exposure emit:** `resolveExperimentsForRender` (`src/lib/storefront/experiments.ts`) assigns an arm at render (advertorial landers) → passed to the client → **`StorefrontPixelInit` emits a client-side `experiment_exposure` event**; bare-PDP uses the edge `sx_variant` cookie → client emit. **It's a client event, and it under-fires.**
- **Attribution** (`src/lib/storefront/experiment-attribution.ts`): a variant's **sessions = distinct `anonymous_id` that fired `experiment_exposure` for it**; a **conversion = an `order_placed` event with the same `anonymous_id` within 14 days**. Funnel rates (`experiment-funnel.ts`) key off the exposure's `session_id`.
- **THE BUG (verified 2026-06-23):** 157 sessions/24h (139 clean, 110 on advertorial landers) produced only **3 `experiment_exposure` events**; a real converting session (`aac6f348`, clean, advertorial) had **0**. Because attribution is built *entirely* on that flaky client exposure event keyed by `anonymous_id`, ~all real sessions + conversions go uncounted → the test page shows ~0 sessions and conversions never attribute to an arm. It is **not** the bot/internal drop (only 18 of 157 flagged) — it's the **emission**.

## Status / open work
- **Fix:** [[../specs/experiment-session-stamped-attribution]] — stamp the **session** with `{experiment_id, arm}` reliably at the edge/server (off `sx_variant`), store **`session_id` on the storefront order**, attribute off the session stamp + in-session `order_placed` (retire the flaky `anonymous_id`+exposure-event match), and add a **Journey panel** on the order detail page. ⏳
