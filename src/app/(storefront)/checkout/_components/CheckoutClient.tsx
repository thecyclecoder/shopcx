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
import Script from "next/script";
import { initPixel, track } from "@/lib/storefront-pixel";
import { HeroFeaturedReviews } from "../../_components/HeroFeaturedReviews";
import type { Review } from "../../_lib/page-data";
import type { CartDraft, StoredLineItem } from "../../customize/_components/CustomizeClient";

const DROPIN_SRC = "https://js.braintreegateway.com/web/dropin/1.43.0/js/dropin.min.js";
const ESTIMATED_SHIPPING_PER_ITEM_CENTS = 495;

interface DropinInstance {
  requestPaymentMethod: () => Promise<{ nonce: string; deviceData?: string; type?: string }>;
  teardown: (cb?: (err?: unknown) => void) => void;
}
interface BraintreeDropinGlobal {
  create: (config: { authorization: string; container: HTMLElement }) => Promise<DropinInstance>;
}
declare global {
  interface Window {
    braintree?: { dropin?: BraintreeDropinGlobal };
  }
}

interface Workspace {
  id: string;
  name: string;
  logo_url: string | null;
  primary_color: string;
  storefront_domain: string | null;
  storefront_slug: string | null;
}

export function CheckoutClient({
  cart,
  workspace,
  sourceProductHandle,
  featuredReviews,
  primaryProductHandle,
}: {
  cart: CartDraft;
  workspace: Workspace;
  sourceProductHandle: string | null;
  featuredReviews: Review[];
  primaryProductHandle: string | null;
}) {
  // ── Pricing ──────────────────────────────────────────────────────
  const totalUnits = useMemo(() => cart.line_items.reduce((s, l) => s + l.quantity, 0), [cart.line_items]);
  const subscribing = cart.line_items.some((l) => l.mode === "subscribe");
  const shippingCents = subscribing ? 0 : totalUnits * ESTIMATED_SHIPPING_PER_ITEM_CENTS;
  const taxCents = 0;
  const totalCents = cart.subtotal_cents + shippingCents + taxCents;
  const msrpSubtotalCents = useMemo(
    () => cart.line_items.reduce((s, l) => s + (l.unit_msrp_cents || l.unit_price_cents) * l.quantity, 0),
    [cart.line_items],
  );
  const youSaveCents = Math.max(0, msrpSubtotalCents - cart.subtotal_cents);

  // ── Form state ────────────────────────────────────────────────────
  const [email, setEmail] = useState(cart.email || "");
  const [phone, setPhone] = useState(cart.phone || "");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
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
  const [shipPhone, setShipPhone] = useState("");
  const [billingSameAsShipping, setBillingSameAsShipping] = useState(true);
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

  // ── Drop-in lifecycle ────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dropinRef = useRef<DropinInstance | null>(null);
  const [dropinReady, setDropinReady] = useState(false);
  const [dropinError, setDropinError] = useState<string | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);

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
    if (!scriptLoaded || !containerRef.current || dropinRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const tokenRes = await fetch("/api/checkout/client-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cart_token: cart.token }),
        });
        if (!tokenRes.ok) {
          const err = await tokenRes.json().catch(() => ({ error: "client_token_failed" }));
          throw new Error(err.error || "client_token_failed");
        }
        const { client_token } = (await tokenRes.json()) as { client_token: string };
        if (cancelled) return;
        const dropin = window.braintree?.dropin;
        if (!dropin || !containerRef.current) throw new Error("dropin_not_loaded");
        const instance = await dropin.create({
          authorization: client_token,
          container: containerRef.current,
        });
        if (cancelled) { instance.teardown(); return; }
        dropinRef.current = instance;
        setDropinReady(true);
      } catch (err) {
        setDropinError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (dropinRef.current) { dropinRef.current.teardown(); dropinRef.current = null; }
    };
  }, [scriptLoaded, cart.token]);

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
    return { ok: true };
  }

  async function onSubmit() {
    if (!dropinRef.current) {
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
      const { nonce, deviceData } = await dropinRef.current.requestPaymentMethod();
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
        phone: (shipPhone && phoneToE164(shipPhone)) || phoneE164 || undefined,
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
  const backLink = sourceProductHandle ? `/${sourceProductHandle}` : null;

  return (
    <div style={themeStyle}>
      <Script src={DROPIN_SRC} strategy="afterInteractive" onLoad={() => setScriptLoaded(true)} onReady={() => setScriptLoaded(true)} />
      <div className="mx-auto max-w-6xl px-4 pb-32 pt-6 sm:pt-10">
        <header className="mb-6 flex items-center justify-between">
          {workspace.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={workspace.logo_url} alt={workspace.name} className="h-8" />
          ) : (
            <span className="text-lg font-semibold">{workspace.name}</span>
          )}
          {backLink && (
            <a href={backLink} className="text-sm text-zinc-500 hover:text-zinc-800">← Back</a>
          )}
        </header>

        <h1 className="text-3xl font-bold text-zinc-900 sm:text-4xl">Checkout</h1>
        <p className="mt-2 text-base text-zinc-600">Final step — payment and shipping.</p>

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
            <OrderSummary cart={cart} subtotalCents={cart.subtotal_cents} msrpSubtotalCents={msrpSubtotalCents} shippingCents={shippingCents} totalCents={totalCents} youSaveCents={youSaveCents} />
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

              {/* Combined consent. Pre-checked. Transactional sends
                  (order confirmations, shipping updates) are implied
                  by purchase under CAN-SPAM/TCPA — the language here
                  rolls those into the same opt-in row for a single
                  decision the customer can decline if they want. */}
              <div className="mt-3 space-y-1.5 text-xs text-zinc-600">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={emailMarketingConsent}
                    onChange={(e) => setEmailMarketingConsent(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300"
                  />
                  <span>Email me order updates, special coupons and news</span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={smsMarketingConsent}
                    onChange={(e) => setSmsMarketingConsent(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300"
                  />
                  <span>Text me order updates, special coupons and news</span>
                </label>
              </div>
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
              <div className="mt-2 grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
                <input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="City"
                  autoComplete="shipping address-level2"
                  name="ship-city"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                />
                <input
                  value={state}
                  onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))}
                  placeholder="State"
                  maxLength={2}
                  autoComplete="shipping address-level1"
                  name="ship-state"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base uppercase text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                />
                <input
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                  placeholder="ZIP"
                  inputMode="numeric"
                  autoComplete="shipping postal-code"
                  name="ship-zip"
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                />
              </div>
              <input
                type="tel"
                inputMode="numeric"
                value={shipPhone}
                onChange={(e) => setShipPhone(formatPhoneDisplay(e.target.value))}
                placeholder="Phone (for delivery questions, optional)"
                autoComplete="shipping tel-national"
                name="ship-tel"
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
              />
            </section>

            {/* Payment card — Drop-in collects card fields. Billing
                address lives here too: a toggle (default on = "same as
                shipping") and, when off, the full billing form. Same
                section because mentally that's all "payment info". */}
            <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Payment</p>
              {dropinError ? (
                <div className="mt-3 rounded-lg bg-rose-50 px-3 py-3 text-sm text-rose-700">
                  Couldn&apos;t load payment form: {dropinError}
                </div>
              ) : (
                <>
                  <div ref={containerRef} className="mt-3 min-h-[200px]" />
                  {!dropinReady && (
                    <p className="mt-2 text-xs text-zinc-500">Loading secure payment…</p>
                  )}
                </>
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
                  <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
                    <input
                      value={billCity}
                      onChange={(e) => setBillCity(e.target.value)}
                      placeholder="City"
                      autoComplete="billing address-level2"
                      name="bill-city"
                      className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                    />
                    <input
                      value={billState}
                      onChange={(e) => setBillState(e.target.value.toUpperCase().slice(0, 2))}
                      placeholder="State"
                      maxLength={2}
                      autoComplete="billing address-level1"
                      name="bill-state"
                      className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base uppercase text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                    />
                    <input
                      value={billZip}
                      onChange={(e) => setBillZip(e.target.value)}
                      placeholder="ZIP"
                      inputMode="numeric"
                      autoComplete="billing postal-code"
                      name="bill-zip"
                      className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
                    />
                  </div>
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
                  <OrderSummary cart={cart} subtotalCents={cart.subtotal_cents} msrpSubtotalCents={msrpSubtotalCents} shippingCents={shippingCents} totalCents={totalCents} youSaveCents={youSaveCents} />
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

      {/* Sticky bottom CTA — mobile + desktop both */}
      <section className="fixed inset-x-0 bottom-0 z-10 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
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
            disabled={submitting || !dropinReady}
            style={{ backgroundColor: workspace.primary_color }}
            className="rounded-full px-7 py-3 text-sm font-extrabold uppercase tracking-wider text-white shadow-md disabled:opacity-50"
          >
            {submitting ? "Processing…" : `Pay ${fmt(totalCents)}`}
          </button>
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
  totalCents,
  youSaveCents,
}: {
  cart: CartDraft;
  subtotalCents: number;
  msrpSubtotalCents: number;
  shippingCents: number;
  totalCents: number;
  youSaveCents: number;
}) {
  return (
    <>
      <ul className="space-y-2">
        {cart.line_items.map((l: StoredLineItem, i) => {
          const linePaidCents = l.line_total_cents;
          const lineMsrpCents = (l.unit_msrp_cents || l.unit_price_cents) * l.quantity;
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
                <div className="text-xs text-zinc-500">Qty {l.quantity}</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-zinc-900">{fmt(linePaidCents)}</div>
                {lineMsrpCents > linePaidCents && (
                  <div className="text-xs text-zinc-400 line-through">{fmt(lineMsrpCents)}</div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <dl className="mt-4 space-y-1 border-t border-zinc-200 pt-3 text-sm">
        <Row label="Subtotal" value={fmt(subtotalCents)} />
        {msrpSubtotalCents > subtotalCents && (
          <Row label="Discount" value={`-${fmt(msrpSubtotalCents - subtotalCents)}`} muted />
        )}
        <Row label="Shipping" value={shippingCents === 0 ? "Free" : fmt(shippingCents)} />
        <Row label="Total" value={fmt(totalCents)} emphasis />
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
