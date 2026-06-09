"use client";

/**
 * Payment Methods section — saved cards + add a new card (Braintree Hosted
 * Fields). The list spans linked customer profiles so a shared wallet shows as
 * one. Adding a card vaults it in Braintree, makes it the default, and sweeps the
 * customer's Appstle subs (active / paused / cancelled) onto our internal billing
 * via updatePaymentMethod → migrateCustomerAppstleSubsToInternal.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { HostedFieldsCard, type HostedFieldsCardHandle } from "@/app/(storefront)/checkout/_components/HostedFieldsCard";

interface PortalPaymentMethod {
  id: string;
  brand: string | null;
  last4: string | null;
  expiration_month: string | null;
  expiration_year: string | null;
  payment_type: string;
  is_default: boolean;
  provider: string;
  status: string;
}

interface PortalPaymentMethodsResponse {
  ok: boolean;
  methods: PortalPaymentMethod[];
  migrationEnabled: boolean;
}

interface Props {
  primaryColor: string;
}

export function PaymentMethodsSection({ primaryColor }: Props) {
  const [methods, setMethods] = useState<PortalPaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-card flow
  const [adding, setAdding] = useState(false);
  const [clientToken, setClientToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // When set, the add-card flow was deep-linked from a subscription: the new card
  // is pinned to THIS sub (not made default), then we return to it.
  const [forSub, setForSub] = useState<string | null>(null);
  const hfRef = useRef<HostedFieldsCardHandle>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/portal?route=paymentMethods", { credentials: "same-origin" });
      if (!res.ok) throw new Error("Could not load payment methods");
      const data = (await res.json()) as PortalPaymentMethodsResponse;
      setMethods(data.methods || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Deep link from a sub's "+ Add a new card": auto-open the form and remember to
  // pin the card to that sub afterward instead of making it the default.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("add") === "1") {
      setForSub(params.get("forSub"));
      startAdd();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startAdd() {
    setAdding(true);
    setTokenError(null);
    setClientToken(null);
    try {
      const res = await fetch("/api/portal?route=braintreeClientToken", { credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.client_token) { setTokenError(data?.message || data?.error || "Couldn't start card entry."); return; }
      setClientToken(data.client_token);
    } catch { setTokenError("Couldn't start card entry."); }
  }

  async function saveCard() {
    if (!hfRef.current || saving) return;
    setSaving(true);
    setToast(null);
    try {
      const { nonce, deviceData } = await hfRef.current.tokenize();
      const res = await fetch("/api/portal?route=updatePaymentMethod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        // For a sub-scoped add: just vault (don't make default, don't migrate the
        // book) — we pin it to that one sub next.
        body: JSON.stringify({ paymentMethodNonce: nonce, deviceData, ...(forSub ? { makeDefault: false, migrate: false } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) { setTokenError(data?.message || data?.error || "Couldn't save the card."); return; }

      if (forSub && data.payment_method_id) {
        // Pin the new card to the originating subscription, then return to it.
        await fetch("/api/portal?route=setSubscriptionPaymentMethod", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ contractId: forSub, paymentMethodId: data.payment_method_id }),
        });
        window.location.href = `/subscriptions/${forSub}`;
        return;
      }

      const migrated = Number(data?.migrated_count || 0);
      setToast(migrated > 0
        ? `Card saved and set as default — and ${migrated} subscription${migrated === 1 ? "" : "s"} moved to it.`
        : "Card saved and set as your default.");
      setAdding(false);
      setClientToken(null);
      await load();
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : "Couldn't save the card.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">Loading payment methods…</div>;
  }
  if (error) {
    return <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">{error}</div>;
  }

  return (
    <div className="space-y-4">
      {toast && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">{toast}</div>
      )}

      {methods.length === 0 && !adding ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-zinc-700">No saved payment methods.</p>
          <p className="mt-1 text-xs text-zinc-500">Add a card to manage and pay for your subscriptions here.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {methods.map((m) => (
            <li key={m.id} className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-4">
                <CardLogo brand={m.brand} />
                <div>
                  <div className="text-sm font-semibold text-zinc-900">
                    {m.brand || "Card"} ending in {m.last4 || "••••"}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {m.expiration_month && m.expiration_year ? `Expires ${m.expiration_month}/${m.expiration_year.slice(-2)}` : ""}
                  </div>
                </div>
              </div>
              {m.is_default && (
                <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-white" style={{ background: primaryColor }}>
                  Default
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Add a card */}
      {adding ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-zinc-900">Add a payment method</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            {forSub
              ? "This card will be applied to just this subscription."
              : "Your new card becomes your default and is used for all your subscriptions."}
          </p>
          {tokenError && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{tokenError}</p>}
          <div className="mt-4">
            {clientToken ? (
              <HostedFieldsCard
                ref={hfRef}
                clientToken={clientToken}
                primaryColor={primaryColor}
                cardholderName=""
                onError={(msg) => setTokenError(msg)}
              />
            ) : !tokenError ? (
              <p className="text-sm text-zinc-500">Loading secure card entry…</p>
            ) : null}
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={saving || !clientToken}
              onClick={saveCard}
              className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
              style={{ background: primaryColor }}
            >
              {saving ? "Saving…" : "Save card"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => { setAdding(false); setClientToken(null); setTokenError(null); }}
              className="rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 hover:border-zinc-400 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={startAdd}
          className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
        >
          + Add a payment method
        </button>
      )}
    </div>
  );
}

function CardLogo({ brand }: { brand: string | null }) {
  const b = (brand || "").toLowerCase();
  const tone =
    b.includes("visa") ? "bg-blue-100 text-blue-800"
      : b.includes("master") ? "bg-orange-100 text-orange-800"
        : b.includes("amex") || b.includes("american") ? "bg-sky-100 text-sky-800"
          : b.includes("discover") ? "bg-amber-100 text-amber-800"
            : "bg-zinc-100 text-zinc-700";
  const label = brand || "Card";
  return (
    <span className={`inline-flex h-10 w-14 items-center justify-center rounded-md text-[11px] font-bold uppercase tracking-wider ${tone}`}>
      {label.slice(0, 4)}
    </span>
  );
}
