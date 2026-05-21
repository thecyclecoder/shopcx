"use client";

/**
 * Payment Methods section — read-only list of the customer's saved
 * cards. The list spans linked customer profiles so a shared wallet
 * shows up as one. Each row shows brand, last4, expiration, and the
 * default badge.
 *
 * v1 is read-only on purpose. Vault-a-new-card needs Braintree
 * Hosted Fields on the client + a /api/portal mutation that gates on
 * the workspace's portal_migration_enabled flag (then carries every
 * active Appstle subscription onto our internal billing scheduler).
 * Until that ships, the "Add new card" CTA is rendered as a disabled
 * "Coming soon" affordance so customers see the surface but can't
 * trigger it.
 */

import { useEffect, useState } from "react";

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
  const [migrationEnabled, setMigrationEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/portal?route=paymentMethods", { credentials: "same-origin" });
        if (!res.ok) throw new Error("Could not load payment methods");
        const data = await res.json() as PortalPaymentMethodsResponse;
        if (!alive) return;
        setMethods(data.methods || []);
        setMigrationEnabled(!!data.migrationEnabled);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (loading) {
    return <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">Loading payment methods…</div>;
  }
  if (error) {
    return <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">{error}</div>;
  }

  return (
    <div className="space-y-4">
      {methods.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-zinc-700">No saved payment methods.</p>
          <p className="mt-1 text-xs text-zinc-500">
            Your active subscriptions still bill through the card you used at checkout.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {methods.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-center gap-4">
                <CardLogo brand={m.brand} />
                <div>
                  <div className="text-sm font-semibold text-zinc-900">
                    {m.brand || "Card"} ending in {m.last4 || "••••"}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {m.expiration_month && m.expiration_year
                      ? `Expires ${m.expiration_month}/${m.expiration_year.slice(-2)}`
                      : ""}
                  </div>
                </div>
              </div>
              {m.is_default && (
                <span
                  className="rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-white"
                  style={{ background: primaryColor }}
                >
                  Default
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
        <button
          type="button"
          disabled
          title="Coming soon — we're upgrading the billing system to support self-service card updates."
          className="w-full cursor-not-allowed rounded-lg border border-dashed border-zinc-300 bg-white px-4 py-3 text-sm font-medium text-zinc-400"
        >
          + Add a new payment method (coming soon)
        </button>
        <p className="mt-2 text-xs text-zinc-500">
          {migrationEnabled
            ? "We'll have self-service card management here shortly."
            : "Need to update your card today? Reply to your latest order email and our team will help right away."}
        </p>
      </div>
    </div>
  );
}

function CardLogo({ brand }: { brand: string | null }) {
  const b = (brand || "").toLowerCase();
  const tone =
    b.includes("visa")
      ? "bg-blue-100 text-blue-800"
      : b.includes("master")
        ? "bg-orange-100 text-orange-800"
        : b.includes("amex") || b.includes("american")
          ? "bg-sky-100 text-sky-800"
          : b.includes("discover")
            ? "bg-amber-100 text-amber-800"
            : "bg-zinc-100 text-zinc-700";
  const label = brand || "Card";
  return (
    <span className={`inline-flex h-10 w-14 items-center justify-center rounded-md text-[11px] font-bold uppercase tracking-wider ${tone}`}>
      {label.slice(0, 4)}
    </span>
  );
}
