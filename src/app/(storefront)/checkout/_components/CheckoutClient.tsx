"use client";

/**
 * Checkout client island.
 *
 *  - Loads Braintree's Drop-in script from the CDN (so we don't bundle
 *    it). Once it's ready we call `dropin.create` with the
 *    client_token fetched from /api/checkout/client-token.
 *  - Renders email + shipping address fields above the Drop-in.
 *  - On submit, calls `dropin.requestPaymentMethod()` to get the nonce
 *    plus deviceData, then POSTs everything to /api/checkout. On
 *    success the server returns an order id and we redirect to
 *    /thank-you.
 *
 * Shipping/tax are computed server-side at /api/checkout time. The
 * client just shows the subtotal-based total it pulled from the cart
 * + a stubbed shipping line; the server's response is authoritative.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Script from "next/script";
import { initPixel, track } from "@/lib/storefront-pixel";
import type { CartDraft, StoredLineItem } from "../../customize/_components/CustomizeClient";

const DROPIN_SRC = "https://js.braintreegateway.com/web/dropin/1.43.0/js/dropin.min.js";
const ESTIMATED_SHIPPING_PER_ITEM_CENTS = 495;

interface DropinInstance {
  requestPaymentMethod: () => Promise<{ nonce: string; deviceData?: string; type?: string }>;
  teardown: (cb?: (err?: unknown) => void) => void;
}

// Minimal shape we use off the global; full typings would bloat the
// component without buying anything.
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
}

export function CheckoutClient({
  cart,
  workspace,
  sourceProductHandle,
}: {
  cart: CartDraft;
  workspace: Workspace;
  sourceProductHandle: string | null;
}) {
  // ── Pricing snapshot ─────────────────────────────────────────────
  const totalUnits = useMemo(
    () => cart.line_items.reduce((s, l) => s + l.quantity, 0),
    [cart.line_items],
  );
  const subscribing = cart.line_items.some((l) => l.mode === "subscribe");
  const shippingCents = subscribing ? 0 : totalUnits * ESTIMATED_SHIPPING_PER_ITEM_CENTS;
  const taxCents = 0;
  const totalCents = cart.subtotal_cents + shippingCents + taxCents;

  // ── Form state ───────────────────────────────────────────────────
  const [email, setEmail] = useState(cart.email || "");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [phone, setPhone] = useState(cart.phone || "");
  const [billingSameAsShipping, setBillingSameAsShipping] = useState(true);

  // ── Drop-in lifecycle ────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dropinRef = useRef<DropinInstance | null>(null);
  const [dropinReady, setDropinReady] = useState(false);
  const [dropinError, setDropinError] = useState<string | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);

  useEffect(() => {
    initPixel({
      workspaceId: workspace.id,
      customerId: cart.customer_id,
    });
    track("checkout_view", {
      cart_token: cart.token,
      line_item_count: cart.line_items.length,
      total_cents: totalCents,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount the Drop-in once both the script + container are present.
  useEffect(() => {
    if (!scriptLoaded) return;
    if (!containerRef.current) return;
    if (dropinRef.current) return;

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
        if (cancelled) {
          instance.teardown();
          return;
        }
        dropinRef.current = instance;
        setDropinReady(true);
      } catch (err) {
        setDropinError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      if (dropinRef.current) {
        dropinRef.current.teardown();
        dropinRef.current = null;
      }
    };
  }, [scriptLoaded, cart.token]);

  // ── Submit ───────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function isFormValid(): boolean {
    return (
      !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
      !!firstName && !!lastName &&
      !!address1 && !!city && !!state && !!zip
    );
  }

  async function onSubmit() {
    if (!dropinRef.current) {
      setSubmitError("Payment isn't ready yet — please wait a moment and try again.");
      return;
    }
    if (!isFormValid()) {
      setSubmitError("Please fill in your email + shipping address.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { nonce, deviceData } = await dropinRef.current.requestPaymentMethod();
      const shipping = {
        first_name: firstName,
        last_name: lastName,
        address1,
        address2: address2 || undefined,
        city,
        province_code: state.toUpperCase(),
        zip,
        country_code: "US",
        phone: phone || undefined,
      };
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cart_token: cart.token,
          payment_method_nonce: nonce,
          device_data: deviceData,
          email,
          phone: phone || undefined,
          shipping_address: shipping,
          billing_address: billingSameAsShipping ? shipping : shipping, // TODO: separate fields when toggle off
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        order_id?: string;
        order_number?: string;
        error?: string;
        details?: string;
      };
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
      <Script
        src={DROPIN_SRC}
        strategy="afterInteractive"
        onLoad={() => setScriptLoaded(true)}
        onReady={() => setScriptLoaded(true)}
      />
      <div className="mx-auto max-w-3xl px-4 pb-32 pt-6 sm:pt-10">
        <header className="mb-6 flex items-center justify-between">
          {workspace.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={workspace.logo_url} alt={workspace.name} className="h-8" />
          ) : (
            <span className="text-lg font-semibold">{workspace.name}</span>
          )}
          {backLink && (
            <a href={backLink} className="text-sm text-zinc-500 hover:text-zinc-800">
              ← Back
            </a>
          )}
        </header>

        <h1 className="text-3xl font-bold text-zinc-900 sm:text-4xl">Checkout</h1>
        <p className="mt-2 text-base text-zinc-600">Final step — payment and shipping.</p>

        {/* Order summary */}
        <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Your order</p>
          <ul className="mt-3 space-y-2">
            {cart.line_items.map((l: StoredLineItem, i) => (
              <li key={`${l.variant_id}-${i}`} className="flex items-center gap-3 text-sm">
                {l.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={l.image_url} alt={l.title} className="h-10 w-10 flex-shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="h-10 w-10 flex-shrink-0 rounded-lg bg-zinc-100" />
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
                <div className="text-sm font-semibold text-zinc-900">{fmt(l.line_total_cents)}</div>
              </li>
            ))}
          </ul>
          <dl className="mt-4 space-y-1 border-t border-zinc-200 pt-3 text-sm">
            <Row label="Subtotal" value={fmt(cart.subtotal_cents)} />
            <Row label="Shipping" value={shippingCents === 0 ? "Free" : fmt(shippingCents)} />
            <Row label="Total" value={fmt(totalCents)} emphasis />
          </dl>
        </section>

        {/* Contact + shipping */}
        <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Contact</p>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="mt-3 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
          />
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone (optional)"
            className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
          />

          <p className="mt-6 text-xs font-semibold uppercase tracking-wider text-zinc-500">Shipping address</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" autoComplete="given-name" className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none" />
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" autoComplete="family-name" className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none" />
          </div>
          <input value={address1} onChange={(e) => setAddress1(e.target.value)} placeholder="Street address" autoComplete="address-line1" className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none" />
          <input value={address2} onChange={(e) => setAddress2(e.target.value)} placeholder="Apt, suite, etc. (optional)" autoComplete="address-line2" className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none" />
          <div className="mt-2 grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" autoComplete="address-level2" className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none" />
            <input value={state} onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))} placeholder="State" maxLength={2} autoComplete="address-level1" className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base uppercase text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none" />
            <input value={zip} onChange={(e) => setZip(e.target.value)} placeholder="ZIP" inputMode="numeric" autoComplete="postal-code" className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none" />
          </div>

          <label className="mt-4 flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={billingSameAsShipping}
              onChange={(e) => setBillingSameAsShipping(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300"
            />
            Billing address same as shipping
          </label>
        </section>

        {/* Payment */}
        <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
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
        </section>

        {submitError && (
          <div className="mt-4 rounded-lg bg-rose-50 px-3 py-3 text-sm text-rose-700">
            {submitError}
          </div>
        )}
      </div>

      {/* Sticky bottom CTA */}
      <section className="fixed inset-x-0 bottom-0 z-10 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:relative sm:mx-auto sm:mt-6 sm:max-w-3xl sm:rounded-2xl sm:border sm:px-6 sm:py-4 sm:shadow-lg">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <div>
            <div className="text-2xl font-bold leading-tight text-zinc-900">{fmt(totalCents)}</div>
            <div className="mt-0.5 text-xs text-zinc-500">Charged today</div>
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

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className={`text-sm ${emphasis ? "font-semibold text-zinc-900" : "text-zinc-600"}`}>{label}</dt>
      <dd className={emphasis ? "text-base font-bold text-zinc-900" : "text-zinc-700"}>{value}</dd>
    </div>
  );
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
