# libraries/widget-embed-script

The one-file embed that merchants paste into their storefront to get the ShopCX
live-chat bubble. Vanilla ES5 IIFE, no build step, served statically.

**File:** `public/widget.js` → `https://shopcx.ai/widget.js`

Embedded on the Superfoods storefront from `layout/theme.liquid` (see
[[../recipes/edit-shopify-theme]]), tagged `async`, with `data-workspace` plus
optional `data-customer-*` attributes read from `document.currentScript`.

## What it does

1. Reads `data-*` off its own `<script>` tag (synchronously — `currentScript` is
   null once you defer into a callback).
2. Sniffs product context from JSON-LD, falling back to `/products/{handle}` in
   the URL, and folds it into the iframe query string.
3. Builds a fixed-position container: a `<button id="shopcx-chat-bubble">` and an
   `<iframe id="shopcx-chat-iframe">` pointed at `/widget/{workspaceId}`.
4. Fetches `/api/widget/{workspaceId}/config` for bubble colour + corner.
5. Exposes `window.ShopCX` — `.open()`, `.close()`, `.toggle()`, `.isOpen()`.

## Gotchas

### The iframe is deliberately src-less until first open — do not "fix" it

`iframe.src` is assigned only by `attachIframe()`, called from `setOpen(true)`
and from the bubble's `pointerenter` / `touchstart` / `focus` warm signals.

**`display:none` does not stop an iframe loading.** An iframe with a `src` still
downloads and boots its entire document regardless of visibility, and
`/widget/{workspaceId}` is a ~1,400-line client component. Assigning `src` at
construction therefore charged every host pageview ~250KB and ~1.2s of blocked
main thread for a panel most visitors never open — measured on the Amazing
Coffee Pods PDP, where it was the second-worst long task on the page after
Shopify's own checkout hydration.

No data is lost by deferring: a `widget_sessions` row is only written when a
message is actually posted (`src/app/api/widget/[workspaceId]/messages/route.ts`),
never on iframe boot. A `preconnect` to the ShopCX origin goes out at load so the
first open pays no DNS/TLS cost.

### The bubble's accessible name lives in JS, not markup

The button's only child is a decorative SVG, so `aria-label` is set explicitly
(and flipped between "Open chat" / "Close chat" in `setOpen`, alongside
`aria-expanded`). Without it the button is unlabelled to assistive tech and the
host page fails Lighthouse/axe `button-name` — on every page that embeds us, not
just ours.

### `DEFAULT_BUBBLE_COLOR` must match the server default

The bubble paints before the config fetch resolves. If this constant drifts from
the default in `/api/widget/[workspaceId]/config`, every store without an
override flashes one colour and repaints to another.

## Related

[[widget-cors]] · [[widget-articles-route]] · [[../lifecycles/ticket-lifecycle]] ·
[[../recipes/edit-shopify-theme]]
