"use client";

/**
 * Client island for the customize page. Handles:
 *   - Funnel events: customize_view on mount, upsell_added /
 *     upsell_skipped per offered candidate.
 *   - "Add this" buttons on each upsell card — POSTs to /api/cart to
 *     mutate the draft, then re-renders with the updated cart.
 *   - "Continue to checkout" CTA. Stub redirect until our /checkout
 *     page exists: builds a Shopify cart permalink from the cart's
 *     line items.
 */

import { useEffect, useState } from "react";
import { initPixel, track } from "@/lib/storefront-pixel";

export interface CartDraft {
  id: string;
  workspace_id: string;
  token: string;
  anonymous_id: string | null;
  customer_id: string | null;
  line_items: StoredLineItem[];
  subscription_frequency_days: number | null;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  status: string;
  email: string | null;
  phone: string | null;
  expires_at: string;
}

export interface StoredLineItem {
  variant_id: string;
  product_id: string;
  shopify_variant_id: string | null;
  title: string;
  variant_title: string | null;
  image_url: string | null;
  quantity: number;
  unit_price_cents: number;
  unit_msrp_cents: number;
  line_total_cents: number;
  mode: "subscribe" | "onetime";
  frequency_days: number | null;
}

export interface UpsellCandidate {
  product_id: string;
  handle: string;
  title: string;
  image_url: string | null;
  variant_id: string | null;
  shopify_variant_id: string | null;
  variant_title: string | null;
  price_cents: number;
}

interface Workspace {
  id: string;
  name: string;
  logo_url: string | null;
  primary_color: string;
  shopify_domain: string | null;
}

export function CustomizeClient({
  cart: initialCart,
  upsells,
  workspace,
}: {
  cart: CartDraft;
  upsells: UpsellCandidate[];
  workspace: Workspace;
}) {
  const [cart, setCart] = useState(initialCart);
  const [addedUpsells, setAddedUpsells] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [continueBusy, setContinueBusy] = useState(false);

  // ── Pixel: initialize + fire customize_view once ─────────────────
  useEffect(() => {
    initPixel({
      workspaceId: workspace.id,
      customerId: cart.customer_id,
    });
    track("customize_view", {
      cart_token: cart.token,
      line_item_count: cart.line_items.length,
      total_cents: cart.total_cents,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribeMode = cart.line_items.some((l) => l.mode === "subscribe");

  async function addUpsell(u: UpsellCandidate) {
    if (!u.variant_id) return;
    setBusyId(u.product_id);
    try {
      // Mirror the cart's existing subscription cadence — adding an
      // upsell to a subscribe cart subscribes it; adding to a one-time
      // cart adds it one-time.
      const nextLines = [
        ...cart.line_items.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity })),
        { variant_id: u.variant_id, quantity: 1 },
      ];
      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          workspace_id: workspace.id,
          anonymous_id: cart.anonymous_id,
          line_items: nextLines,
          mode: subscribeMode ? "subscribe" : "onetime",
          frequency_days: cart.subscription_frequency_days,
          email: cart.email,
          phone: cart.phone,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { cart: CartDraft };
        setCart(json.cart);
        setAddedUpsells((prev) => new Set(prev).add(u.product_id));
        track("upsell_added", {
          product_id: u.product_id,
          variant_id: u.variant_id,
          cart_token: cart.token,
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  function skipUpsell(u: UpsellCandidate) {
    setAddedUpsells((prev) => {
      const next = new Set(prev);
      next.add(u.product_id);
      return next;
    });
    track("upsell_skipped", {
      product_id: u.product_id,
      cart_token: cart.token,
    });
  }

  async function onContinue() {
    setContinueBusy(true);
    track("checkout_redirect", {
      cart_token: cart.token,
      total_cents: cart.total_cents,
      line_item_count: cart.line_items.length,
    });
    // STUB: redirect to a Shopify cart permalink with our line items.
    // Will be replaced with `/checkout?token=...` once the Braintree
    // checkout ships.
    const shopifyDomain = workspace.shopify_domain;
    if (shopifyDomain) {
      const cartParts = cart.line_items
        .filter((l) => l.shopify_variant_id)
        .map((l) => `${l.shopify_variant_id}:${l.quantity}`);
      if (cartParts.length > 0) {
        const url = `https://${shopifyDomain}/cart/${cartParts.join(",")}`;
        window.location.href = url;
        return;
      }
    }
    // No Shopify domain configured — bail to the store root.
    window.location.href = "/";
  }

  const visibleUpsells = upsells.filter((u) => !addedUpsells.has(u.product_id));

  const themeStyle = {
    "--storefront-primary": workspace.primary_color,
  } as React.CSSProperties;

  return (
    <div style={themeStyle} className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      <header className="mb-6 flex items-center justify-between">
        {workspace.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={workspace.logo_url} alt={workspace.name} className="h-8" />
        ) : (
          <span className="text-lg font-semibold">{workspace.name}</span>
        )}
        <a href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← Keep shopping
        </a>
      </header>

      <h1 className="text-2xl font-bold text-zinc-900 sm:text-3xl">Your order</h1>
      <p className="mt-1 text-sm text-zinc-600">
        Review your selection below. Add anything else you&apos;d like before checking out.
      </p>

      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
          In your cart
        </h2>
        <ul className="mt-3 space-y-3">
          {cart.line_items.map((l, i) => (
            <li
              key={`${l.variant_id}-${i}`}
              className="flex items-center gap-3 rounded-xl bg-zinc-50 p-3"
            >
              {l.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={l.image_url}
                  alt={l.title}
                  className="h-14 w-14 flex-shrink-0 rounded-lg object-cover"
                />
              ) : (
                <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-zinc-200" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-zinc-900">
                  {l.title}
                  {l.variant_title && l.variant_title !== "Default Title" && (
                    <span className="ml-1 text-zinc-500">— {l.variant_title}</span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">
                  Qty {l.quantity}
                  {l.mode === "subscribe" && (
                    <span className="ml-1">
                      · Delivers every{" "}
                      {l.frequency_days ? `${l.frequency_days}d` : "regular cadence"}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-zinc-900">
                  ${(l.line_total_cents / 100).toFixed(2)}
                </div>
                {l.unit_msrp_cents > l.unit_price_cents && (
                  <div className="text-xs text-zinc-400 line-through">
                    ${((l.unit_msrp_cents * l.quantity) / 100).toFixed(2)}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>

        <dl className="mt-4 space-y-1.5 border-t border-zinc-200 pt-4 text-sm">
          <Row label="Subtotal" value={fmt(cart.subtotal_cents)} />
          {cart.discount_cents > 0 && (
            <Row label="Discount" value={`-${fmt(cart.discount_cents)}`} muted />
          )}
          <Row
            label="Total"
            value={fmt(cart.total_cents)}
            emphasis
          />
          <p className="pt-1 text-xs text-zinc-500">
            Shipping &amp; tax calculated at checkout.
          </p>
        </dl>
      </section>

      {visibleUpsells.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Add to your order
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-3">
            {visibleUpsells.map((u) => (
              <li
                key={u.product_id}
                className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm"
              >
                {u.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={u.image_url}
                    alt={u.title}
                    className="mb-3 h-24 w-full rounded-xl object-cover"
                  />
                ) : (
                  <div className="mb-3 h-24 w-full rounded-xl bg-zinc-100" />
                )}
                <div className="flex-1">
                  <div className="text-sm font-semibold text-zinc-900">{u.title}</div>
                  <div className="text-xs text-zinc-500">{fmt(u.price_cents)}</div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => addUpsell(u)}
                    disabled={!u.variant_id || busyId === u.product_id}
                    style={{ backgroundColor: workspace.primary_color }}
                    className="flex-1 rounded-full px-3 py-2 text-xs font-bold uppercase tracking-wide text-white disabled:opacity-50"
                  >
                    {busyId === u.product_id ? "Adding…" : "Add"}
                  </button>
                  <button
                    type="button"
                    onClick={() => skipUpsell(u)}
                    className="rounded-full border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
                  >
                    No thanks
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="sticky bottom-0 mt-8 -mx-4 border-t border-zinc-200 bg-white/95 px-4 py-4 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-zinc-500">Total</div>
            <div className="text-2xl font-bold text-zinc-900">{fmt(cart.total_cents)}</div>
          </div>
          <button
            type="button"
            onClick={onContinue}
            disabled={continueBusy || cart.line_items.length === 0}
            style={{ backgroundColor: workspace.primary_color }}
            className="rounded-full px-8 py-3 text-sm font-extrabold uppercase tracking-wider text-white shadow-lg disabled:opacity-50"
          >
            {continueBusy ? "One moment…" : "Continue to checkout →"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  emphasis,
  muted,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className={`${muted ? "text-zinc-500" : "text-zinc-700"} text-sm`}>{label}</dt>
      <dd
        className={
          emphasis ? "text-base font-bold text-zinc-900" : muted ? "text-zinc-500" : "text-zinc-700"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
