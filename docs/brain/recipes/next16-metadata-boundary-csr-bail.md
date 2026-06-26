# Recipe: stop the Next 16 metadata-boundary resume mismatch (CSR bail on /store, /widget, /portal, /help)

> "Same error digest, dozens of times an hour, across four dynamic routes: `Expected the resume to render <div> in this slot but instead it rendered <__next_metadata_boundary__>. The tree doesn't match so React will fallback to client rendering.` Auto-repair keeps marking it fixed and it keeps coming back."

This is a **production SEO + LCP regression**: the affected routes bail to client-side rendering, so crawlers and first paint lose the server HTML. If you see this error recurring on `/store/[workspace]/[slug]`, `/widget/[workspaceId]`, `/portal/[slug]`, or `/help/[slug]/[articleSlug]`, do **not** reach for another `htmlLimitedBots` / `next.config` tweak — the config lever cannot reach this code path. The fix lives in [[../../src/proxy.ts]] (bot-UA neutralization). Read this first.

## Root cause (verified against the Next 16.2.9 source)

`cacheComponents: true` is required for the PDP's per-arm `'use cache'` cache (`?_sxv=<variantId>`, see [[../lifecycles/storefront-checkout.md]]). But `cacheComponents` **implicitly turns on PPR for the whole app**:

- `next/dist/esm/server/config.js`: `if (result.cacheComponents) { result.experimental.ppr = true; }`
- So `couldSupportPPR = true` and every prerenderable app route is `◐ Partial Prerender`.

Every PPR route bakes a **streaming-metadata** static shell at build time. The metadata wrapper has two shapes (`next/dist/esm/lib/metadata/metadata.js`, `MetadataWrapper`):

- `serveStreamingMetadata === true` → `<div hidden><MetadataBoundary><Suspense>…</Suspense></MetadataBoundary></div>`
- `serveStreamingMetadata === false` → `<MetadataBoundary>…</MetadataBoundary>` (a bare `<__next_metadata_boundary__>`, **no** `<div hidden>`)

At **build/export** there is no UA, and the app-page handler hardcodes the streaming branch:

```js
// next/dist/.../build/templates/app-page.js  (the SSR/resume request handler)
const userAgent = req.headers['user-agent'] || '';
const botType = getBotType(userAgent); // 'html' for Slackbot/Bingbot/facebookexternalhit/Applebot/Twitterbot/… ; 'dom' for Googlebot
const serveStreamingMetadata =
  botType && isRoutePPREnabled ? false           // ← the bug (fires for BOTH 'html' AND 'dom')
  : !userAgent ? true                            // ← build/export: bakes <div hidden>
  : shouldServeStreamingMetadata(userAgent, nextConfig.htmlLimitedBots);
```

The leading `botType && isRoutePPREnabled ? false` short-circuit forces the **blocking** branch for **any** bot Next recognizes on a PPR route — and it **ignores `htmlLimitedBots` entirely** (our `next.config` `/(?!)/` never gets a vote; it only governs the third branch). `getBotType` tests the UA against two hardcoded patterns in `next/dist/.../is-bot.js`:

- `HEADLESS_BROWSER_BOT_UA_RE = /Googlebot(?!-)|Googlebot$/i` → `'dom'` (the JS-executing Googlebot — explicitly NOT `Mediapartners-Google` / `AdsBot-Google`)
- `HTML_LIMITED_BOT_UA_RE` (from `html-bots.js`) → `'html'`

Neither pattern is config-tunable, and there is no `htmlLimitedBots`-style escape hatch for the dom-bot branch at all.

So when a bot crawl triggers an ISR revalidation, the cached shell is re-rendered into the **blocking** shape, while the build-time shell (and any normal-user resume) is the **streaming** `<div hidden>` shape. A subsequent resume render finds the wrong element in the slot → React throws `Expected the resume to render <div> … rendered <__next_metadata_boundary__>` → bails to CSR. It recurs "every few minutes" because that's how often bots crawl these four public routes.

### Why the previous mitigations didn't work

- `htmlLimitedBots: /(?!)/` and `htmlLimitedBots: /.*/` both only affect `shouldServeStreamingMetadata`, which the `botType && isRoutePPREnabled` branch **never calls** for bots. Dead lever.
- `export const dynamic = "force-dynamic"` / `"force-static"` and `experimental_ppr` are **rejected under `cacheComponents`** ("Route segment config `dynamic` is not compatible with `nextConfig.cacheComponents`"), so there is no per-route PPR opt-out.
- Dropping `cacheComponents` for `experimental.useCache` would disable the `'use cache'` directive the PDP depends on.

## The fix

We cannot edit Next's bot regex or that short-circuit. We **make `getBotType()` return `undefined`** by neutralizing every UA Next recognizes at the edge ([[../../src/proxy.ts]]) — both the HTML-limited list AND the headless-browser Googlebot pattern — so the handler takes the **same streaming branch as the build-time shell**. The bot still receives the fully-baked static HTML (full content + real metadata) — only the metadata-wrapper shape is held constant, so prerender and resume agree and there's no CSR bail.

- `proxy()` runs `isBotForPPR(ua)` (combines `HTML_LIMITED_BOT_UA_RE` mirrored from Next's `html-bots.js` AND `HEADLESS_BROWSER_BOT_UA_RE` = `/Googlebot(?!-)|Googlebot$/i` mirrored from Next's `is-bot.js`). On a hit it builds an override `Headers` with `user-agent` replaced by a neutral SEO UA, and stashes the real UA in `x-original-user-agent`.
- The override headers are threaded through `updateSession(request, overrideRequestHeaders)` ([[../../src/lib/supabase/middleware.ts]]); every `NextResponse.next(reqInit)` and `NextResponse.rewrite(url, reqInit)` forwards `{ request: { headers } }` so the neutralized UA reaches the render on the direct path **and** every custom-domain / subdomain rewrite path the four routes use.

`{ request: { headers } }` is the only mechanism in Next 16 that forwards modified request headers to the render — `new NextRequest(req, { headers })` does not, and you can't mutate the incoming request's headers (read-only).

## Validation (how to re-confirm)

Build any affected route and compare a bot UA against a normal UA — the response shells must be byte-identical:

```bash
curl -s -A "Mozilla/5.0 Chrome/120"                                            http://localhost:PORT/store/{ws}/{slug} | grep -c '<div hidden'
curl -s -A "Slackbot 1.0"                                                      http://localhost:PORT/store/{ws}/{slug} | grep -c '<div hidden'
curl -s -A "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" http://localhost:PORT/widget/{workspaceId}   | grep -c '<div hidden'
```

All three must print the same count (the streaming-shell `<div hidden>` present). Pre-fix, the Slackbot AND Googlebot responses are smaller and have **no** `<div hidden>` (the bare boundary) — that's the mismatch. Post-fix, Slackbot / Bingbot / facebookexternalhit / Applebot / Twitterbot AND Googlebot all match Chrome exactly, on both the direct `/store` (and `/widget`) path and the custom-domain/subdomain rewrite paths.

## Gotchas

- If you add a new public, bot-crawled, PPR route, it's covered automatically (the proxy matcher is a catch-all and the UA neutralization runs before the route branches). No per-route work.
- Keep both bot patterns in [[../../src/proxy.ts]] in sync with Next's source on a Next upgrade: `HTML_LIMITED_BOT_UA_RE` mirrors `next/dist/.../html-bots.js`, and `HEADLESS_BROWSER_BOT_UA_RE` mirrors `next/dist/.../is-bot.js`. If Next adds a bot (or another `botType` like `'dom'` gained) and we don't, that new bot will resume-mismatch again.
- This is a known upstream Next bug (the handler carries a `TODO: investigate existing bug with shouldServeStreamingMetadata`). Re-check on each Next upgrade; if upstream fixes the short-circuit to honor `htmlLimitedBots` (and adds an equivalent knob for the dom-bot branch), this proxy shim can be retired.
