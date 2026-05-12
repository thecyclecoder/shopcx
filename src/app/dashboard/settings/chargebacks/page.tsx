"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

const ALL_REASONS = [
  { value: "fraudulent", label: "Fraudulent", default: true },
  { value: "unrecognized", label: "Unrecognized", default: true },
  { value: "subscription_cancelled", label: "Subscription Cancelled", default: false },
  { value: "product_not_received", label: "Product Not Received", default: false },
  { value: "product_unacceptable", label: "Product Unacceptable", default: false },
  { value: "duplicate", label: "Duplicate", default: false },
  { value: "credit_not_processed", label: "Credit Not Processed", default: false },
];

interface ChargebackSettings {
  chargeback_auto_cancel: boolean;
  chargeback_notify: boolean;
  chargeback_auto_ticket: boolean;
  chargeback_evidence_reminder: boolean;
  chargeback_evidence_reminder_days: number;
  chargeback_auto_cancel_reasons: string[];
}

export default function ChargebackSettingsPage() {
  const workspace = useWorkspace();
  const [settings, setSettings] = useState<ChargebackSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/chargebacks/settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const save = async (updates: Partial<ChargebackSettings>) => {
    setSaving(true);
    setSaved(false);
    const merged = { ...settings, ...updates };
    setSettings(merged as ChargebackSettings);

    await fetch("/api/chargebacks/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const toggleReason = (reason: string) => {
    if (!settings) return;
    const current = settings.chargeback_auto_cancel_reasons || [];
    const updated = current.includes(reason)
      ? current.filter((r) => r !== reason)
      : [...current, reason];
    save({ chargeback_auto_cancel_reasons: updated });
  };

  const canEdit = ["owner", "admin"].includes(workspace.role);

  if (loading) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6 overflow-x-hidden">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6 overflow-x-hidden">
        <p className="text-sm text-red-500">Failed to load chargeback settings.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-screen-2xl space-y-8 px-4 py-6 sm:px-6 overflow-x-hidden">
      <div>
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Chargeback Automation</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Configure how chargebacks are handled automatically. Requires Shopify Payments.
        </p>
      </div>

      {saved && (
        <div className="rounded-md bg-green-50 px-4 py-2 text-sm text-green-700 dark:bg-green-900/20 dark:text-green-400">
          Settings saved.
        </div>
      )}

      {/* Toggle: Auto-cancel subscriptions */}
      <SettingRow
        label="Auto-cancel subscriptions on chargeback"
        description="When enabled, active subscriptions are cancelled immediately via Appstle when a chargeback is received for a configured reason."
        disabled={!canEdit}
      >
        <Toggle
          checked={settings.chargeback_auto_cancel}
          onChange={(v) => save({ chargeback_auto_cancel: v })}
          disabled={!canEdit || saving}
        />
      </SettingRow>

      {/* Toggle: Dashboard notifications */}
      <SettingRow
        label="Notify on chargeback received"
        description="Show a dashboard notification when a new chargeback or inquiry is filed."
        disabled={!canEdit}
      >
        <Toggle
          checked={settings.chargeback_notify}
          onChange={(v) => save({ chargeback_notify: v })}
          disabled={!canEdit || saving}
        />
      </SettingRow>

      {/* Toggle: Auto-create ticket */}
      <SettingRow
        label="Auto-create support ticket on chargeback"
        description="Automatically create a support ticket with chargeback details and internal notes."
        disabled={!canEdit}
      >
        <Toggle
          checked={settings.chargeback_auto_ticket}
          onChange={(v) => save({ chargeback_auto_ticket: v })}
          disabled={!canEdit || saving}
        />
      </SettingRow>

      {/* Toggle: Evidence reminders */}
      <SettingRow
        label="Evidence reminder notifications"
        description="Notify when chargeback evidence submission is due soon."
        disabled={!canEdit}
      >
        <div className="flex items-center gap-3">
          <Toggle
            checked={settings.chargeback_evidence_reminder}
            onChange={(v) => save({ chargeback_evidence_reminder: v })}
            disabled={!canEdit || saving}
          />
          {settings.chargeback_evidence_reminder && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-500">Remind</span>
              <input
                type="number"
                min={1}
                max={14}
                value={settings.chargeback_evidence_reminder_days}
                onChange={(e) => save({ chargeback_evidence_reminder_days: parseInt(e.target.value) || 3 })}
                className="w-16 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                disabled={!canEdit || saving}
              />
              <span className="text-sm text-zinc-500">days before</span>
            </div>
          )}
        </div>
      </SettingRow>

      {/* Reason checklist */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Chargeback reasons that trigger auto-cancel
          </h3>
          <p className="mt-1 text-sm text-zinc-500">
            Select which chargeback reasons should automatically cancel subscriptions.
          </p>
        </div>

        <div className="space-y-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          {ALL_REASONS.map((reason) => {
            const checked = settings.chargeback_auto_cancel_reasons.includes(reason.value);
            const isNonFraud = !reason.default;
            return (
              <label
                key={reason.value}
                className="flex items-start gap-3 py-1"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleReason(reason.value)}
                  disabled={!canEdit || saving || !settings.chargeback_auto_cancel}
                  className="mt-0.5 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
                />
                <div>
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {reason.label}
                  </span>
                  {isNonFraud && checked && (
                    <p className="mt-0.5 text-xs text-yellow-600 dark:text-yellow-400">
                      Auto-cancelling for this reason may affect your ability to win the dispute.
                    </p>
                  )}
                </div>
              </label>
            );
          })}
        </div>

        {!settings.chargeback_auto_cancel && (
          <p className="text-xs text-zinc-400">
            Enable &ldquo;Auto-cancel subscriptions&rdquo; above to configure reasons.
          </p>
        )}
      </div>

      {/* Info banner */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
        <p className="text-sm text-blue-700 dark:text-blue-400">
          Chargeback automation requires Shopify Payments. If your workspace uses a third-party payment gateway, dispute webhooks will not fire and this feature will not work.
        </p>
      </div>
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
  disabled,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 ${disabled ? "opacity-60" : ""}`}>
      <div className="flex-1">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</p>
        <p className="mt-0.5 text-sm text-zinc-500">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-indigo-600" : "bg-zinc-200 dark:bg-zinc-700"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}
