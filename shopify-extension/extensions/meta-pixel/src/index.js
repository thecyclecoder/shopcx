import {register} from "@shopify/web-pixels-extension";

/**
 * ShopCX Meta pixel — Shopify web pixel (strict sandbox).
 *
 * COLLECTOR, NOT SENDER. The sandbox forwards each event to ShopCX; the server
 * signs it into Meta's Conversions API with the access token, real client IP and
 * User-Agent. Rationale:
 *   - the CAPI access token never reaches client code
 *   - one send path (`meta-capi.ts` sendCapiEvents), already verified end-to-end,
 *     instead of hand-rolling Meta's /tr query-param format in a sandbox we
 *     cannot inspect the response of (it returns a 1x1 gif)
 *   - server-side we attach hashed PII off the order, which the browser can't
 *
 * Strict runtime_context gives no DOM: no script injection, so no fbevents.js.
 * `browser.cookie` reads/writes the TOP FRAME (per @shopify/web-pixels-extension
 * types), so _fbp / _fbc are real first-party cookies on the merchant domain —
 * which is what makes them usable as Meta match keys at all.
 *
 * Purchase is sent from BOTH here and the orders/create webhook, deduped on
 * `shopify_purchase_{order.id}` — `checkout.order.id` is populated only on
 * checkout_completed, which is exactly where we need it.
 */

const ENDPOINT = "https://shopcx.ai/api/pixel/shopify";
const FBP_COOKIE = "_fbp";
const FBC_COOKIE = "_fbc";
const COOKIE_MAX_AGE = 90 * 24 * 60 * 60; // Meta's 90-day attribution window

/** Meta's _fbp format: fb.<subdomainIndex>.<creationMs>.<random>. */
function mintFbp() {
  const rand = Math.floor(Math.random() * 1e10);
  return `fb.1.${Date.now()}.${rand}`;
}

/** Meta's _fbc format: fb.<subdomainIndex>.<creationMs>.<fbclid>. */
function fbcFromClickId(fbclid) {
  return `fb.1.${Date.now()}.${fbclid}`;
}

function readFbclid(href) {
  try {
    return new URL(href).searchParams.get("fbclid");
  } catch {
    return null;
  }
}

/**
 * SCOPE: CHECKOUT EVENTS ONLY.
 *
 * PageView / ViewContent / AddToCart / Lead are owned by the THEME script
 * (snippets/meta-pixel.liquid), which can do what this sandbox cannot: call
 * fbq() directly for a real BROWSER event, and read first-party cookies from a
 * normal DOM. Subscribing to them HERE too would send Meta two copies of every
 * storefront event under DIFFERENT event ids — double-counting, not deduping.
 * (That regression shipped briefly on 2026-09-02 and was caught in Test Events.)
 *
 * What only this surface can see is checkout: Shopify's checkout is a separate
 * surface theme code cannot reach.
 */
register(({analytics, browser, init, settings}) => {
  const pixelId = settings.pixelId;
  if (!pixelId) return;

  /**
   * Resolve the two Meta cookies once per event. `_fbp` is minted if absent so
   * every visitor carries a stable browser id; `_fbc` is (re)written whenever a
   * fresh fbclid is on the URL, because a newer click should win attribution.
   * Failures are swallowed — a cookie problem must never break the storefront.
   */
  async function resolveMetaCookies(href) {
    let fbp = null;
    let fbc = null;
    try {
      fbp = await browser.cookie.get(FBP_COOKIE);
      if (!fbp) {
        fbp = mintFbp();
        await browser.cookie.set(`${FBP_COOKIE}=${fbp}; max-age=${COOKIE_MAX_AGE}; path=/`);
      }
      const fbclid = readFbclid(href);
      if (fbclid) {
        fbc = fbcFromClickId(fbclid);
        await browser.cookie.set(`${FBC_COOKIE}=${fbc}; max-age=${COOKIE_MAX_AGE}; path=/`);
      } else {
        fbc = await browser.cookie.get(FBC_COOKIE);
      }
    } catch {
      /* cookie access denied (privacy mode) — send what we have */
    }
    return {fbp: fbp || null, fbc: fbc || null};
  }

  /**
   * `keepalive` matters on checkout_completed: the browser is navigating away and
   * a normal fetch would be cancelled mid-flight. Fire-and-forget — a tracking
   * failure must never surface to the shopper.
   */
  // Cookies are resolved ONCE at init, not per event. The previous version awaited
  // browser.cookie.get() inside send(), which put an async hop between the event
  // firing and the fetch leaving. On events that coincide with a navigation
  // (checkout_started, payment_info_submitted) the sandbox can be torn down during
  // that hop, so the request was never issued at all — `keepalive` cannot rescue a
  // fetch that never started. checkout_completed survived only because the
  // thank-you page sits still. Symptom: Purchase deduped fine while
  // InitiateCheckout and AddPaymentInfo produced no events whatsoever (2026-09-02).
  var cookies = { fbp: null, fbc: null };
  resolveMetaCookies(init && init.context && init.context.document
    && init.context.document.location && init.context.document.location.href)
    .then(function (c) { cookies = c; })
    .catch(function () {});

  function send(eventName, eventId, event, customData) {
    var href = (event && event.context && event.context.document
      && event.context.document.location && event.context.document.location.href) || "";
    // Synchronous through to fetch() — nothing may await between here and the send.
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        keepalive: true,
        body: JSON.stringify({
          pixelId: pixelId,
          eventName: eventName,
          eventId: eventId,
          eventTimeMs: event && event.timestamp ? Date.parse(event.timestamp) : Date.now(),
          sourceUrl: href,
          referrer: (event && event.context && event.context.document && event.context.document.referrer) || null,
          fbp: cookies.fbp,
          fbc: cookies.fbc,
          customerId: (init && init.data && init.data.customer && init.data.customer.id) || null,
          email: (init && init.data && init.data.customer && init.data.customer.email) || null,
          customData: customData || {},
        }),
      }).catch(function () {});
    } catch (e) { /* never break checkout on a tracking failure */ }
  }

  const money = (p) => (p?.amount != null ? Number(p.amount) : undefined);

  // Meta needs `currency` alongside `value` or it can't book a conversion value.
  // Shopify's Checkout.currencyCode is `string | null` and Shop carries no currency
  // at all, so reading it risks sending a value with no currency. Superfoods sells
  // US-only (founder, 2026-09-02), so this is a constant. Revisit if we ever sell
  // outside the US — the server half reads the order's real `currency` already.
  const CURRENCY = "USD";




  // checkout_started is NOT subscribed here. Shopify never emitted it on either
  // of our checkout entries, and the theme script now fires InitiateCheckout off
  // the cart drawer's Checkout button instead — a truer intent signal, and it gets
  // both the fbq and relay paths. Re-subscribing here would double-count.

  analytics.subscribe("payment_info_submitted", (event) => {
    const c = event.data?.checkout;
    send("AddPaymentInfo", `api_${event.id}`, event, {
      value: money(c?.totalPrice),
      currency: CURRENCY,
    });
  });

  /**
   * The dedup event. `checkout.order.id` is non-null ONLY here, and the
   * orders/create webhook derives the identical key from the same order id —
   * so Meta collapses the browser and server copies into one conversion with
   * no coordination between them. Falls back to the checkout token if the order
   * id is somehow absent; that copy simply won't dedup rather than double-count
   * under a random id.
   */
  analytics.subscribe("checkout_completed", (event) => {
    const c = event.data?.checkout;
    const orderId = c?.order?.id;
    const eventId = orderId ? `shopify_purchase_${orderId}` : `checkout_${c?.token || event.id}`;
    send("Purchase", eventId, event, {
      value: money(c?.totalPrice),
      currency: CURRENCY,
      num_items: c?.lineItems?.length,
      content_type: "product",
      content_ids: (c?.lineItems || []).map((li) => li?.variant?.sku).filter(Boolean),
      order_id: orderId || null,
    });
  });
});
