# Capture a competitor lander for teardown (mobile Playwright)

The proven capture recipe for Rhea's URL sensor ([[../specs/rhea-url-sensor]] Phase 2) and — via the sibling capture in [[../libraries/landing-page-scout]] — the Landing Page Scout's per-chapter snapshots. Codified from what we learned rendering the erthlabs advertorial + the PageFly PDP by hand: **mobile render + retry-for-bot-block + per-shot geometric overlay-kill + DOM-first `<section>` chaptering with a vision-tile fallback**. Live implementation: [[../../../scripts/research-capture.ts]].

Playwright can't run in serverless / Inngest, so the capture is always a **box script**. The box worker ([[builder-worker]]) drives it deterministically; the Max session ([[../functions/growth]] Rhea) only READS the resulting chapter screenshots.

## Model

1. **Mobile viewport, iPhone UA.** 390×844 @2x with the iPhone 15 Safari UA + `isMobile: true`, `hasTouch: true`. Real DTC landers serve their advertorial variant to mobile — a desktop render often gets the wrong hero + no funnel.
2. **Retry-for-bot-block.** Some competitors 403/timeout the first hit; retry the navigation N times (`NAV_RETRIES=3`), backing off 1.5s × attempt. A persistent failure → `status='unviewable'` (which the Phase-1 SDK vocab records as `classification='unviewable'`, NEVER `teardown_verdict='not_worthy'` — we didn't judge worthiness, we couldn't see the page).
3. **Per-shot geometric overlay-kill.** Before EVERY screenshot (both DOM sections and scroll tiles), sweep the DOM for any `position: fixed | absolute` element whose bounding box covers ≥60% of the viewport in both dimensions and `.remove()` it. Also inject `animation: none !important; transition: none !important;` so a scroll-triggered fade doesn't smear a shot. **The overlay must be killed BEFORE every shot, not once at load** — a scroll-triggered popup re-fires on every scroll, so a one-shot dismiss doesn't survive (see the worked example below).
4. **DOM-first `<section>` chaptering.** If the page exposes a sane `<section>` / `[data-section]` map — count between `DOM_SECTIONS_MIN=3` and `DOM_SECTIONS_MAX=40`, each with rendered height ≥40px, and at least one carrying an `<h1|h2|h3>` heading — take one `element.screenshot()` per section. Label prefers `data-section`, else the section's first heading text, else `section-${i}`.
5. **Vision-tile fallback.** If DOM-first fails the sanity gate (bare PDP with no anchors, or a page that tags every `<li>` as a section), scroll-tile the page: `window.scrollTo(0, i * PHONE.height * 0.9)` (90% step preserves a small overlap so a chapter boundary doesn't lose content), one `page.screenshot()` per tile, capped at `CAPTURED_CHAPTERS_MAX=30`.
6. **Lazy handling.** After navigation, `waitForTimeout(1200)` before the first sanity read + `waitForTimeout(350)` between shots — enough for a lazy `IntersectionObserver` section to hydrate without waiting for the full LCP animation.
7. **Upload to the private bucket.** Each shot goes to the `research-shots` bucket (private; short-lived signed URLs). Path shape: `<stamp>/<research_url_id>/<safe(url)>-chapter-<i>.png`.

## Worked example — the erthlabs "scratch-to-win" interstitial

The `learn.urthlabs.com/reasons` advertorial DOM-first-chapters cleanly into **17 sections** (`data-section` maps to headings like `reasons-1` … `reasons-8`, `founder-story`, `offer`). But rendering it naïvely gave 12/17 chapters covered by a scratch-to-win popup. The fix:

- **Sync overlay dismiss doesn't survive.** The interstitial's own dismiss button *did* fire the modal's close handler, but the same JS re-mounted the popup on the next scroll event — so shots past chapter 2 kept coming back covered. We needed a **geometric** kill that doesn't ask the site for permission.
- **`.remove()` per-shot works.** Sweeping fixed/absolute nodes whose bounding box covers most of the viewport and calling `el.remove()` per shot survives re-mounts. The removed nodes aren't in the DOM by the time `element.screenshot()` fires, and the next scroll re-mounts them — which we then remove again on the next iteration.
- **CSS kill covers animation smear.** Injecting `* { animation: none !important; transition: none !important; }` stopped a companion `fadeIn` animation that was mid-frame during the shot on chapter 8.

Result: 17 clean chapters, none covered.

## Worked example — the PageFly PDP (vision-tile path)

`erthlabs.co/products/superfoodcoffee-starterkit` (a PageFly-built PDP) exposes exactly zero `<section>` tags — its Vue-rendered blocks are `<div class="pf-...">`. DOM-first correctly bails; the vision-tile fallback captures 8 tiles at 90% viewport step. Rhea's classifier reads them and returns `classification='generic_pdp'` + `teardown_verdict='not_worthy'` (bare PDP, no lander funnel to teardown).

## Gotchas

- **NEVER trust a page's built-in dismiss.** Geometric `.remove()` is the only overlay kill that survives scroll re-mounts.
- **DOM-first isn't "count sections."** A PDP that tags every `<li>` as a `[data-section]` has 60+ "sections" with no headings — the count-only gate would pass and every shot would be a bullet. The headings-required check is the real signal.
- **Idempotent, not append-only.** Re-running the capture for the same `research_url_id` overwrites shots (`upsert: true` on the upload); Rhea's classification also upserts. A workspace-wide rerun of the sensor never doubles the storage bill.
- **One Chromium at a time.** `captureBatch` is sequential — a parallel launch on the box has blown memory in the past. The Max session budget is more forgiving than box RAM.
- **A crash on one URL never wedges the rest.** Every capture is wrapped so a Playwright error becomes `status='unviewable'` for that one URL and the batch continues.
- **`unviewable ≠ not_worthy`.** The worker sets `classification='unviewable'` deterministically on capture failure; `teardown_verdict` stays `unreviewed`. Rhea NEVER emits `unviewable` in her decisions[] — she only sees pages that captured.

## Reused by

- Rhea's URL sensor ([[../libraries/research-urls]] + [[../specs/rhea-url-sensor]]).
- The Landing Page Scout's per-chapter snapshots ([[../libraries/landing-page-scout]] + `scripts/landing-page-snapshot.ts`) — the same mobile viewport + `[data-section]` chaptering; the funnel-follow layer is scout-specific.

## Related

[[../specs/rhea-url-sensor]] · [[../tables/research_urls]] · [[../libraries/research-urls]] · [[../libraries/landing-page-scout]] · [[../inngest/acquisition-research-cadence]] · [[builder-worker]] · [[../functions/growth]]
