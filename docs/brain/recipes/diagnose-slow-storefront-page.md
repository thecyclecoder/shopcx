# Diagnose a slow storefront page

How to find out why a Shopify storefront page is slow, and the three landmines already
found in our theme. Written after the 2026-09-25 Amazing Coffee Pods incident, where the
PDP ads were running to took **7.9s to fire `load`** and nobody knew why.

Theme editing itself: [[edit-shopify-theme]] · [[../libraries/shopify-theme]]

## The headline numbers from that incident

Live PDP, before → after (real browser, unthrottled):

| | Before | After |
|---|---|---|
| `load` event | 7,861ms | **1,346ms** |
| `DOMContentLoaded` | 4,933ms | **847ms** |
| Total DOM elements | 10,330 | **2,386** |
| Style recalculation (`UpdateLayoutTree`) | 22,499ms | **384ms** |
| Full-document restyles during load | 93 | **2** |
| TBT (Lighthouse, 4x CPU) | 7,894ms | 1,424ms |

Three separate bugs, none of which showed up as a slow network request.

## Method — in this order

### 1. Rule out the server first

```bash
curl -s -o /dev/null -w "%{time_starttransfer}  %{time_total}  %{size_download}\n" \
  -A "Mozilla/5.0 … Chrome/140" "https://superfoodscompany.com/products/<handle>?cb=$RANDOM"
```

Shopify renders our PDPs in ~180ms TTFB / ~80KB gzipped. If that's what you see, the
problem is entirely client-side and you can stop looking at the network.

### 2. Split network from CPU with the Navigation Timing API

In the real browser (not headless), read `performance.getEntriesByType('navigation')[0]`:

- `domInteractive` → HTML parsing finished
- `domContentLoadedEventEnd` → deferred scripts finished **executing**
- `loadEventEnd` → subresources done

Then check when the last deferred script finished **downloading**. In the incident every
script was down by 1,731ms but DCL was 4,933ms — a **3.2s gap that is pure JS execution**.
That single comparison is what ruled out "it's the network" and "it's third parties".

### 3. Capture a trace WITH the JS profiler

A Lighthouse trace (`--save-assets` → `*.trace.json`) gives you `UpdateLayoutTree`, `Layout`,
`FunctionCall` etc., which is enough to see *what kind* of work dominates:

```js
// aggregate X-events on the renderer main thread (find it by thread_name === 'CrRendererMain',
// NOT by RunTask count — that picks the browser process)
```

But a Lighthouse trace has **no CPU samples**. To get per-function self time you need a
**DevTools Performance recording exported by the founder from his own browser** — it carries
`ProfileChunk` events with `cpuProfile.nodes` + `samples` + `timeDeltas`. That profiler is
what finally named `addItemsToProductForm` in the incident; four headless traces had not.

Ask for it like this: DevTools → Performance → the **reload-and-record** button → stop →
download arrow → `.json`. (A **HAR** is the wrong artifact for this — it only has network
timing, and none of the three bugs below involved a request.)

### 4. A/B by blocking, not by reasoning

`--blocked-url-patterns` on Lighthouse is the cheapest decisive test and touches nothing live:

```bash
npx lighthouse "<url>" --preset=desktop --throttling.cpuSlowdownMultiplier=1 --save-assets \
  --blocked-url-patterns="*cart-drawer-custom.js*"
```

Compare `Style & Layout`, TBT and DOM node count against the baseline. Confirm the page still
rendered (same DOM node count, CLS unchanged) or you're comparing against a broken load.

## Landmine 1 — `:has()` anchored on `body`

`assets/base.css` carried:

```css
body:has(.section-header .drawer-menu) .announcement-bar-section .page-width { … }
```

A `:has()` anchored on `<body>` cannot have its invalidation scoped, so Chrome re-evaluates
it against the **whole document on any DOM mutation anywhere**. Every mutation became a
full-document style recalc.

Measured: one `textContent` write cost **415ms with these rules, 52ms without** — 8x, from
two rules.

The cost is amplified by our variable surface: **140 inherited CSS custom properties**
(104 declared on `:root`) across thousands of elements ≈ ~930k property resolutions per
recalc. That is why a full recalc was ~240ms rather than ~20ms.

**Rule: never anchor `:has()` on `body`, `html` or `:root`.** If the condition is a section
setting it is fixed at render time — decide it in Liquid and emit the right branch, as
`sections/header.liquid` now does. Narrowly-scoped `:has()` (e.g. `.interface:has(> input:checked)`)
is fine.

## Landmine 2 — a timer running because the visibility check was wrong

`assets/cart-drawer-custom.js` → `maybeStartCountdown()` decided visibility from **inline
style only**:

```js
el.style.display === 'none' || el.hidden || el.getAttribute('aria-hidden') === 'true'
```

The cart drawer is closed by a **class**, not an inline style, so the check passed with the
drawer shut. A countdown started on every page load and rewrote `textContent` once a second
for the life of the session — which, via Landmine 1, cost a 240ms full-document restyle
every second, forever.

Its `MutationObserver` also watched the very subtree `render()` writes into, so each tick
re-entered `maybeStartCountdown()` — the observer was feeding itself.

**Rule:** test real visibility (`offsetParent === null` catches `display:none` on the element
or any ancestor), and never let a MutationObserver react to mutations its own callback causes.

## Landmine 3 — infinite mutual recursion hidden by `catch (e) {}`

`snippets/quantity-breaks.liquid`:

```js
function loadItems()      { …; qbApplyCadence(); …; addItemsToProductForm(offers); }
function qbApplyCadence() { …; try { loadItems(); } catch (e) {} }   // ← back into loadItems
```

This recursed until the **JS stack overflowed**. The `RangeError` was swallowed by the bare
`catch`, so nothing ever surfaced.

The damage happened on the unwind: `clearDefaultItem()` runs at the *top* of `loadItems()`, so
it only ran on the way **down**, while every one of ~8,101 frames ran
`addItemsToProductForm()` on the way **back up** and appended another `<input name="id">`.

Result on the live PDP: **8,101 identical hidden inputs — 78% of the page's entire DOM** —
2,020ms of blocked main thread, and every add-to-cart submitting a form with 8,101 duplicate
`id` inputs.

Tells to recognise it next time:
- `V8.StackGuard` / `V8.HandleInterrupts` events sitting inside the slow task
- `dom-size` reporting an absurd **Maximum Child Elements** on one node
- `form.id` returning a `RadioNodeList` (many children named `id`)

**Rule:** a bare `catch (e) {}` around a call that can re-enter its caller will hide a stack
overflow as a mild slowdown. Guard re-entrancy explicitly (`loadItems()` now has a flag), and
split "write a value" from "rebuild everything" so the two can't call each other.

> `form.id` returning an `HTMLInputElement` rather than a string is **normal** Dawn behaviour —
> `HTMLFormElement` lets a control named `id` shadow the property, and Dawn always ships one
> `<input name="id">`. Only the `RadioNodeList` (i.e. *many*) is the smell. Read the real id
> with `form.getAttribute('id')`.

## Gotchas that produced two wrong answers during the incident

Both of these made a real bug look like it wasn't there, and both produced a confident
"there is no problem" that the founder correctly refused to accept.

- **A backgrounded tab throttles timers and rAF.** A long-task observer run while the tab was
  not focused reported zero long tasks on a page that was doing a 240ms restyle every second.
  `performance.getEntriesByType('longtask')` is also not buffered — you need a
  `PerformanceObserver` with `buffered: true`, in a foreground tab.
- **Invalidating styles by setting a custom property on `body` forces a full-document recalc
  on its own**, because custom properties inherit. Using that as the probe made a `:has()`
  removal test show "no difference" when `:has()` was in fact an 8x amplifier. Probe with a
  realistic mutation (a class toggle on one leaf element, or the exact write the page makes).

## Related

[[edit-shopify-theme]] · [[../libraries/shopify-theme]] · [[../lifecycles/storefront-checkout]] ·
[[../libraries/widget-embed-script]]
