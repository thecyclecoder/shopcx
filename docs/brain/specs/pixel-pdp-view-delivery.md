# Storefront pixel drops ~17% of pdp_view (first-flush delivery loss)

**Owner:** [[../functions/growth]] · **Parent:** [[growth]] mandate — Max's storefront performance data must be 100% accurate.
**Status:** 🚧 in progress — root-caused + first fix shipped 2026-06-30; awaiting recovery verification.

## Symptom (found 2026-06-30 auditing the funnel-tree SDK)
~**17% of real storefront sessions never fire a `pdp_view` event** even though the session exists and fires later events (chapter_view/dwell, scroll_depth, pdp_engaged, cta_click, even order_placed). Measured 7d, real traffic: **bare PDP 16.5% missing · landers 18.0% missing**. Not bots (bots already excluded). The funnel's top step is `pdp_view`, so visits were undercounted and engagement/CVR overstated.

Reconciliation that surfaced it (reasons lander, 7d): 557 real sessions active, only 455 fired pdp_view → **102 engaged humans missing from top-of-funnel**; of those 102: 96 chapter_dwell, 87 pdp_engaged, 37 cta_click, 6 leads, **2 orders**.

## Root cause
`src/lib/storefront-pixel.ts` — the debounced `flush()` (fires ≈500ms after mount, carrying the first `pdp_view`) used **keepalive `fetch`**, only falling back to `navigator.sendBeacon` on `pagehide`. Keepalive fetch issued during the heavy initial page load is unreliable (notably iOS Safari — a large share of paid-social traffic). The first flush is dropped; a LATER flush (engagement events) then creates the session + lands those events — so the session exists but reads as pdp_view-less. System-wide (PDP + landers alike), ~17%.

## Fixes
**Phase 1 — pixel (shipped 2026-06-30).** `flush()` now uses a shared **beacon-first** `post()` helper (sendBeacon → keepalive-fetch fallback), same reliable path the pagehide handler already used. The `/api/pixel` endpoint is upsert-with-ignore-duplicates, so a beacon racing a later flush is harmless. Expectation: the ~17% pdp_view miss-rate falls sharply for sessions served after deploy.

**Phase 2 — SDK robustness (shipped 2026-06-30).** [[../libraries/funnel-tree]] redefines top-of-funnel `visit` = a session that fired ANY event in the window (the session's presence IS the visit signal), so the metric is correct regardless of pdp_view delivery. This is the durable fix; the pixel fix additionally restores Meta `ViewContent`/CAPI volume (pdp_view → ViewContent).

## Verification (run after the pixel deploy has a few days of post-deploy traffic)
- Re-run `scripts/_probe-pixel-drop-characterize.ts` over a window of **sessions whose first_seen is after the deploy**; the `MISSING pdp_view` % should drop materially from ~17% (target < 5%). If it doesn't, the failure mode isn't first-flush delivery — instrument the client (RUM) to confirm.
- Meta Events Manager: `ViewContent` volume should rise ~+15-20% with no change in real traffic.
- The funnel-tree `visit` count is already correct via Phase 2 regardless of Phase 1's outcome.

## Related
- The SDK that exposed this: [[../libraries/funnel-tree]]. Same "make the metric robust, don't trust one beacon" theme as [[chapter-performance-variant-dimension]].
