# Session-stamped experiment attribution + order journey ⏳

**Owner:** [[../functions/growth]] · **Parent:** fixes [[../lifecycles/storefront-session-attribution]] — the experiment reporting is wrong because attribution rests on a flaky client `experiment_exposure` event.

**Found in use 2026-06-23** (verified against code + live data): the storefront test page shows ~0 sessions and conversions don't attribute to arms. Root cause — attribution counts a variant's sessions as *distinct `anonymous_id` that fired a client-emitted `experiment_exposure` event*, and a conversion as a matching `anonymous_id` `order_placed` within 14 days ([[../libraries/experiment-attribution]]). But that client exposure event **barely fires**: 157 sessions/24h (139 clean, 110 on advertorial landers) → only **3 exposures**; a real converting session (`aac6f348`, clean, advertorial, $121.61 Amazing Coffee) had **0**. And the `orders` table has **no `session_id`**, so orders can't join the journey directly.

**The fix (owner direction): make the assignment stick to the SESSION, server/edge-side — not a client event.** The edge already resolves the arm (sets `sx_variant=experimentId:variantId[:h]`); persist that on the session and attribute off it.

## Phase 1 — stamp the session with its arm ⏳
- Add **`experiment_assignments` (jsonb)** to `storefront_sessions` — `[{experiment_id, variant_id, arm: control|variant|holdout, assigned_at, surface}]`.
- **Write it server-side**, reliably, the moment the arm is known: (a) the edge/`/api/pixel` reads the `sx_variant` cookie + stamps the session; (b) `resolveExperimentsForRender`'s assignment is persisted to the session on the render's pixel call — **not** dependent on the client `experiment_exposure` emit. Internal/bot sessions are still stamped (so previews/QA are inspectable) but **excluded at the reporting layer**, not silently dropped at write.
- Keep the `experiment_exposure` event as a secondary signal, but the **session stamp is canonical**.

## Phase 2 — first-class order ↔ session link ⏳
- Add **`session_id` (+ `anonymous_id`) to the `orders` table**; `/api/checkout` writes them at order creation (it already resolves the session for the `order_placed` event — persist it on the order too). Backfill recent storefront orders from their `order_placed` event where possible.

## Phase 3 — attribute off the session stamp ⏳
- Rewrite [[../libraries/experiment-attribution]] + [[../libraries/experiment-funnel]]: a variant's **sessions = `storefront_sessions` stamped to that arm** (excluding internal/bot); a **conversion = a storefront `orders` row whose `session_id` is stamped to that arm** (in-session, no 14-day anonymous_id guesswork). Funnel rates off the stamped sessions' events. This is reliable + literal.

## Phase 3.5 — backfill past sessions (the data isn't lost) ⏳
Assignment is a **pure deterministic function** `assignVariant(anonymous_id, experiment, variants)` (sticky hash, no stored state). So for every historical `storefront_session` that hit a running experiment's surface (matching product × lander_type × audience, within the experiment's run window), **recompute its arm from `anonymous_id`** and write the same `experiment_assignments` stamp — recovering the ~107/day untracked sessions + their conversions (e.g. SHOPCX30 = CONTROL on the listicle, verified by computing it live 2026-06-23). One-off backfill script + idempotent. (Holdout/conservative bands must use the *same* params as the live render so the recomputed arm matches what was actually served.)

## Phase 4 — Journey panel on the order detail page ⏳
- On a storefront/`SHOPCX` order in `/dashboard/orders/[id]`: a **Journey panel** joining `orders.session_id` → the session + its `storefront_events` timeline: **source** (lander + `?variant=`, UTM/ad), **experiment + arm** (from the session stamp), and the **funnel steps** (landing → pdp_view → chapters engaged → add_to_cart → checkout → order_placed, with timestamps).

## Verification
- After Phase 1, a real (non-bot) visitor on an experiment lander → their `storefront_sessions.experiment_assignments` carries `{experiment_id, arm}`, regardless of whether the client `experiment_exposure` event fired. ≥~all of the 110 advertorial sessions/day get stamped (not 3).
- After Phase 3, the test detail page shows **real session counts per arm** (matching stamped sessions) + conversions; `aac6f348`-class orders attribute to their arm.
- After Phase 2+4, opening `SHOPCX30` (`981f060a`) shows a Journey panel: listicle lander · Meta ad (ingredient_breakdown) · its arm · the full funnel to order_placed.
- Internal/bot sessions are **excluded from the reported counts** (not from stamping); a `comp`/`sx_internal` preview is inspectable but never inflates a test.
- Negative: a session that hit no experiment has empty `experiment_assignments` and isn't counted in any arm.
Brain: [[../lifecycles/storefront-session-attribution]] · [[../libraries/experiment-attribution]] · [[../libraries/experiment-funnel]] · [[pdp-edge-served-experiments]] · [[../tables/storefront_sessions]] · [[../tables/orders]] · [[storefront-test-detail-page]].
