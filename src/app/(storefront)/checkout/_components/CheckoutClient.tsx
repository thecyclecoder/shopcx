"use client";

/**
 * Checkout client — two-column desktop, single-column mobile.
 *
 * Desktop:
 *   ┌──────────────────────────────┬──────────┐
 *   │ Contact + Shipping + Payment │ Cart     │ (right sidebar, sticky)
 *   │                              │ Reviews  │
 *   └──────────────────────────────┴──────────┘
 *
 * Mobile:
 *   ┌──────────────────────────────┐
 *   │ Cart (collapsible)           │
 *   │ Contact card                 │
 *   │ Shipping card                │
 *   │ Payment card                 │
 *   │ Reviews                      │
 *   │ Sticky Pay $X CTA            │
 *   └──────────────────────────────┘
 *
 * Identity bootstrap: when email + (optionally) phone are valid we
 * POST to /api/checkout/identify so the customer row is created BEFORE
 * payment. Debounced 700ms after field blur so we don't fire on every
 * keystroke. Pre-identifying gives us abandoned-cart attribution + a
 * stable customer id to thread events through.
 *
 * Marketing consent: two checkboxes pre-checked. Transactional emails
 * (order confirmations, shipping updates) are implied by the purchase
 * under CAN-SPAM / TCPA — no separate checkbox.
 *
 * Auto-population: the name fields in the contact card flow into
 * shipping (and billing) when shipping is still empty.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { initPixel, track } from "@/lib/storefront-pixel";
import { HeroFeaturedReviews } from "../../_components/HeroFeaturedReviews";
import type { Review } from "../../_lib/page-data";
import type { CartDraft, StoredLineItem } from "../../customize/_components/CustomizeClient";
import { HostedFieldsCard, type HostedFieldsCardHandle } from "./HostedFieldsCard";

interface Workspace {
  id: string;
  name: string;
  logo_url: string | null;
  primary_color: string;
  storefront_domain: string | null;
  storefront_slug: string | null;
  shipping_protection: {
    price_cents: number;
    title: string;
    description: string;
  } | null;
}

export function CheckoutClient({
  cart,
  workspace,
  sourceProductHandle,
  featuredReviews,
  primaryProductHandle,
  initialFirstName,
  initialLastName,
}: {
  cart: CartDraft;
  workspace: Workspace;
  sourceProductHandle: string | null;
  featuredReviews: Review[];
  primaryProductHandle: string | null;
  initialFirstName?: string;
  initialLastName?: string;
}) {
  // ── Pricing ──────────────────────────────────────────────────────
  const subscribing = cart.line_items.some((l) => l.mode === "subscribe");
  // Shipping rates — fetched from /api/checkout/shipping-rates which
  // reads shipping_rates table. We hold the chosen code in state and
  // re-derive totals on every render so the customer's selection
  // flows through to the displayed total + the submit payload.
  const [shippingRates, setShippingRates] = useState<Array<{
    id: string;
    code: string;
    name: string;
    description: string | null;
    transit_days_min: number | null;
    transit_days_max: number | null;
    total_cents: number;
    is_default: boolean;
  }>>([]);
  // onetime_economy total — what the customer would have paid as a
  // one-time shopper, regardless of current cart mode. Used to
  // strike-through the shipping price on subscribing carts. Comes
  // straight from the DB.
  const [onetimeEconomyCents, setOnetimeEconomyCents] = useState<number>(0);
  const [shippingCode, setShippingCode] = useState<string>("economy");
  const chosenRate = useMemo(
    () => shippingRates.find((r) => r.code === shippingCode) || shippingRates.find((r) => r.is_default) || shippingRates[0] || null,
    [shippingRates, shippingCode],
  );
  // What we display as "would have paid":
  //   • subscribing → onetime_economy from the DB
  //   • onetime → the economy rate they're already paying (no strike)
  const shippingValueCents = subscribing
    ? onetimeEconomyCents
    : (shippingRates.find((r) => r.code === "economy")?.total_cents ?? 0);
  const shippingCents = chosenRate ? chosenRate.total_cents : 0;
  const shippingSavedCents = Math.max(0, shippingValueCents - shippingCents);
  const taxCents = 0;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/checkout/shipping-rates?cart_token=${encodeURIComponent(cart.token)}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          rates: typeof shippingRates;
          onetime_economy_cents: number | null;
        };
        if (cancelled) return;
        setShippingRates(data.rates || []);
        setOnetimeEconomyCents(data.onetime_economy_cents || 0);
        const def = (data.rates || []).find((r) => r.is_default);
        if (def) setShippingCode(def.code);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
    // Reload when the cart shape changes (subscribe vs onetime) since
    // applicable rates differ.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.token, subscribing]);
  // MSRP subtotal includes gift "value" (gift has unit_msrp_cents=value,
  // unit_price_cents=0) so the gift naturally lands in "you save".
  const msrpSubtotalCents = useMemo(
    () => cart.line_items.reduce((s, l) => s + (l.unit_msrp_cents || l.unit_price_cents) * l.quantity, 0),
    [cart.line_items],
  );
  const youSaveCents = Math.max(0, msrpSubtotalCents - cart.subtotal_cents) + shippingSavedCents;

  // ── Form state ────────────────────────────────────────────────────
  const [email, setEmail] = useState(cart.email || "");
  const [phone, setPhone] = useState(cart.phone || "");
  const [firstName, setFirstName] = useState(initialFirstName || "");
  const [lastName, setLastName] = useState(initialLastName || "");
  const [emailMarketingConsent, setEmailMarketingConsent] = useState(true);
  const [smsMarketingConsent, setSmsMarketingConsent] = useState(true);

  // Shipping fields (pre-populated from contact card when ship name is empty)
  const [shipFirst, setShipFirst] = useState("");
  const [shipLast, setShipLast] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [billingSameAsShipping, setBillingSameAsShipping] = useState(true);
  // Shipping protection — default on when workspace has it enabled.
  // Customer can uncheck to opt out. Adds price_cents to the total.
  const protectionPriceCents = workspace.shipping_protection?.price_cents ?? 0;
  const [shippingProtection, setShippingProtection] = useState(!!workspace.shipping_protection);
  const protectionCents = shippingProtection && workspace.shipping_protection ? protectionPriceCents : 0;
  const totalCents = cart.subtotal_cents + shippingCents + taxCents + protectionCents;
  // Separate billing fields used only when billingSameAsShipping is off.
  const [billFirst, setBillFirst] = useState("");
  const [billLast, setBillLast] = useState("");
  const [billAddress1, setBillAddress1] = useState("");
  const [billAddress2, setBillAddress2] = useState("");
  const [billCity, setBillCity] = useState("");
  const [billState, setBillState] = useState("");
  const [billZip, setBillZip] = useState("");

  // Mobile cart collapsed by default — same pattern Shopify uses.
  const [cartOpen, setCartOpen] = useState(false);

  // Terms agreement — pre-checked. Customer must opt out explicitly.
  // Blocks submit when off.
  const [agreeToTerms, setAgreeToTerms] = useState(true);

  // Recurring total = sum of subscription lines (the customer is going
  // to see this billed every cycle). Shown when subscribing.
  const recurringCents = useMemo(
    () => cart.line_items.reduce((s, l) => (l.mode === "subscribe" ? s + l.line_total_cents : s), 0),
    [cart.line_items],
  );

  // ── Braintree Hosted Fields ─────────────────────────────────────
  // We fetch a client_token here, then pass it to the HostedFieldsCard
  // which owns the visual mockup + iframe lifecycle.
  const hostedFieldsRef = useRef<HostedFieldsCardHandle | null>(null);
  const [clientToken, setClientToken] = useState<string | null>(null);
  const [cardReady, setCardReady] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  useEffect(() => {
    initPixel({ workspaceId: workspace.id, customerId: cart.customer_id });
    track("checkout_view", {
      cart_token: cart.token,
      line_item_count: cart.line_items.length,
      total_cents: totalCents,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/checkout/client-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cart_token: cart.token }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "client_token_failed" }));
          throw new Error(err.error || "client_token_failed");
        }
        const { client_token } = (await res.json()) as { client_token: string };
        if (cancelled) return;
        setClientToken(client_token);
      } catch (err) {
        setCardError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [cart.token]);

  // ── Identify (debounced) ─────────────────────────────────────────
  // Fires when email is valid, debounced 700ms so we don't slam the
  // server on every keystroke. Phone optional. Marketing consent
  // flags ride along; the customer row gets created or refreshed.
  const identifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (identifyTimer.current) clearTimeout(identifyTimer.current);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    identifyTimer.current = setTimeout(async () => {
      try {
        await fetch("/api/checkout/identify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cart_token: cart.token,
            email,
            phone: phone || undefined,
            first_name: firstName || undefined,
            last_name: lastName || undefined,
            email_marketing_consent: emailMarketingConsent,
            sms_marketing_consent: smsMarketingConsent,
          }),
        });
      } catch { /* non-fatal */ }
    }, 700);
    return () => { if (identifyTimer.current) clearTimeout(identifyTimer.current); };
    // We deliberately don't include marketing consent in deps to avoid
    // re-firing on every checkbox toggle — those persist when the next
    // legitimate change (email/phone/name edit) flows through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, phone, firstName, lastName, cart.token]);

  // ── Auto-populate name from contact → shipping when ship is empty ──
  useEffect(() => {
    if (firstName && !shipFirst) setShipFirst(firstName);
    if (lastName && !shipLast) setShipLast(lastName);
    // We only auto-fill, never overwrite. Customer can override the
    // shipping name (e.g. shipping a gift).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstName, lastName]);

  // ── Submit ───────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function isFormValid(): { ok: true } | { ok: false; reason: string } {
    if (!firstName || !lastName) return { ok: false, reason: "Please enter your first and last name." };
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: "Please enter a valid email." };
    if (!isPhoneComplete(phone)) return { ok: false, reason: "Please enter a 10-digit phone number." };
    if (!shipFirst || !shipLast || !address1 || !city || !state || !zip) {
      return { ok: false, reason: "Please complete your shipping address." };
    }
    if (!billingSameAsShipping) {
      if (!billFirst || !billLast || !billAddress1 || !billCity || !billState || !billZip) {
        return { ok: false, reason: "Please complete your billing address." };
      }
    }
    if (!agreeToTerms) return { ok: false, reason: "Please agree to the store policies and terms." };
    return { ok: true };
  }

  /**
   * Switch the entire cart from one-time to subscribe at the default
   * frequency. POSTs to /api/cart which re-prices every line with the
   * subscribe discount + injects any qualifying free gifts.
   */
  async function switchToSubscribe() {
    try {
      const lines = cart.line_items
        .filter((l) => !l.is_gift)
        .map((l) => ({ variant_id: l.variant_id, quantity: l.quantity }));
      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          workspace_id: workspace.id,
          line_items: lines,
          mode: "subscribe",
          frequency_days: cart.subscription_frequency_days || 30,
          email,
          phone: phoneToE164(phone) || undefined,
        }),
      });
      if (res.ok) {
        // Hard-reload so the server picks up the new pricing + gift
        // injection and the page rehydrates cleanly.
        window.location.href = `/checkout?token=${encodeURIComponent(cart.token)}`;
      }
    } catch {
      /* non-fatal — user can retry */
    }
  }

  async function onSubmit() {
    if (!hostedFieldsRef.current || !cardReady) {
      setSubmitError("Payment isn't ready yet — please wait a moment and try again.");
      return;
    }
    const validity = isFormValid();
    if (!validity.ok) {
      setSubmitError(validity.reason);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { nonce, deviceData } = await hostedFieldsRef.current.tokenize();
      const phoneE164 = phoneToE164(phone);
      const shipping = {
        first_name: shipFirst,
        last_name: shipLast,
        address1,
        address2: address2 || undefined,
        city,
        province_code: state.toUpperCase(),
        zip,
        country_code: "US",
        phone: phoneE164 || undefined,
      };
      const billing = billingSameAsShipping
        ? shipping
        : {
            first_name: billFirst,
            last_name: billLast,
            address1: billAddress1,
            address2: billAddress2 || undefined,
            city: billCity,
            province_code: billState.toUpperCase(),
            zip: billZip,
            country_code: "US",
            phone: phoneE164 || undefined,
          };
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cart_token: cart.token,
          payment_method_nonce: nonce,
          device_data: deviceData,
          email,
          phone: phoneE164 || undefined,
          shipping_address: shipping,
          billing_address: billing,
          shipping_protection_added: shippingProtection && !!workspace.shipping_protection,
          shipping_method_code: shippingCode,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; order_id?: string; order_number?: string; error?: string; details?: string };
      if (!res.ok || !data.ok || !data.order_id) {
        setSubmitError(data.details || data.error || "Something went wrong with the payment.");
        setSubmitting(false);
        return;
      }
      track("order_placed", {
        cart_token: cart.token,
        order_id: data.order_id,
        order_number: data.order_number,
        total_cents: totalCents,
      });
      window.location.href = `/thank-you?order=${data.order_id}`;
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────
  const themeStyle = { "--storefront-primary": workspace.primary_color } as React.CSSProperties;
  // Back from checkout goes to /customize (one step back in the funnel)
  // rather than the originating PDP. The cart cookie carries the
  // session so the token query string is optional but safer.
  const backLink = `/customize?token=${encodeURIComponent(cart.token)}`;
  void sourceProductHandle; // reserved for future use (e.g. exit-to-PDP escape hatch)

  return (
    <div style={themeStyle}>
      <div className="mx-auto max-w-6xl px-4 pb-32 pt-6 sm:pt-10">
        <header className="mb-6 flex items-center justify-between">
          {workspace.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={workspace.logo_url} alt={workspace.name} className="h-8" />
          ) : (
            <span className="text-lg font-semibold">{workspace.name}</span>
          )}
          <a href={backLink} className="text-sm text-zinc-500 hover:text-zinc-800">← Back</a>
        </header>

        <h1 className="text-3xl font-bold text-zinc-900 sm:text-4xl">Checkout</h1>
        <p className="mt-2 text-base text-zinc-600">Final step — payment and shipping.</p>

        {/* Switch-to-subscribe upsell. Only shows when cart is one-time.
            Free shipping + 25% off, with reassurance copy: cancel
            anytime + 30-day money-back guarantee. */}
        {!subscribing && (
          <div className="mt-5 rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-emerald-600">
                <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-bold text-emerald-900">
                  Subscribe &amp; save 25% + free shipping
                </div>
                <div className="mt-1 text-sm text-emerald-800">
                  Cancel anytime · 30-day money-back guarantee
                </div>
                <button
                  type="button"
                  onClick={switchToSubscribe}
                  className="mt-3 inline-flex items-center rounded-full bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                >
                  Switch to Subscribe &amp; Save →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Mobile cart summary (collapsible). Hidden on desktop where
            the right sidebar shows the full cart. */}
        <details
          className="mt-5 rounded-2xl border border-zinc-200 bg-white shadow-sm lg:hidden"
          open={cartOpen}
          onToggle={(e) => setCartOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 [&::-webkit-details-marker]:hidden">
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
              <span className="text-sm font-medium text-zinc-700">{cartOpen ? "Hide" : "Show"} order summary</span>
              <svg className={`h-4 w-4 text-zinc-500 transition-transform ${cartOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold text-zinc-900">{fmt(totalCents)}</div>
              {youSaveCents > 0 && (
                <div className="text-xs font-semibold text-emerald-700">Save {fmt(youSaveCents)}</div>
              )}
            </div>
          </summary>
          <div className="border-t border-zinc-100 px-4 pb-4 pt-3">
            <OrderSummary
              cart={cart}
              subtotalCents={cart.subtotal_cents}
              msrpSubtotalCents={msrpSubtotalCents}
              shippingCents={shippingCents}
              shippingValueCents={shippingValueCents}
              totalCents={totalCents}
              youSaveCents={youSaveCents}
              protectionCents={protectionCents}
              protectionTitle={workspace.shipping_protection?.title || null}
              backLink={backLink}
              recurringCents={recurringCents}
              subscribing={subscribing}
            />
          </div>
        </details>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
          {/* ── Left column: forms ──────────────────────────────── */}
          <div className="space-y-5">
            {/* Contact card */}
            <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Your details</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="First name"
                  autoComplete="given-name"
                  name="given-name"
                  required
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                />
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Last name"
                  autoComplete="family-name"
                  name="family-name"
                  required
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                />
              </div>
              <input
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                name="email"
                required
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
              />
              <input
                type="tel"
                inputMode="numeric"
                value={phone}
                onChange={(e) => setPhone(formatPhoneDisplay(e.target.value))}
                placeholder="(555) 555-5555"
                autoComplete="tel-national"
                name="tel"
                required
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
              />

              {/* Single combined consent. Pre-checked. Setting one
                  checkbox toggles both email + SMS marketing flags so
                  the form stays clean. Transactional sends (order
                  confirmations, shipping updates) are implied by
                  purchase under CAN-SPAM/TCPA — covered by the same
                  language without a separate checkbox. */}
              <label className="mt-3 flex items-start gap-2 text-xs text-zinc-600">
                <input
                  type="checkbox"
                  checked={emailMarketingConsent && smsMarketingConsent}
                  onChange={(e) => {
                    setEmailMarketingConsent(e.target.checked);
                    setSmsMarketingConsent(e.target.checked);
                  }}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300"
                />
                <span>Email &amp; text me order updates, news &amp; coupons</span>
              </label>
            </section>

            {/* Shipping card */}
            <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Shipping address</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <input
                  value={shipFirst}
                  onChange={(e) => setShipFirst(e.target.value)}
                  placeholder="First name"
                  autoComplete="shipping given-name"
                  name="ship-given-name"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                />
                <input
                  value={shipLast}
                  onChange={(e) => setShipLast(e.target.value)}
                  placeholder="Last name"
                  autoComplete="shipping family-name"
                  name="ship-family-name"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                />
              </div>
              <input
                value={address1}
                onChange={(e) => setAddress1(e.target.value)}
                placeholder="Street address"
                autoComplete="shipping address-line1"
                name="ship-address1"
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
              />
              <input
                value={address2}
                onChange={(e) => setAddress2(e.target.value)}
                placeholder="Apt, suite, etc. (optional)"
                autoComplete="shipping address-line2"
                name="ship-address2"
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
              />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="City"
                  autoComplete="shipping address-level2"
                  name="ship-city"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                />
                <StateSelect
                  value={state}
                  onChange={setState}
                  autoComplete="shipping address-level1"
                  name="ship-state"
                />
              </div>
              <input
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                placeholder="ZIP"
                inputMode="numeric"
                autoComplete="shipping postal-code"
                name="ship-zip"
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
              />

              {workspace.shipping_protection && (
                <label className="mt-4 flex items-start gap-2 text-xs text-zinc-600">
                  <input
                    type="checkbox"
                    checked={shippingProtection}
                    onChange={(e) => setShippingProtection(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300"
                  />
                  <span>
                    {workspace.shipping_protection.description}{" "}
                    <span className="text-zinc-500">({fmt(workspace.shipping_protection.price_cents)})</span>
                  </span>
                </label>
              )}
            </section>

            {/* Shipping options — radio list. Pre-selects the rate
                flagged is_default in the DB. Only renders when we have
                at least one rate available for this cart shape. */}
            {shippingRates.length > 0 && (
              <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Shipping method</p>
                <div className="mt-3 space-y-2">
                  {shippingRates.map((r) => {
                    const selected = r.code === shippingCode;
                    return (
                      <label
                        key={r.id}
                        className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${selected ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"}`}
                      >
                        <input
                          type="radio"
                          name="shipping-method"
                          value={r.code}
                          checked={selected}
                          onChange={() => setShippingCode(r.code)}
                          className="mt-1 h-4 w-4 border-zinc-300"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-semibold text-zinc-900">{r.name}</span>
                            <span className="text-sm font-semibold text-zinc-900">
                              {r.total_cents === 0 ? "Free" : fmt(r.total_cents)}
                            </span>
                          </div>
                          {r.description && (
                            <div className="text-xs text-zinc-500">{r.description}</div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Payment card — custom Hosted Fields with a card-js
                style visual mockup. Billing address toggle + form
                lives in this same card because, mentally, billing
                belongs with payment info (AVS / processor expects
                them paired). */}
            <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Payment</p>
              {cardError ? (
                <div className="mt-3 rounded-lg bg-rose-50 px-3 py-3 text-sm text-rose-700">
                  Couldn&apos;t load payment form: {cardError}
                </div>
              ) : !clientToken ? (
                <p className="mt-3 text-xs text-zinc-500">Loading secure payment…</p>
              ) : (
                <div className="mt-3">
                  <HostedFieldsCard
                    ref={hostedFieldsRef}
                    clientToken={clientToken}
                    primaryColor={workspace.primary_color}
                    cardholderName={`${firstName} ${lastName}`.trim()}
                    onReady={() => setCardReady(true)}
                    onError={(msg) => setCardError(msg)}
                  />
                </div>
              )}

              {/* Billing address toggle + collapsible form. Lives in
                  the Payment section because billing is part of the
                  card-info gate (AVS, etc.). */}
              <label className="mt-4 flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={billingSameAsShipping}
                  onChange={(e) => setBillingSameAsShipping(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300"
                />
                Billing address same as shipping
              </label>

              {!billingSameAsShipping && (
                <div className="mt-3 space-y-2 rounded-xl bg-zinc-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Billing address</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input
                      value={billFirst}
                      onChange={(e) => setBillFirst(e.target.value)}
                      placeholder="First name"
                      autoComplete="billing given-name"
                      name="bill-given-name"
                      className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                    />
                    <input
                      value={billLast}
                      onChange={(e) => setBillLast(e.target.value)}
                      placeholder="Last name"
                      autoComplete="billing family-name"
                      name="bill-family-name"
                      className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                    />
                  </div>
                  <input
                    value={billAddress1}
                    onChange={(e) => setBillAddress1(e.target.value)}
                    placeholder="Street address"
                    autoComplete="billing address-line1"
                    name="bill-address1"
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                  />
                  <input
                    value={billAddress2}
                    onChange={(e) => setBillAddress2(e.target.value)}
                    placeholder="Apt, suite, etc. (optional)"
                    autoComplete="billing address-line2"
                    name="bill-address2"
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={billCity}
                      onChange={(e) => setBillCity(e.target.value)}
                      placeholder="City"
                      autoComplete="billing address-level2"
                      name="bill-city"
                      className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                    />
                    <StateSelect
                      value={billState}
                      onChange={setBillState}
                      autoComplete="billing address-level1"
                      name="bill-state"
                    />
                  </div>
                  <input
                    value={billZip}
                    onChange={(e) => setBillZip(e.target.value)}
                    placeholder="ZIP"
                    inputMode="numeric"
                    autoComplete="billing postal-code"
                    name="bill-zip"
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                  />
                </div>
              )}
            </section>

            {submitError && (
              <div className="rounded-lg bg-rose-50 px-3 py-3 text-sm text-rose-700">{submitError}</div>
            )}
          </div>

          {/* ── Right sidebar: cart + reviews ────────────────────── */}
          <aside className="hidden lg:block">
            <div className="sticky top-6 space-y-5">
              <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Your order</p>
                <div className="mt-3">
                  <OrderSummary
              cart={cart}
              subtotalCents={cart.subtotal_cents}
              msrpSubtotalCents={msrpSubtotalCents}
              shippingCents={shippingCents}
              shippingValueCents={shippingValueCents}
              totalCents={totalCents}
              youSaveCents={youSaveCents}
              protectionCents={protectionCents}
              protectionTitle={workspace.shipping_protection?.title || null}
              backLink={backLink}
              recurringCents={recurringCents}
              subscribing={subscribing}
            />
                </div>
              </section>

              {featuredReviews.length > 0 && (
                <section>
                  <h3 className="mb-3 text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    What customers are saying
                  </h3>
                  <HeroFeaturedReviews
                    reviews={featuredReviews}
                    workspaceSlug={workspace.storefront_slug || undefined}
                    slug={primaryProductHandle || undefined}
                  />
                </section>
              )}
            </div>
          </aside>
        </div>

        {/* Reviews on mobile, at the end */}
        {featuredReviews.length > 0 && (
          <section className="mt-8 lg:hidden">
            <h3 className="mb-3 text-center text-xs font-semibold uppercase tracking-wider text-zinc-500">
              What customers are saying
            </h3>
            <HeroFeaturedReviews
              reviews={featuredReviews}
              workspaceSlug={workspace.storefront_slug || undefined}
              slug={primaryProductHandle || undefined}
            />
          </section>
        )}
      </div>

      {/* Sticky bottom CTA — mobile + desktop both. Stacks a tiny
          trust strip above the price row so customers see the
          guarantee + terms before they tap. */}
      <section className="fixed inset-x-0 bottom-0 z-10 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto max-w-6xl">
          {/* Money-back guarantee — prominent, single line */}
          <div className="mb-2 flex items-center justify-center gap-1.5 text-xs font-medium text-emerald-800">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>30-day money-back guarantee{subscribing ? " · cancel anytime" : ""}</span>
          </div>
          {/* Terms checkbox — pre-checked, blocks submit when off */}
          <label className="mb-2 flex items-center justify-center gap-1.5 text-xs text-zinc-600">
            <input
              type="checkbox"
              checked={agreeToTerms}
              onChange={(e) => setAgreeToTerms(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-300"
            />
            <span>
              I agree to the{" "}
              <a href="/policies" target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                store policies and terms
              </a>
            </span>
          </label>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-2xl font-bold leading-tight text-zinc-900">{fmt(totalCents)}</div>
              {youSaveCents > 0 ? (
                <div className="mt-0.5 text-xs font-semibold text-emerald-700">You save {fmt(youSaveCents)}</div>
              ) : (
                <div className="mt-0.5 text-xs text-zinc-500">Charged today</div>
              )}
            </div>
            <button
              type="button"
              onClick={onSubmit}
              disabled={submitting || !cardReady || !agreeToTerms}
              style={{ backgroundColor: workspace.primary_color }}
              className="rounded-full px-7 py-3 text-sm font-extrabold uppercase tracking-wider text-white shadow-md disabled:opacity-50"
            >
              {submitting ? "Processing…" : "Complete order"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Order summary — line items + totals. Used in both the desktop right
// sidebar and the mobile collapsible section.
// ────────────────────────────────────────────────────────────────────
function OrderSummary({
  cart,
  subtotalCents,
  msrpSubtotalCents,
  shippingCents,
  shippingValueCents,
  totalCents,
  youSaveCents,
  protectionCents,
  protectionTitle,
  backLink,
  recurringCents,
  subscribing,
}: {
  cart: CartDraft;
  subtotalCents: number;
  msrpSubtotalCents: number;
  shippingCents: number;
  shippingValueCents: number;
  totalCents: number;
  youSaveCents: number;
  protectionCents: number;
  protectionTitle: string | null;
  backLink: string;
  recurringCents: number;
  subscribing: boolean;
}) {
  // Strikethrough on shipping only when free AND there was a non-zero
  // value to strike through (no zero-zero strikethrough).
  const showShippingStrike = shippingCents === 0 && shippingValueCents > 0;
  return (
    <>
      <ul className="space-y-2">
        {cart.line_items.map((l: StoredLineItem, i) => {
          const linePaidCents = l.line_total_cents;
          const lineMsrpCents = (l.unit_msrp_cents || l.unit_price_cents) * l.quantity;
          const isGift = !!l.is_gift;
          return (
            <li key={`${l.variant_id}-${i}`} className="flex items-center gap-3 text-sm">
              {l.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.image_url} alt={l.title} className="h-12 w-12 flex-shrink-0 rounded-lg object-cover" />
              ) : (
                <div className="h-12 w-12 flex-shrink-0 rounded-lg bg-zinc-100" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-zinc-900">
                  {l.title}
                  {l.variant_title && l.variant_title !== "Default Title" && (
                    <span className="ml-1 text-zinc-500">— {l.variant_title}</span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">
                  {isGift ? <span className="font-semibold text-emerald-700">Free gift</span> : <>Qty {l.quantity}</>}
                </div>
              </div>
              <div className="text-right">
                {isGift ? (
                  <>
                    <div className="text-sm font-semibold text-emerald-700">Free</div>
                    {lineMsrpCents > 0 && (
                      <div className="text-xs text-zinc-400 line-through">{fmt(lineMsrpCents)}</div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="text-sm font-semibold text-zinc-900">{fmt(linePaidCents)}</div>
                    {lineMsrpCents > linePaidCents && (
                      <div className="text-xs text-zinc-400 line-through">{fmt(lineMsrpCents)}</div>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
        {protectionCents > 0 && (
          <li className="flex items-center gap-3 text-sm">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-zinc-100">
              <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-zinc-900">{protectionTitle || "Shipping protection"}</div>
              <div className="text-xs text-zinc-500">This order is protected from loss or damage</div>
            </div>
            <div className="text-right">
              <div className="text-sm font-semibold text-zinc-900">{fmt(protectionCents)}</div>
            </div>
          </li>
        )}
      </ul>
      <div className="mt-3 text-right text-xs">
        <a href={backLink} className="text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline">
          Make changes
        </a>
      </div>
      <dl className="mt-3 space-y-1 border-t border-zinc-200 pt-3 text-sm">
        <Row label="Subtotal" value={fmt(subtotalCents)} />
        {msrpSubtotalCents > subtotalCents && (
          <Row label="Discount" value={`-${fmt(msrpSubtotalCents - subtotalCents)}`} muted />
        )}
        {showShippingStrike ? (
          <div className="flex items-baseline justify-between">
            <dt className="text-sm text-zinc-600">Shipping</dt>
            <dd className="text-sm text-zinc-700">
              <span className="mr-1.5 text-zinc-400 line-through">{fmt(shippingValueCents)}</span>
              <span className="font-semibold text-emerald-700">Free</span>
            </dd>
          </div>
        ) : (
          <Row label="Shipping" value={shippingCents === 0 ? "Free" : fmt(shippingCents)} />
        )}
        <Row label="Total" value={fmt(totalCents)} emphasis />
        {subscribing && recurringCents > 0 && (
          <div className="mt-1 flex items-baseline justify-between text-xs text-zinc-500">
            <dt>Recurring total</dt>
            <dd>
              {fmt(recurringCents)} <span className="text-zinc-400">· cancel anytime</span>
            </dd>
          </div>
        )}
        {youSaveCents > 0 && (
          <div className="flex items-baseline justify-end pt-1">
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
              You save {fmt(youSaveCents)}
            </span>
          </div>
        )}
      </dl>
    </>
  );
}

function Row({ label, value, emphasis, muted }: { label: string; value: string; emphasis?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className={`text-sm ${emphasis ? "font-semibold text-zinc-900" : muted ? "text-zinc-500" : "text-zinc-600"}`}>{label}</dt>
      <dd className={emphasis ? "text-base font-bold text-zinc-900" : muted ? "text-zinc-500" : "text-zinc-700"}>{value}</dd>
    </div>
  );
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Mirrors the formatter we use in journey minisites — "(858) 334-9198"
// rendering as the customer types. Caller stores the formatted value
// in state; we E.164-ize at submit time.
function formatPhoneDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function phoneToE164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return raw.startsWith("+") ? raw : `+1${digits}`;
}

function isPhoneComplete(raw: string): boolean {
  return raw.replace(/\D/g, "").length === 10;
}

// All US states + DC + PR. Code/name pairs so the option label is
// readable but the stored value is the 2-letter ISO 3166-2 code (which
// is what Braintree / Amplifier / shipping carriers expect).
const US_STATES: Array<{ code: string; name: string }> = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "DC", name: "District of Columbia" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "PR", name: "Puerto Rico" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
];

function StateSelect({
  value,
  onChange,
  autoComplete,
  name,
}: {
  value: string;
  onChange: (next: string) => void;
  autoComplete: string;
  name: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete}
      name={name}
      className={`w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base focus:border-zinc-500 focus:outline-none ${value ? "text-zinc-900" : "text-zinc-400"}`}
    >
      <option value="">State</option>
      {US_STATES.map((s) => (
        <option key={s.code} value={s.code}>{s.name}</option>
      ))}
    </select>
  );
}
