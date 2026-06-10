"use client";

/**
 * Account section — edit name / email / phone.
 *
 * POSTs to /api/portal?route=updateAccount, which wraps the
 * update_customer_info direct action. Same validation, Shopify
 * customerUpdate sync, and DB write path as a ticket-driven update.
 */
import { useState } from "react";

interface Props {
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  linkedAccounts: Array<{ id: string; name: string; email: string; isPrimary: boolean }>;
  primaryColor: string;
}

export function AccountSection({ customer, linkedAccounts, primaryColor }: Props) {
  const [firstName, setFirstName] = useState(customer.firstName);
  const [lastName, setLastName] = useState(customer.lastName);
  const [phone, setPhone] = useState(formatPhoneDisplay(customer.phone));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const isDirty =
    firstName !== customer.firstName ||
    lastName !== customer.lastName ||
    formatPhoneDisplay(customer.phone) !== phone;

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const body: Record<string, string> = {};
      if (firstName !== customer.firstName) body.first_name = firstName;
      if (lastName !== customer.lastName) body.last_name = lastName;
      // Email is intentionally NOT editable here — changing it risks identity
      // collisions + lockout (no verification). Customers change it via support.
      if (formatPhoneDisplay(customer.phone) !== phone) body.phone_number = phone;
      const res = await fetch("/api/portal?route=updateAccount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        setMessage({ kind: "err", text: data?.message || data?.error || "Could not save" });
      } else {
        setMessage({ kind: "ok", text: "Saved." });
      }
    } catch {
      setMessage({ kind: "err", text: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" value={firstName} onChange={setFirstName} autoComplete="given-name" />
          <Field label="Last name" value={lastName} onChange={setLastName} autoComplete="family-name" />
          {/* Email is read-only — changing it risks identity collisions +
              lockout. Customers update it through support. */}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Email</span>
            <div className="flex w-full items-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-500">
              {customer.email || "—"}
            </div>
            <span className="mt-1 block text-xs text-zinc-400">Contact support to change your email.</span>
          </label>
          <Field
            label="Phone"
            value={phone}
            onChange={(v) => setPhone(formatPhoneDisplay(v))}
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
          />
        </div>
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            disabled={!isDirty || saving}
            onClick={save}
            className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
            style={{ backgroundColor: primaryColor }}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {message && (
            <span className={`text-sm ${message.kind === "ok" ? "text-emerald-600" : "text-rose-600"}`}>
              {message.text}
            </span>
          )}
        </div>
      </div>

      {/* Linked accounts — other profiles in this customer's link group. */}
      {linkedAccounts.length > 0 && (
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6">
          <h3 className="text-sm font-semibold text-zinc-900">Linked accounts</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            These profiles share your subscriptions, orders, and rewards.
          </p>
          <ul className="mt-3 divide-y divide-zinc-100">
            {linkedAccounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-2.5">
                <div>
                  <div className="text-sm font-medium text-zinc-900">{a.name}</div>
                  <div className="text-xs text-zinc-500">{a.email || "—"}</div>
                </div>
                {a.isPrimary && (
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">Primary</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  inputMode,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  inputMode?: "text" | "numeric" | "email";
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-500">{label}</span>
      <input
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
      />
    </label>
  );
}

function formatPhoneDisplay(raw: string): string {
  let d = (raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  else if (d.length > 10) d = d.slice(-10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
