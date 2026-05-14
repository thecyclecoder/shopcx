"use client";

/**
 * Text marketing settings — consolidated config for the SMS/MMS
 * campaign system. Three sections:
 *
 *   1. Sender phone / shortcode — read-only display of the workspace's
 *      twilio_phone_number. Editing is out of scope here (provisioned
 *      separately at the Twilio account level).
 *   2. Shortlink domain — custom domain (e.g. sprfd.co) used in
 *      message bodies. Vercel registration + DNS instructions.
 *   3. Default campaign settings — fallback timezone, default coupon
 *      expiry. New campaigns prefill from these.
 */

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

const TIMEZONE_OPTIONS = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Phoenix", label: "Arizona (Phoenix, no DST)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
];

export default function TextMarketingSettingsPage() {
  const workspace = useWorkspace();
  const [loading, setLoading] = useState(true);
  const [senderPhone, setSenderPhone] = useState<string | null>(null);
  const [phoneInput, setPhoneInput] = useState("");
  const [editingPhone, setEditingPhone] = useState(false);
  const [savingPhone, setSavingPhone] = useState(false);
  const [shortlinkDomain, setShortlinkDomain] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState("");
  const [savingDomain, setSavingDomain] = useState(false);
  const [removingDomain, setRemovingDomain] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`);
    if (res.ok) {
      const d = await res.json();
      setShortlinkDomain(d.shortlink_domain || null);
      setSenderPhone(d.twilio_phone_number || null);
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { load(); }, [load]);

  async function saveDomain(e: React.FormEvent) {
    e.preventDefault();
    if (!domainInput.trim()) return;
    setSavingDomain(true);
    setError(null); setMessage(null);
    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortlink_domain: domainInput.trim().toLowerCase() }),
    });
    if (res.ok) {
      setMessage("Domain added to Vercel. Set up the DNS record below.");
      setShortlinkDomain(domainInput.trim().toLowerCase());
      setDomainInput("");
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Failed to add domain");
    }
    setSavingDomain(false);
  }

  async function savePhone() {
    setSavingPhone(true);
    setError(null); setMessage(null);
    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ twilio_phone_number: phoneInput.trim() || null }),
    });
    if (res.ok) {
      setMessage("Sender phone saved.");
      // Refresh from server so the normalized form (e.g. 10-digit → +1)
      // shows up.
      await load();
      setEditingPhone(false);
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Failed to save phone");
    }
    setSavingPhone(false);
  }

  async function removeDomain() {
    if (!confirm("Remove shortlink domain? Active shortlinks will stop resolving.")) return;
    setRemovingDomain(true); setError(null);
    await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortlink_domain: null }),
    });
    setShortlinkDomain(null);
    setMessage("Domain removed");
    setRemovingDomain(false);
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-screen-2xl px-4 py-6">
        <p className="text-sm text-zinc-400">Loading…</p>
      </div>
    );
  }

  const parts = shortlinkDomain ? shortlinkDomain.split(".") : [];
  const cnameName = parts.length === 2 ? "@" : parts.length > 2 ? parts[0] : "@";
  const isApex = cnameName === "@";

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Text marketing</h1>
      <p className="mb-8 text-sm text-zinc-500">
        Configuration for SMS/MMS campaigns. Manage campaigns themselves at{" "}
        <a href="/dashboard/marketing/text" className="text-indigo-600 hover:underline">Marketing → Text</a>.
      </p>

      {/* Sender */}
      <Section title="Sender" subtitle="The phone / shortcode that messages go out from. Provisioned through Twilio at the account level — enter it here so campaigns know which number to send from.">
        {editingPhone ? (
          <div className="space-y-2">
            <input
              type="text"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              placeholder="e.g. 85041 (shortcode) or +18005551234"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            />
            <p className="text-[11px] text-zinc-400">Accepts 5- or 6-digit shortcodes (e.g. 85041) or US 10-digit long codes (auto-prefixed with +1).</p>
            <div className="flex gap-2">
              <button
                onClick={savePhone}
                disabled={savingPhone}
                className="rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
              >
                {savingPhone ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => { setEditingPhone(false); setPhoneInput(senderPhone || ""); }}
                disabled={savingPhone}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : senderPhone ? (
          <div className="flex items-center gap-3">
            <span className="font-mono text-xl font-semibold text-zinc-900 dark:text-zinc-100">{senderPhone}</span>
            <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">Active</span>
            <button
              onClick={() => { setPhoneInput(senderPhone); setEditingPhone(true); }}
              className="ml-auto text-xs text-indigo-600 hover:underline"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-zinc-500">No sender configured yet. Set the phone or shortcode this workspace sends marketing messages from.</p>
            <button
              onClick={() => { setPhoneInput(""); setEditingPhone(true); }}
              className="rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-600"
            >
              Set sender
            </button>
          </div>
        )}
      </Section>

      {/* Shortlink domain */}
      <Section
        title="Shortlink domain"
        subtitle="Short domain used in message bodies (e.g. sprfd.co/ABC123). Each campaign with a shortlink target generates a slug that resolves on this domain."
      >
        {shortlinkDomain ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950">
              <div>
                <p className="text-sm font-medium text-green-800 dark:text-green-200">{shortlinkDomain}</p>
                <p className="text-xs text-green-600 dark:text-green-400">Registered with Vercel</p>
              </div>
              <button
                onClick={removeDomain}
                disabled={removingDomain}
                className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {removingDomain ? "Removing…" : "Remove"}
              </button>
            </div>

            <div className="rounded-md bg-zinc-50 p-4 dark:bg-zinc-800/50">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">DNS Record</p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-500">
                    <th className="pb-2">Type</th>
                    <th className="pb-2">Name</th>
                    <th className="pb-2">Value</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  {isApex ? (
                    <tr>
                      <td className="py-1 text-zinc-700 dark:text-zinc-300">A</td>
                      <td className="py-1 text-zinc-700 dark:text-zinc-300">@</td>
                      <td className="py-1">
                        <span className="rounded bg-zinc-200 px-2 py-0.5 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200">76.76.21.21</span>
                      </td>
                    </tr>
                  ) : (
                    <tr>
                      <td className="py-1 text-zinc-700 dark:text-zinc-300">CNAME</td>
                      <td className="py-1 text-zinc-700 dark:text-zinc-300">{cnameName}</td>
                      <td className="py-1">
                        <span className="rounded bg-zinc-200 px-2 py-0.5 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200">cname.vercel-dns.com</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p className="mt-3 text-[10px] text-zinc-400">
                {isApex
                  ? "Apex domains need an A record. Some providers require ALIAS/ANAME — check yours if A isn't supported."
                  : "Propagation usually takes 1–5 minutes. SSL is issued automatically."}
              </p>
            </div>

            <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500">Example campaign URL:</p>
              <p className="mt-1 font-mono text-sm text-indigo-600">https://{shortlinkDomain}/ABC123</p>
            </div>
          </div>
        ) : (
          <form onSubmit={saveDomain} className="space-y-3">
            <input
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder="e.g. sprfd.co"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            />
            <button
              type="submit"
              disabled={savingDomain || !domainInput.trim()}
              className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
            >
              {savingDomain ? "Adding…" : "Add Domain"}
            </button>
          </form>
        )}
      </Section>

      {/* Defaults — placeholder for future expansion (default tz, default
          coupon expiry, default sender hour, etc). Surfaced here so admins
          have one home for all text-marketing config; we just don't store
          these yet — campaigns set them per-instance. */}
      <Section
        title="Defaults"
        subtitle="Defaults for new campaigns. Currently configured per-campaign in the builder; will move here when we add workspace-level defaults."
      >
        <ul className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
          <li>
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">Fallback timezone</span>{" "}
            — set on each campaign. Recommended:{" "}
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">{TIMEZONE_OPTIONS[1].value}</span>
          </li>
          <li>
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">Coupon expiry</span> — 21 days after first send (campaign-overridable).
          </li>
          <li>
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">Body placeholders</span>{" "}
            — <span className="font-mono text-xs">{"{coupon}"}</span> and{" "}
            <span className="font-mono text-xs">{"{shortlink}"}</span> are substituted at send time.
          </li>
        </ul>
      </Section>

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
      {message && <p className="mt-4 text-sm text-green-600">{message}</p>}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      <p className="mt-0.5 mb-4 text-xs text-zinc-500">{subtitle}</p>
      {children}
    </section>
  );
}
