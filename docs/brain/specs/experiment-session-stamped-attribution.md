# Session-stamped experiment attribution + order journey ✅

**Owner:** [[../functions/growth]] · **Parent:** fixes [[../lifecycles/storefront-session-attribution]] — the experiment reporting is wrong because attribution rests on a flaky client `experiment_exposure` event.

**Found in use 2026-06-23** (verified against code + live data): the storefront test page shows ~0 sessions and conversions don't attribute to arms. Root cause — attribution counts a variant's sessions as *distinct `anonymous_id` that fired a client-emitted `experiment_exposure` event*, and a conversion as a matching `anonymous_id` `order_placed` within 14 days ([[../libraries/experiment-attribution]]). But that client exposure event **barely fires**: 157 sessions/24h (139 clean, 110 on advertorial landers) → only **3 exposures**; a real converting session (`aac6f348`, clean, advertorial, $121.61 Amazing Coffee) had **0**. And the `orders` table has **no `session_id`**, so orders can't join the journey directly.

**The fix (owner direction): make the assignment stick to the SESSION, server/edge-side — not a client event.** The edge already resolves the arm (sets `sx_variant=experimentId:variantId[:h]`); persist that on the session and attribute off it.

## Phase 1 — stamp the session with its arm ✅
- Add **`experiment_assignments` (jsonb)** to `storefront_sessions` — `[{experiment_id, variant_id, arm: control|variant|holdout, assigned_at, surface}]`.
- **Write it server-side**, reliably, the moment the arm is known: (a) the edge/`/api/pixel` reads the `sx_variant` cookie + stamps the session; (b) `resolveExperimentsForRender`'s assignment is persisted to the session on the render's pixel call — **not** dependent on the client `experiment_exposure` emit. Internal/bot sessions are still stamped (so previews/QA are inspectable) but **excluded at the reporting layer**, not silently dropped at write.
- Keep the `experiment_exposure` event as a secondary signal, but the **session stamp is canonical**.

## Phase 2 — first-class order ↔ session link ✅
- Add **`session_id` (+ `anonymous_id`) to the `orders` table**; `/api/checkout` writes them at order creation (it already resolves the session for the `order_placed` event — persist it on the order too). Backfill recent storefront orders from their `order_placed` event where possible.

## Phase 3 — attribute off the session stamp ✅
- Rewrite [[../libraries/experiment-attribution]] + [[../libraries/experiment-funnel]]: a variant's **sessions = `storefront_sessions` stamped to that arm** (excluding internal/bot); a **conversion = a storefront `orders` row whose `session_id` is stamped to that arm** (in-session, no 14-day anonymous_id guesswork). Funnel rates off the stamped sessions' events. This is reliable + literal.

## Phase 3.5 — backfill past sessions (the data isn't lost) ⏳
Assignment is a **pure deterministic function** `assignVariant(anonymous_id, experiment, variants)` (sticky hash, no stored state). So for every historical `storefront_session` that hit a running experiment's surface (matching product × lander_type × audience, within the experiment's run window), **recompute its arm from `anonymous_id`** and write the same `experiment_assignments` stamp — recovering the ~107/day untracked sessions + their conversions (e.g. SHOPCX30 = CONTROL on the listicle, verified by computing it live 2026-06-23). One-off backfill script + idempotent. (Holdout/conservative bands must use the *same* params as the live render so the recomputed arm matches what was actually served.)

## Phase 4 — Journey panel on the order detail page ✅
- On a storefront/`SHOPCX` order in `/dashboard/orders/[id]`: a **Journey panel** joining `orders.session_id` → the session + its `storefront_events` timeline: **source** (lander + `?variant=`, UTM/ad), **experiment + arm** (from the session stamp), and the **funnel steps** (landing → pdp_view → chapters engaged → add_to_cart → checkout → order_placed, with timestamps).

## Verification
- **Migrations applied** — `select column_name from information_schema.columns where table_name='storefront_sessions' and column_name='experiment_assignments'` → 1 row; same for `orders` columns `session_id` + `anonymous_id`. (Run via `npx tsx scripts/apply-session-stamped-attribution-migration.ts`.)
- **Phase 1 stamp (advertorial)** — as a real (non-`sx_internal`) visitor, load an experiment advertorial lander (`?variant=advertorial&angle=…` on a product with a running experiment) → that session's `storefront_sessions.experiment_assignments` carries `{experiment_id, variant_id, arm, surface:"advertorial"}`, even with no `experiment_exposure` row. Across a day, ≥~all advertorial sessions get stamped (not ~3).
- **Phase 1 stamp (edge PDP)** — load a bare PDP under a running PDP experiment (middleware sets `sx_variant`) → the session is stamped with `surface:"pdp"` and the correct `arm` (control/variant/holdout), read server-side from the cookie at `/api/pixel`.
- **Internal/bot still stamped, excluded from reports** — visit a lander with `?sx_internal=1` → the session IS stamped (`is_internal=true`), but it does NOT appear in `refreshExperimentAttribution`/`computeExperimentFunnel` counts (both filter `is_internal=false, is_bot=false`).
- **Phase 2 order link** — place a storefront order → its `orders` row carries `session_id` + `anonymous_id`. Historical orders: `npx tsx scripts/backfill-order-session-link.ts --apply` fills them from each order's `order_placed` event.
- **Phase 3 attribution** — on `/dashboard/marketing` storefront test detail (`GET /api/workspaces/{id}/storefront-experiments/{experimentId}`), each arm's `sessions` = stamped sessions for that arm and `conversions` = stamped sessions whose `orders.session_id` matches; an `aac6f348`-class converting session attributes to its arm.
- **Phase 4 journey** — open a storefront order at `/dashboard/orders/[id]` whose session resolves → a **Journey** panel renders: Source (lander slug + `?variant=`, UTM/ad campaign), Experiment + arm badge, and the Funnel (landing → pdp_view → engaged → add_to_cart → checkout → order_placed) with timestamps. A synced Shopify order with no `session_id` shows no panel.
- **Negative** — a session that hit no experiment has `experiment_assignments = []` and is counted in no arm.
Brain: [[../lifecycles/storefront-session-attribution]] · [[../libraries/storefront-experiment-attribution]] · [[../libraries/storefront-experiment-funnel]] · [[pdp-edge-served-experiments]] · [[../tables/storefront_sessions]] · [[../tables/orders]] · [[storefront-test-detail-page]].
