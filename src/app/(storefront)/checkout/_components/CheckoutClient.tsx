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
import { errText } from "@/lib/error-text";
import { initPixel, track } from "@/lib/storefront-pixel";
import { HeroFeaturedReviews } from "../../_components/HeroFeaturedReviews";
import type { Review } from "../../_lib/page-data";
import type { CartDraft, StoredLineItem } from "../../customize/_components/CustomizeClient";
import { HostedFieldsCard, type HostedFieldsCardHandle } from "./HostedFieldsCard";
import { PayPalButton } from "./PayPalButton";

interface SavedAddress {
  first_name?: string | null;
  last_name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province_code?: string | null;
  zip?: string | null;
  country_code?: string | null;
  phone?: string | null;
}

interface Workspace {
  id: string;
  name: string;
  logo_url: string | null;
  primary_color: string;
  storefront_domain: string | null;
  storefront_slug: string | null;
  meta_pixel_id?: string | null;
  skip_customize?: boolean;
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
  // Tax is computed by Avalara once the customer has a shipping
  // address. Stays 0 until the quote returns; refreshes on address /
  // shipping method / protection change. See the useEffect below.
  const [taxCents, setTaxCents] = useState<number>(0);
  const [taxLoading, setTaxLoading] = useState(false);

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
  // Coupon discount persisted on the cart (e.g. WELCOME/COMEBACK). The
  // customize page subtracts it from the displayed total; checkout must too,
  // or the price jumps up between pages and the customer bails.
  const couponDiscountCents = cart.discount_cents || 0;
  const youSaveCents = Math.max(0, msrpSubtotalCents - cart.subtotal_cents) + shippingSavedCents + couponDiscountCents;

  // ── Form state ────────────────────────────────────────────────────
  const [email, setEmail] = useState(cart.email || "");
  // Cart phones are stored E.164 ("+18583349198"); hydrate as the
  // pretty national format so the customer never sees the country code.
  const [phone, setPhone] = useState(formatPhoneDisplay(cart.phone || ""));
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
  // Saved shipping addresses (across linked accounts), loaded on mount via
  // /api/checkout/me once authenticated. chosenAddrIdx === null means "use a
  // new address" (the manual fields below).
  const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([]);
  const [chosenAddrIdx, setChosenAddrIdx] = useState<number | null>(null);
  const [billingSameAsShipping, setBillingSameAsShipping] = useState(true);
  // Shipping protection — default on when workspace has it enabled.
  // Customer can uncheck to opt out. Adds price_cents to the total.
  const protectionPriceCents = workspace.shipping_protection?.price_cents ?? 0;
  const [shippingProtection, setShippingProtection] = useState(!!workspace.shipping_protection);
  const protectionCents = shippingProtection && workspace.shipping_protection ? protectionPriceCents : 0;
  const totalCents = cart.subtotal_cents - couponDiscountCents + shippingCents + taxCents + protectionCents;
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

  // Primary product for conversion attribution — the highest-value line (so the
  // advertorial-lander → purchase funnel resolves per product). checkout_view +
  // order_placed previously carried no product_id.
  const primaryProductId = useMemo(() => {
    let best: { product_id: string; line_total_cents: number } | null = null;
    for (const l of cart.line_items) {
      if (!best || l.line_total_cents > best.line_total_cents) best = { product_id: l.product_id, line_total_cents: l.line_total_cents };
    }
    return best?.product_id ?? null;
  }, [cart.line_items]);

  // ── Braintree Hosted Fields ─────────────────────────────────────
  // We fetch a client_token here, then pass it to the HostedFieldsCard
  // which owns the visual mockup + iframe lifecycle.
  const hostedFieldsRef = useRef<HostedFieldsCardHandle | null>(null);
  const [clientToken, setClientToken] = useState<string | null>(null);
  // Declared up here (not with the OTP state below) because the client-token
  // effect depends on it to refetch the token after auth.
  const [authedCustomerId, setAuthedCustomerId] = useState<string | null>(null);
  const [cardReady, setCardReady] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  useEffect(() => {
    initPixel({ workspaceId: workspace.id, customerId: cart.customer_id, metaPixelId: workspace.meta_pixel_id || null });
    // Fire checkout_view (→ Meta InitiateCheckout) once per cart token. Checkout
    // is now the first funnel page AND the return target from "Customize your
    // order", so guard against a round-trip double-firing InitiateCheckout.
    const seenKey = `cx_checkout_view_${cart.token}`;
    let seen = false;
    try { seen = sessionStorage.getItem(seenKey) === "1"; } catch { /* private mode */ }
    if (!seen) {
      try { sessionStorage.setItem(seenKey, "1"); } catch { /* ignore */ }
      track("checkout_view", {
        cart_token: cart.token,
        line_item_count: cart.line_items.length,
        total_cents: totalCents,
        product_id: primaryProductId ?? undefined,
      });
    }
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
        const msg = errText(err);
        setCardError(msg);
        logBlock("client_token", "client_token_failed", msg);
      }
    })();
    return () => { cancelled = true; };
    // Re-fetch when auth changes: OTP verify sets authedCustomerId and clears
    // the token (setClientToken(null)) to force Drop-in to re-mount bound to the
    // customer's Braintree vault. Without authedCustomerId in the deps the token
    // was cleared and NEVER refetched — "Loading secure payment…" stuck forever.
  }, [cart.token, authedCustomerId]);

  // Apply a saved address to the shipping fields.
  function applyAddress(a: SavedAddress) {
    if (a.first_name) setShipFirst(a.first_name);
    if (a.last_name) setShipLast(a.last_name);
    setAddress1(a.address1 || "");
    setAddress2(a.address2 || "");
    setCity(a.city || "");
    setState(a.province_code || "");
    setZip(a.zip || "");
  }

  // ── Hydrate auth + saved addresses on mount ──────────────────────
  // A refresh after OTP keeps the session cookie, so the server still knows the
  // customer — but the client lost authedCustomerId (and with it the sub-mode
  // chooser). Re-hydrate it here, and load saved addresses for the picker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/checkout/me?cart_token=${encodeURIComponent(cart.token)}`);
        const data = (await res.json()) as {
          authed?: boolean;
          customer?: { id: string; first_name?: string | null; last_name?: string | null; phone?: string | null };
          addresses?: SavedAddress[];
        };
        if (cancelled || !data.authed || !data.customer) return;
        setAuthedCustomerId(data.customer.id);
        setFirstName((v) => v || data.customer!.first_name || "");
        setLastName((v) => v || data.customer!.last_name || "");
        if (data.customer.phone) setPhone((v) => v || formatPhoneDisplay(data.customer!.phone as string));
        const addrs = data.addresses || [];
        setSavedAddresses(addrs);
        // Default to the most recent saved address (mount-time shipping fields
        // are empty — this is the refresh-after-OTP case).
        if (addrs.length > 0) {
          setChosenAddrIdx(0);
          applyAddress(addrs[0]);
        }
      } catch { /* anon or transient — fall back to manual entry */ }
    })();
    return () => { cancelled = true; };
    // Re-run after OTP (authedCustomerId flips null→id) so the saved-address
    // picker populates without needing a refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.token, authedCustomerId]);

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

  // ── Tax quote (Avalara, debounced) ───────────────────────────────
  // Re-quote whenever the customer changes anything that affects the
  // tax base: shipping address, shipping method, shipping protection.
  // Returns 0 silently when the address isn't complete or when
  // Avalara isn't configured.
  const taxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (taxTimer.current) clearTimeout(taxTimer.current);
    const ready = address1 && city && state && zip;
    if (!ready) { setTaxCents(0); return; }
    setTaxLoading(true);
    taxTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/checkout/tax-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cart_token: cart.token,
            shipping_address: {
              address1,
              address2: address2 || undefined,
              city,
              province_code: state,
              zip,
              country_code: "US",
            },
            shipping_method_code: shippingCode,
            shipping_protection_added: shippingProtection,
          }),
        });
        if (!res.ok) { setTaxCents(0); return; }
        const data = (await res.json()) as { tax_cents?: number };
        setTaxCents(data.tax_cents || 0);
      } catch {
        setTaxCents(0);
      } finally {
        setTaxLoading(false);
      }
    }, 500);
    return () => { if (taxTimer.current) clearTimeout(taxTimer.current); };
  }, [cart.token, address1, address2, city, state, zip, shippingCode, shippingProtection]);

  // ── OTP login (Shop Pay style) ───────────────────────────────────
  // When the email field BLURS with a valid email, ping the
  // start-OTP endpoint. If the response says we have a returning
  // customer, surface the modal so they can log in to autofill
  // name/address/saved cards. Triggered on blur (not keyup) so we
  // don't bombard the API on every keystroke.
  type OtpState = {
    open: boolean;
    sessionId: string | null;
    channel: "sms" | "email";
    maskedDestination: string;
    hasSms: boolean;
    hasEmail: boolean;
    fellBack: boolean;
    code: string;
    busy: boolean;
    error: string | null;
    resendCountdown: number;
    statusMsg: string | null;
  };
  const [otp, setOtp] = useState<OtpState>({
    open: false, sessionId: null, channel: "sms", maskedDestination: "",
    hasSms: false, hasEmail: false, fellBack: false, code: "", busy: false, error: null,
    resendCountdown: 0, statusMsg: null,
  });
  // Once the customer dismisses the OTP (can't get the code, wants to check out
  // as a guest), don't re-prompt them — even when the email field blurs again.
  const otpDismissedRef = useRef(false);

  // Close the OTP and continue WITHOUT logging in: keep everything they typed,
  // stay unauthenticated (no saved cards / addresses / existing-subs UI), and
  // never reopen the prompt this session.
  function dismissOtpAsGuest() {
    otpDismissedRef.current = true;
    setOtp((s) => ({ ...s, open: false, busy: false, error: null, code: "" }));
  }

  // Saved payment methods (only when authenticated via OTP or
  // existing sx_session cookie). Used to render the "Pay with •••4242"
  // picker above the new-card Hosted Fields form.
  type SavedMethod = { id: string; token: string; brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null; is_default: boolean; payment_type: string | null; paypal_email: string | null };
  const [savedMethods, setSavedMethods] = useState<SavedMethod[]>([]);
  const [selectedSavedToken, setSelectedSavedToken] = useState<string | null>(null);
  // When no saved method is selected, which NEW method is the customer using?
  const [newMethodType, setNewMethodType] = useState<"card" | "paypal">("card");

  // Existing internal subs (only when authenticated). Drives the
  // three-way "what should we do with these items?" choice card.
  type ExistingSub = { id: string; items_summary: string; item_lines?: string[]; frequency_days: number; next_billing_date: string | null };
  const [existingSubs, setExistingSubs] = useState<ExistingSub[]>([]);
  // Three modes:
  //   "new_sub"      → current behavior, create a new sub from cart
  //   "add_to_sub"   → order now + add cart items to selected sub
  //   "renewal_only" → no order now; ride next renewal as one-time
  // Default to "add_to_sub" when an existing sub exists (prevents
  // accidental parallel subs).
  type SubMode = "new_sub" | "add_to_sub" | "renewal_only";
  const [subMode, setSubMode] = useState<SubMode>("new_sub");
  const [chosenSubId, setChosenSubId] = useState<string | null>(null);
  const [expandedSubId, setExpandedSubId] = useState<string | null>(null);

  useEffect(() => {
    // Refresh saved methods on page load + every time the client
    // token cycles (which happens after a successful OTP verify).
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/checkout/payment-methods?cart_token=${encodeURIComponent(cart.token)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { methods?: SavedMethod[] };
        if (cancelled) return;
        const methods = data.methods || [];
        setSavedMethods(methods);
        // Auto-select the default saved method so the "Pay with"
        // radio is pre-checked → fewer customer clicks.
        const defaultMethod = methods.find((m) => m.is_default) || methods[0] || null;
        setSelectedSavedToken(defaultMethod?.token || null);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [cart.token, clientToken, authedCustomerId]);

  // Fetch existing subs when authenticated. Only relevant when the
  // cart contains subscribe items.
  useEffect(() => {
    let cancelled = false;
    if (!authedCustomerId || !subscribing) {
      setExistingSubs([]);
      setSubMode("new_sub");
      setChosenSubId(null);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/checkout/existing-subs?cart_token=${encodeURIComponent(cart.token)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { subscriptions?: ExistingSub[] };
        if (cancelled) return;
        const subs = data.subscriptions || [];
        setExistingSubs(subs);
        if (subs.length > 0) {
          // Default to "Create a new subscription" — the customer adding
          // a fresh subscribe item usually wants a separate sub, not to
          // fold it into an existing one.
          setSubMode("new_sub");
          // Pre-select the first sub so the "Which subscription?" picker has a
          // sensible default IF they switch to add_to_sub / renewal_only.
          setChosenSubId(subs[0].id);
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [cart.token, authedCustomerId, subscribing]);

  async function triggerOtpStart(emailValue: string, channel?: "sms" | "email") {
    // Already verified, or the customer chose to continue as a guest → never
    // (re)prompt for a code.
    if (authedCustomerId || otpDismissedRef.current) return;
    const e = emailValue.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return;
    setOtp((s) => ({ ...s, busy: true, error: null }));
    try {
      const res = await fetch("/api/checkout/otp/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cart_token: cart.token, email: e, channel }),
      });
      const data = await res.json();
      if (!data.eligible) {
        // Not a returning customer — silently skip. We don't want
        // to nag first-time visitors with a "log in" prompt.
        setOtp((s) => ({ ...s, busy: false, open: false }));
        return;
      }
      setOtp({
        open: true,
        sessionId: data.session_id,
        channel: data.channel,
        maskedDestination: data.masked_destination,
        hasSms: !!data.has_sms,
        hasEmail: !!data.has_email,
        fellBack: !!data.fell_back,
        code: "",
        busy: false,
        error: null,
        resendCountdown: 60,
        statusMsg: null,
      });
    } catch {
      setOtp((s) => ({ ...s, busy: false }));
    }
  }

  // 1-second countdown for the resend button after each send
  useEffect(() => {
    if (otp.resendCountdown <= 0) return;
    const t = setTimeout(() => setOtp((s) => ({ ...s, resendCountdown: Math.max(0, s.resendCountdown - 1) })), 1000);
    return () => clearTimeout(t);
  }, [otp.resendCountdown]);

  async function resendCode(opts?: { channel?: "sms" | "email" }) {
    if (!otp.sessionId) return;
    setOtp((s) => ({ ...s, busy: true, error: null, statusMsg: null }));
    const res = await fetch("/api/checkout/otp/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: otp.sessionId, channel: opts?.channel }),
    });
    const data = await res.json();
    if (!res.ok) {
      setOtp((s) => ({ ...s, busy: false, error: data.error === "rate_limited" ? `Wait ${data.retry_after_seconds}s before resending` : (data.error || "Could not resend") }));
      return;
    }
    const fb = !!data.fell_back;
    setOtp((s) => ({
      ...s,
      busy: false,
      channel: data.channel,
      maskedDestination: data.masked_destination,
      fellBack: fb,
      code: "",
      resendCountdown: 60,
      statusMsg: fb
        ? `We couldn't text you, so we emailed a code to ${data.masked_destination}`
        : opts?.channel
          ? `Code sent via ${data.channel === "sms" ? "text" : "email"} to ${data.masked_destination}`
          : `New code sent to ${data.masked_destination}`,
    }));
  }

  async function submitCode() {
    if (!otp.sessionId || otp.code.length < 4) return;
    setOtp((s) => ({ ...s, busy: true, error: null }));
    const res = await fetch("/api/checkout/otp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: otp.sessionId, code: otp.code }),
    });
    const data = await res.json();
    if (!res.ok) {
      setOtp((s) => ({ ...s, busy: false, error: data.error === "invalid_code" ? "That code didn't match. Try again." : (data.error || "Verification failed") }));
      return;
    }
    // Success — autofill from the snapshot the server returned
    setAuthedCustomerId(data.customer?.id || null);
    if (data.customer?.first_name) setFirstName(data.customer.first_name);
    if (data.customer?.last_name) setLastName(data.customer.last_name);
    if (data.customer?.phone) setPhone(formatPhoneDisplay(data.customer.phone));
    const a = data.last_shipping_address as Record<string, string> | null;
    if (a) {
      if (a.first_name && !shipFirst) setShipFirst(a.first_name);
      if (a.last_name && !shipLast) setShipLast(a.last_name);
      if (a.address1) setAddress1(a.address1);
      if (a.address2) setAddress2(a.address2);
      if (a.city) setCity(a.city);
      if (a.province_code) setState(a.province_code);
      if (a.zip) setZip(a.zip);
    }
    setOtp((s) => ({ ...s, open: false, busy: false, error: null, code: "" }));
    // Force a client-token refetch so Braintree drop-in re-mounts
    // with the authenticated customer's vaulted cards.
    setClientToken(null);
  }

  function startOver() {
    setEmail("");
    setPhone("");
    setFirstName("");
    setLastName("");
    setOtp({ open: false, sessionId: null, channel: "sms", maskedDestination: "", hasSms: false, hasEmail: false, fellBack: false, code: "", busy: false, error: null, resendCountdown: 0, statusMsg: null });
    setAuthedCustomerId(null);
  }

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
  const [switchBusy, setSwitchBusy] = useState(false);
  async function switchToSubscribe() {
    setSwitchBusy(true);
    setSubmitError(null);
    try {
      // Pass BOTH ids so the server can resolve the variant either way (the
      // line might carry an internal UUID or a Shopify numeric id). Omit
      // frequency_days so /api/cart picks the product's default cadence
      // (hardcoding 30 broke products whose only cadence is e.g. 28).
      const lines = cart.line_items
        .filter((l) => !l.is_gift)
        .map((l) => ({ variant_id: l.variant_id, shopify_variant_id: (l as { shopify_variant_id?: string | null }).shopify_variant_id ?? undefined, quantity: l.quantity }));
      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          workspace_id: workspace.id,
          line_items: lines,
          mode: "subscribe",
          frequency_days: cart.subscription_frequency_days || undefined,
          email: email || undefined,
          phone: phoneToE164(phone) || undefined,
        }),
      });
      if (res.ok) {
        // Hard-reload so the server picks up the new pricing + gift injection.
        window.location.href = `/checkout?token=${encodeURIComponent(cart.token)}`;
        return;
      }
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      setSubmitError(`Couldn't switch to Subscribe & Save — ${err.error || "please try again"}.`);
      logBlock("submit", "subscribe_switch_failed", err.error || "non-ok", { http_status: res.status });
      setSwitchBusy(false);
    } catch (e) {
      setSubmitError("Couldn't switch to Subscribe & Save. Please try again.");
      logBlock("submit", "subscribe_switch_exception", errText(e));
      setSwitchBusy(false);
    }
  }

  // Log anything that blocks the customer (fire-and-forget) so we can diagnose
  // missing checkouts at go-live — see checkout_errors / /api/checkout/log-error.
  function logBlock(stage: string, code: string, message: string, context?: Record<string, unknown>) {
    void fetch("/api/checkout/log-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cart_token: cart.token, stage, error_code: code, error_message: message, context: context || {} }),
    }).catch(() => {});
  }

  async function onSubmit(paypalNonce?: string) {
    // Three payment paths: saved method (vaulted token), new card (Hosted
    // Fields → nonce), or PayPal (button → nonce passed in here).
    const usingSavedCard = !!selectedSavedToken;
    const usingPayPal = !!paypalNonce;
    if (!usingSavedCard && !usingPayPal && (!hostedFieldsRef.current || !cardReady)) {
      setSubmitError("Payment isn't ready yet — please wait a moment and try again.");
      logBlock("submit", "payment_not_ready", "Hosted Fields not ready when customer hit Pay");
      return;
    }
    const validity = isFormValid();
    if (!validity.ok) {
      setSubmitError(validity.reason);
      logBlock("validation", "invalid_form", validity.reason);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const tokenizeRes = usingSavedCard
        ? { nonce: "", deviceData: "" }
        : usingPayPal
          ? { nonce: paypalNonce!, deviceData: "" }
          : await hostedFieldsRef.current!.tokenize();
      const { nonce, deviceData } = tokenizeRes;
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
          // Saved-card path: pass the vault token directly so the
          // server skips the vault step. Server validates the token
          // actually belongs to the authenticated customer.
          ...(usingSavedCard
            ? { payment_method_token: selectedSavedToken }
            : { payment_method_nonce: nonce, device_data: deviceData }),
          email,
          phone: phoneE164 || undefined,
          // Final, authoritative marketing consent at order time (the checkbox
          // may have been toggled after the last identify call).
          email_marketing_consent: emailMarketingConsent,
          sms_marketing_consent: smsMarketingConsent,
          shipping_address: shipping,
          billing_address: billing,
          shipping_protection_added: shippingProtection && !!workspace.shipping_protection,
          shipping_method_code: shippingCode,
          // Three-way subscription routing — server uses these to
          // decide whether to create a new sub, append items to an
          // existing sub, or ride the next renewal as one-time.
          sub_mode: existingSubs.length > 0 ? subMode : "new_sub",
          existing_sub_id: (subMode === "add_to_sub" || subMode === "renewal_only") ? chosenSubId : undefined,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; order_id?: string; order_number?: string; order_placed_event_id?: string; error?: string; details?: string };
      if (!res.ok || !data.ok || !data.order_id) {
        setSubmitError(data.details || data.error || "Something went wrong with the payment.");
        // Server already logged its own detail; log the client-visible outcome
        // too so the funnel view shows the customer actually got blocked here.
        logBlock("submit", data.error || "submit_failed", data.details || data.error || "submit returned non-ok", { http_status: res.status });
        setSubmitting(false);
        return;
      }
      // Reuse the server's canonical order_placed event id so the browser
      // Meta pixel + our enqueue dedupe against the server-created row + its
      // CAPI Purchase (no divergent second conversion).
      track("order_placed", {
        cart_token: cart.token,
        order_id: data.order_id,
        order_number: data.order_number,
        total_cents: totalCents,
        product_id: primaryProductId ?? undefined,
      }, data.order_placed_event_id);
      window.location.href = `/thank-you?order=${data.order_id}`;
    } catch (err) {
      const msg = errText(err);
      setSubmitError(msg);
      logBlock("submit", "submit_exception", msg);
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
            <img
              src={transformLogoForDisplay(workspace.logo_url, 96)}
              alt={workspace.name}
              className="h-12 w-auto"
            />
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
                  disabled={switchBusy}
                  className="mt-3 inline-flex items-center rounded-full bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
                >
                  {switchBusy ? "Switching…" : "Switch to Subscribe & Save →"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Money-back guarantee strip — mobile (just above the cart) */}
        <div className="mt-5 lg:hidden">
          <GuaranteeBadge subscribing={subscribing} />
        </div>

        {/* Mobile cart summary (collapsible). Hidden on desktop where
            the right sidebar shows the full cart. */}
        <details
          className="mt-3 rounded-2xl border border-zinc-200 bg-white shadow-sm lg:hidden"
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
              showCustomizeButton={workspace.skip_customize}
              recurringCents={recurringCents}
              subscribing={subscribing}
              taxCents={taxCents}
              taxLoading={taxLoading}
            />
          </div>
        </details>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
          {/* ── Left column: forms ──────────────────────────────── */}
          {/* min-w-0 so long content (e.g. subscription item summaries) wraps/
              truncates inside the 1fr track instead of overflowing the page. */}
          <div className="min-w-0 space-y-5">
            {/* Three-way subscription choice card — only when the
                customer is logged in AND has at least one existing
                internal sub AND the cart contains subscribe items. */}
            {authedCustomerId && subscribing && existingSubs.length > 0 && (
              <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">You already have a subscription</p>
                <p className="mt-1 text-sm text-zinc-600">
                  How would you like to handle these items?
                </p>

                <div className="mt-3 space-y-2">
                  <label className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 transition ${subMode === "new_sub" ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"}`}>
                    <input
                      type="radio"
                      name="sub-mode"
                      checked={subMode === "new_sub"}
                      onChange={() => setSubMode("new_sub")}
                      className="mt-0.5 h-4 w-4"
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-semibold text-zinc-900">Create a new subscription</div>
                      <div className="mt-0.5 text-xs text-zinc-500">Keep your current subscription as-is and start a separate one.</div>
                    </div>
                  </label>

                  <label className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 transition ${subMode === "add_to_sub" ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"}`}>
                    <input
                      type="radio"
                      name="sub-mode"
                      checked={subMode === "add_to_sub"}
                      onChange={() => setSubMode("add_to_sub")}
                      className="mt-0.5 h-4 w-4"
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-semibold text-zinc-900">Order now + add to my subscription</div>
                      <div className="mt-0.5 text-xs text-zinc-500">Charge today and include these items on every future renewal.</div>
                    </div>
                  </label>

                  <label className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 transition ${subMode === "renewal_only" ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"}`}>
                    <input
                      type="radio"
                      name="sub-mode"
                      checked={subMode === "renewal_only"}
                      onChange={() => setSubMode("renewal_only")}
                      className="mt-0.5 h-4 w-4"
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-semibold text-zinc-900">Add to my next renewal only</div>
                      <div className="mt-0.5 text-xs text-zinc-500">Ship with your next scheduled order — no charge today.</div>
                    </div>
                  </label>
                </div>

                {(subMode === "add_to_sub" || subMode === "renewal_only") && existingSubs.length > 1 && (
                  <div className="mt-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Which subscription?</p>
                    <div className="space-y-2">
                      {existingSubs.map((s) => (
                        <div
                          key={s.id}
                          className={`rounded-lg border text-sm transition ${chosenSubId === s.id ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"}`}
                        >
                          <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
                            <input
                              type="radio"
                              name="chosen-sub"
                              checked={chosenSubId === s.id}
                              onChange={() => setChosenSubId(s.id)}
                              className="mt-0.5 h-4 w-4 flex-shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              {/* Compact summary; full item list on demand below. */}
                              <div className="truncate font-medium text-zinc-900">{s.items_summary || "Subscription"}</div>
                              <div className="mt-0.5 text-xs text-zinc-500">
                                {frequencyToLabel(s.frequency_days)}
                                {s.next_billing_date && <> · next ships {new Date(s.next_billing_date).toLocaleDateString()}</>}
                              </div>
                            </div>
                          </label>
                          {s.item_lines && s.item_lines.length > 1 && (
                            <div className="px-3 pb-2 pl-10">
                              <button
                                type="button"
                                onClick={() => setExpandedSubId((id) => (id === s.id ? null : s.id))}
                                className="text-xs font-medium text-zinc-600 underline-offset-2 hover:underline"
                              >
                                {expandedSubId === s.id ? "Hide items" : `View all ${s.item_lines.length} items`}
                              </button>
                              {expandedSubId === s.id && (
                                <ul className="mt-1.5 space-y-0.5 text-xs text-zinc-600">
                                  {s.item_lines.map((line, i) => (
                                    <li key={i} className="break-words">• {line}</li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

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
                // Fire OTP eligibility check on blur (not keyup) so
                // we don't spam the server. Only triggers when a
                // returning customer is detected; new emails get a
                // silent no-op.
                onBlur={(e) => {
                  if (authedCustomerId) return;
                  triggerOtpStart(e.target.value);
                }}
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
                // onBlur catches Safari autofill that bypasses onChange,
                // so an autofilled "+18583349198" gets normalized to
                // "(858) 334-9198" the moment focus leaves the field.
                onBlur={(e) => setPhone(formatPhoneDisplay(e.target.value))}
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

              {/* Saved-address picker — shown once authenticated (loaded across
                  linked accounts). Choosing one fills the fields; "Use a new
                  address" reveals the empty form. */}
              {savedAddresses.length > 0 && (
                <div className="mt-3 space-y-2">
                  {savedAddresses.map((a, i) => (
                    <label
                      key={i}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition ${chosenAddrIdx === i ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"}`}
                    >
                      <input
                        type="radio"
                        name="ship-addr"
                        checked={chosenAddrIdx === i}
                        onChange={() => { setChosenAddrIdx(i); applyAddress(a); }}
                        className="mt-0.5 h-4 w-4"
                      />
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="truncate font-medium text-zinc-900">
                          {[a.first_name, a.last_name].filter(Boolean).join(" ") || "Saved address"}
                        </div>
                        <div className="truncate text-xs text-zinc-500">
                          {a.address1}{a.address2 ? `, ${a.address2}` : ""} · {a.city}, {a.province_code} {a.zip}
                        </div>
                      </div>
                    </label>
                  ))}
                  <label
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium transition ${chosenAddrIdx === null ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"}`}
                  >
                    <input
                      type="radio"
                      name="ship-addr"
                      checked={chosenAddrIdx === null}
                      onChange={() => { setChosenAddrIdx(null); setAddress1(""); setAddress2(""); setCity(""); setState(""); setZip(""); }}
                      className="h-4 w-4"
                    />
                    <span className="text-zinc-900">Use a new address</span>
                  </label>
                </div>
              )}

              {(savedAddresses.length === 0 || chosenAddrIdx === null) && (
              <>
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
              </>
              )}

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

              {/* Saved-cards picker (only when authenticated). Each
                  radio is a vault token; selecting one skips the
                  Hosted Fields tokenize at submit time. */}
              {savedMethods.length > 0 && (
                <div className="mt-3 space-y-2">
                  {savedMethods.map((m) => {
                    const checked = selectedSavedToken === m.token;
                    return (
                      <label
                        key={m.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 transition ${checked ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"}`}
                      >
                        <input
                          type="radio"
                          name="saved-card"
                          checked={checked}
                          onChange={() => setSelectedSavedToken(m.token)}
                          className="h-4 w-4"
                        />
                        <div className="flex-1 text-sm">
                          <div className="font-medium text-zinc-900">
                            {m.payment_type === "paypal_account"
                              ? <>PayPal{m.paypal_email ? ` · ${m.paypal_email}` : ""}</>
                              : <>{m.brand || "Card"} •••• {m.last4}</>}
                            {m.is_default && <span className="ml-2 rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-700">Default</span>}
                          </div>
                          {m.payment_type !== "paypal_account" && m.exp_month && m.exp_year && (
                            <div className="text-xs text-zinc-500">
                              Expires {String(m.exp_month).padStart(2, "0")}/{String(m.exp_year).slice(-2)}
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                  <label
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 transition ${selectedSavedToken === null && newMethodType === "card" ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"}`}
                  >
                    <input
                      type="radio"
                      name="saved-card"
                      checked={selectedSavedToken === null && newMethodType === "card"}
                      onChange={() => { setSelectedSavedToken(null); setNewMethodType("card"); }}
                      className="h-4 w-4"
                    />
                    <div className="text-sm font-medium text-zinc-900">Use a new card</div>
                  </label>
                  <label
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 transition ${selectedSavedToken === null && newMethodType === "paypal" ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-300"}`}
                  >
                    <input
                      type="radio"
                      name="saved-card"
                      checked={selectedSavedToken === null && newMethodType === "paypal"}
                      onChange={() => { setSelectedSavedToken(null); setNewMethodType("paypal"); }}
                      className="h-4 w-4"
                    />
                    <div className="text-sm font-medium text-zinc-900">Pay with PayPal</div>
                  </label>
                </div>
              )}

              {/* Card / PayPal tabs when there are no saved methods (with saved
                  methods the radios above already carry the choice). */}
              {selectedSavedToken === null && savedMethods.length === 0 && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {(["card", "paypal"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setNewMethodType(t)}
                      className={`rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${newMethodType === t ? "border-zinc-900 bg-zinc-50 text-zinc-900" : "border-zinc-200 text-zinc-600 hover:border-zinc-300"}`}
                    >
                      {t === "card" ? "Card" : "PayPal"}
                    </button>
                  ))}
                </div>
              )}

              {/* New-card Hosted Fields — kept mounted (iframes are expensive to
                  recreate); hidden for a saved method or when PayPal is chosen. */}
              <div className={selectedSavedToken || newMethodType === "paypal" ? "hidden" : "block"}>
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
              </div>

              {/* PayPal — its own button (the main Pay button is hidden for it).
                  Validates the form before opening the PayPal popup, then runs
                  the same submit with the PayPal nonce. */}
              {selectedSavedToken === null && newMethodType === "paypal" && (
                clientToken ? (
                  <PayPalButton
                    clientToken={clientToken}
                    validate={() => {
                      const v = isFormValid();
                      if (!v.ok) { setSubmitError(v.reason); logBlock("validation", "invalid_form_paypal", v.reason); }
                      else setSubmitError(null);
                      return v.ok;
                    }}
                    onApprove={(nonce) => { void onSubmit(nonce); }}
                    onError={(msg) => { setSubmitError(`PayPal: ${msg}`); logBlock("submit", "paypal_error", msg); }}
                  />
                ) : (
                  <p className="mt-3 text-xs text-zinc-500">Loading secure payment…</p>
                )
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

            {/* Subscription renewal reassurance — moved to the bottom so it's
                the last card (below the order details), not the first thing
                the customer sees. */}
            {subscribing && recurringCents > 0 && cart.subscription_frequency_days && (
              <div className="flex items-start gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
                <svg className="h-5 w-5 flex-shrink-0 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                <div className="text-sm text-zinc-700">
                  This order has items that will renew{" "}
                  <span className="font-semibold">{frequencyToLabel(cart.subscription_frequency_days)}</span>
                  {" "}for{" "}
                  <span className="font-semibold">{fmt(recurringCents)}</span>.
                  {" "}You can cancel or change frequency anytime in your account.
                </div>
              </div>
            )}
          </div>

          {/* ── Right sidebar: cart + reviews ────────────────────── */}
          <aside className="hidden lg:block">
            <div className="sticky top-6 space-y-4">
              <GuaranteeBadge subscribing={subscribing} />
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
              showCustomizeButton={workspace.skip_customize}
              recurringCents={recurringCents}
              subscribing={subscribing}
              taxCents={taxCents}
              taxLoading={taxLoading}
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

      {/* Sticky bottom CTA — mobile + desktop both. */}
      <section className="fixed inset-x-0 bottom-0 z-10 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto max-w-6xl">
          {/* Terms checkbox — pre-checked, blocks submit when off.
              Left-aligned on mobile (matches the price block below);
              still anchored left at all sizes for consistency. */}
          <label className="mb-2 flex items-center gap-1.5 text-xs text-zinc-600">
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
            {selectedSavedToken === null && newMethodType === "paypal" ? (
              <span className="max-w-[180px] text-right text-xs font-medium text-zinc-500">
                Complete your order with the PayPal button above ↑
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSubmit()}
                disabled={submitting || (!selectedSavedToken && !cardReady) || !agreeToTerms}
                style={{ backgroundColor: workspace.primary_color }}
                className="rounded-full px-7 py-3 text-sm font-extrabold uppercase tracking-wider text-white shadow-md disabled:opacity-50"
              >
                {submitting ? "Processing…" : "Complete order"}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* OTP Modal — Shop Pay-style returning-customer login */}
      {otp.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/60 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-zinc-900">Welcome back</h2>
                <p className="mt-1 text-sm text-zinc-600">
                  {otp.statusMsg
                    ? otp.statusMsg
                    : otp.channel === "sms"
                      ? <>We texted a 6-digit code to your phone{" "}<span className="font-semibold">{otp.maskedDestination}</span>.</>
                      : <>We emailed a 6-digit code to{" "}<span className="font-semibold">{otp.maskedDestination}</span>.</>}
                </p>
                {!otp.statusMsg && otp.fellBack && (
                  <p className="mt-1 text-xs text-zinc-500">
                    We couldn&apos;t reach your phone, so we sent it to your email instead.
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={dismissOtpAsGuest}
                aria-label="Close"
                className="text-zinc-400 hover:text-zinc-600"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp.code}
              onChange={(e) => setOtp((s) => ({ ...s, code: e.target.value.replace(/\D/g, "").slice(0, 6), error: null }))}
              onKeyDown={(e) => { if (e.key === "Enter" && otp.code.length >= 4) submitCode(); }}
              placeholder="••••••"
              className="mt-5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-3 text-center text-2xl font-mono tracking-[0.6em] text-zinc-900 placeholder-zinc-300 focus:border-zinc-500 focus:outline-none"
            />

            {otp.error && (
              <p className="mt-2 text-sm text-rose-600">{otp.error}</p>
            )}

            <button
              type="button"
              onClick={submitCode}
              disabled={otp.busy || otp.code.length < 4}
              style={{ backgroundColor: workspace.primary_color }}
              className="mt-4 w-full rounded-full px-4 py-3 text-sm font-extrabold uppercase tracking-wider text-white shadow-md disabled:opacity-50"
            >
              {otp.busy ? "Verifying…" : "Verify & log in"}
            </button>

            {/* Escape hatch: didn't get the code? Check out as a guest. Keeps
                everything they typed, stays unauthenticated (no saved cards /
                addresses / subs), and won't re-prompt. */}
            <button
              type="button"
              onClick={dismissOtpAsGuest}
              className="mt-3 w-full rounded-full border border-zinc-300 px-4 py-2.5 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
            >
              Didn&apos;t get a code? Continue as guest
            </button>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs">
              <button
                type="button"
                disabled={otp.busy || otp.resendCountdown > 0}
                onClick={() => resendCode()}
                className="text-zinc-600 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                {otp.resendCountdown > 0 ? `Resend in ${otp.resendCountdown}s` : "Resend code"}
              </button>
              {otp.channel === "sms" && otp.hasEmail && (
                <>
                  <span className="text-zinc-300">·</span>
                  <button
                    type="button"
                    disabled={otp.busy}
                    onClick={() => resendCode({ channel: "email" })}
                    className="text-zinc-600 underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    Email me a code instead
                  </button>
                </>
              )}
              {otp.channel === "email" && otp.hasSms && (
                <>
                  <span className="text-zinc-300">·</span>
                  <button
                    type="button"
                    disabled={otp.busy}
                    onClick={() => resendCode({ channel: "sms" })}
                    className="text-zinc-600 underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    Text me a code instead
                  </button>
                </>
              )}
              <span className="text-zinc-300">·</span>
              <button
                type="button"
                onClick={startOver}
                className="text-zinc-600 underline-offset-2 hover:underline"
              >
                Not me / start over
              </button>
            </div>
          </div>
        </div>
      )}
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
  showCustomizeButton,
  recurringCents,
  subscribing,
  taxCents,
  taxLoading,
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
  showCustomizeButton?: boolean;
  recurringCents: number;
  subscribing: boolean;
  taxCents: number;
  taxLoading: boolean;
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
      {showCustomizeButton ? (
        // Bypass funnel: customize was skipped, so make the editor an obvious
        // button under the items (not just a subtle "Make changes" link).
        <a
          href={backLink}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-zinc-50"
        >
          Customize your order
        </a>
      ) : (
        <div className="mt-3 text-right text-xs">
          <a href={backLink} className="text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline">
            Make changes
          </a>
        </div>
      )}
      <dl className="mt-3 space-y-1 border-t border-zinc-200 pt-3 text-sm">
        <Row label="Subtotal" value={fmt(subtotalCents)} />
        {msrpSubtotalCents > subtotalCents && (
          <Row label="Discount" value={`-${fmt(msrpSubtotalCents - subtotalCents)}`} muted />
        )}
        {cart.discount_cents > 0 && (
          <div className="flex items-baseline justify-between">
            <dt className="text-sm font-medium text-emerald-700">Coupon{cart.discount_code ? ` (${cart.discount_code})` : ""}</dt>
            <dd className="text-sm font-semibold text-emerald-700">-{fmt(cart.discount_cents)}</dd>
          </div>
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
        <Row
          label="Sales tax"
          value={taxLoading ? "Calculating…" : taxCents > 0 ? fmt(taxCents) : "—"}
          muted={taxCents === 0}
        />
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

// ─────────────────────────────────────────────────────────────────
// Money-back guarantee strip — bold, can't-miss color pop. Renders
// above each cart card (desktop sidebar + mobile collapsible). Uses
// a gradient + check icon + concise copy. Adds "cancel anytime" when
// the cart has subscribing lines.
// ─────────────────────────────────────────────────────────────────
function GuaranteeBadge({ subscribing }: { subscribing: boolean }) {
  return (
    <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-600 px-4 py-3 text-white shadow-md">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/30">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-extrabold uppercase tracking-wider">
            30-day money-back guarantee
          </div>
          <div className="mt-0.5 text-xs text-white/90">
            Not happy? Get a full refund — no questions asked{subscribing ? " · cancel anytime" : ""}.
          </div>
        </div>
      </div>
    </div>
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

function frequencyToLabel(days: number): string {
  if (!days || days <= 0) return "";
  if (days === 7) return "weekly";
  if (days === 14) return "every 2 weeks";
  if (days === 21) return "every 3 weeks";
  if (days === 365) return "yearly";
  // Week multiples: a 4-week multiple reads as months (28→monthly,
  // 56→every 2 months, 84→every 3 months — Appstle's 4-week cadences).
  if (days % 7 === 0) {
    const weeks = days / 7;
    if (weeks % 4 === 0) {
      const months = weeks / 4;
      return months === 1 ? "monthly" : `every ${months} months`;
    }
    return `every ${weeks} weeks`;
  }
  // Calendar-month multiples (30/60/90/…).
  if (days % 30 === 0) {
    const months = days / 30;
    return months === 1 ? "monthly" : months === 12 ? "yearly" : `every ${months} months`;
  }
  return `every ${days} days`;
}

/**
 * Rewrite Supabase Storage logo URLs to the render endpoint for
 * server-side resize + WebP→PNG conversion. Resize=contain preserves
 * aspect ratio (without it Supabase center-crops). Falls through
 * unchanged for non-Supabase URLs.
 */
function transformLogoForDisplay(url: string, heightPx: number): string {
  if (!url.includes("supabase.co/storage/v1/object/public/")) return url;
  const base = url.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/");
  const sep = base.includes("?") ? "&" : "?";
  // 2x the display height for retina sharpness.
  return `${base}${sep}height=${heightPx * 2}&resize=contain`;
}

/**
 * Format a phone string for display as "(858) 334-9198" regardless of
 * what the customer (or their browser autofill) shoves in.
 *
 * Handles three input shapes:
 *   - typed digits: "8583349198" → "(858) 334-9198"
 *   - autofilled E.164: "+18583349198" → "(858) 334-9198"
 *   - 11-digit with leading "1": "18583349198" → "(858) 334-9198"
 *
 * Customers should never see the +1; we E.164-ize silently at submit
 * time. Anything beyond 10 significant digits gets truncated.
 */
function formatPhoneDisplay(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  // Strip US country code if present so the formatter always works
  // on the 10-digit national number. Avoids the autofill bug where
  // "+18583349198" → 11 digits → slice(0,10) drops the trailing 8.
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  } else if (digits.length > 10) {
    // Anything longer (unexpected): keep the last 10 digits, which
    // matches "human reading right-to-left" intuition.
    digits = digits.slice(-10);
  }
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
  const d = raw.replace(/\D/g, "");
  // Accept either 10 digits (national) or 11 starting with 1 (US E.164).
  return d.length === 10 || (d.length === 11 && d.startsWith("1"));
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
