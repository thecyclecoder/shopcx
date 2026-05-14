"use client";

/**
 * Text marketing — new campaign builder.
 *
 * Minimal v1 form. The audience filter is currently a single-row
 * selection (all subscribed SMS contacts) with optional subscription
 * status narrowing. Future: full segment builder.
 *
 * Fields explained:
 *   name              — internal label, shown in list view.
 *   message_body      — what goes out. Twilio segments at 160 chars
 *                       (GSM-7) or 70 chars (UCS-2 / emoji). Multiple
 *                       segments still send, but each segment is its
 *                       own SMS charge.
 *   media_url         — public URL to an MMS image. (Upload UI v2.)
 *   send_date         — local calendar date in each recipient's TZ.
 *   target_local_hour — local time of day, 0-23.
 *   fallback_timezone — IANA. Used when a recipient has no timezone
 *                       (no address, no phone area code we can map).
 *                       Central is the safe US default.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
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

const SUB_STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "cancelled", label: "Cancelled" },
  { value: "never", label: "Never subscribed (lead-only)" },
];

export default function NewTextCampaignPage() {
  const workspace = useWorkspace();
  const router = useRouter();

  const [name, setName] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [sendDate, setSendDate] = useState(tomorrowIso());
  const [hour, setHour] = useState(11);
  const [fallbackTz, setFallbackTz] = useState("America/Chicago");
  const [subStatuses, setSubStatuses] = useState<string[]>(["active", "paused", "never"]);
  const [audiencePreview, setAudiencePreview] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Coupon + shortlink fields
  const [couponEnabled, setCouponEnabled] = useState(false);
  const [couponDiscountPct, setCouponDiscountPct] = useState(15);
  const [couponExpiresDays, setCouponExpiresDays] = useState(21);
  const [shortlinkTargetUrl, setShortlinkTargetUrl] = useState("");

  function toggleSubStatus(s: string) {
    setSubStatuses((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
    setAudiencePreview(null);
  }

  async function previewAudience() {
    setPreviewing(true);
    setError(null);
    try {
      // Save draft first, then ask for preview. Keeps it consistent
      // with how Schedule operates (always reads from a stored row).
      const draft = await saveDraft();
      if (!draft) return;
      const res = await fetch(`/api/workspaces/${workspace.id}/sms-campaigns/${draft.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview_audience" }),
      });
      if (res.ok) {
        const d = await res.json();
        setAudiencePreview(d.audience_count);
      }
    } finally {
      setPreviewing(false);
    }
  }

  async function saveDraft(): Promise<{ id: string } | null> {
    setError(null);
    if (!name.trim() || !messageBody.trim()) {
      setError("Name and message body are required.");
      return null;
    }
    const res = await fetch(`/api/workspaces/${workspace.id}/sms-campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        message_body: messageBody.trim(),
        media_url: mediaUrl.trim() || null,
        send_date: sendDate,
        target_local_hour: hour,
        fallback_timezone: fallbackTz,
        audience_filter: {
          subscription_status: subStatuses.length > 0 ? subStatuses : undefined,
        },
        coupon_enabled: couponEnabled,
        coupon_discount_pct: couponEnabled ? couponDiscountPct : null,
        coupon_expires_days_after_send: couponEnabled ? couponExpiresDays : null,
        shortlink_target_url: shortlinkTargetUrl.trim() || null,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || "Save failed.");
      return null;
    }
    const data = await res.json();
    return data.campaign;
  }

  async function scheduleNow() {
    setBusy(true);
    setError(null);
    try {
      const draft = await saveDraft();
      if (!draft) { setBusy(false); return; }
      const res = await fetch(`/api/workspaces/${workspace.id}/sms-campaigns/${draft.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "schedule" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || "Schedule failed.");
        setBusy(false);
        return;
      }
      router.push(`/dashboard/marketing/text/${draft.id}`);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function justSaveDraft() {
    setBusy(true);
    const draft = await saveDraft();
    if (draft) router.push(`/dashboard/marketing/text/${draft.id}`);
    setBusy(false);
  }

  const charCount = messageBody.length;
  const segments = Math.ceil(charCount / 160) || 1;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">New text campaign</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Each recipient gets the message at <strong>{String(hour).padStart(2, "0")}:00 local time</strong> in their timezone on {sendDate}.
        </p>
      </header>

      <div className="space-y-5 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <Field label="Campaign name" hint="Internal — customers don't see this.">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. May coffee restock blast"
            className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
        </Field>

        <Field
          label="Message body"
          hint={`${charCount} chars · ~${segments} SMS segment${segments === 1 ? "" : "s"}`}
        >
          <textarea
            value={messageBody}
            onChange={(e) => setMessageBody(e.target.value)}
            rows={4}
            placeholder="Hey {first_name} — we just restocked your favorite flavor. Use code SHOPCX for 20% off → sprfd.co/ABC123"
            className="w-full rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
        </Field>

        <Field label="MMS image URL (optional)" hint="Sends as MMS — image attached to the message.">
          <input
            type="text"
            value={mediaUrl}
            onChange={(e) => setMediaUrl(e.target.value)}
            placeholder="https://…/image.jpg"
            className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Send date (recipient local)">
            <input
              type="date"
              value={sendDate}
              onChange={(e) => setSendDate(e.target.value)}
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            />
          </Field>
          <Field label="Local hour">
            <select
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            >
              {Array.from({ length: 24 }).map((_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00 ({h === 0 ? "midnight" : h < 12 ? `${h} AM` : h === 12 ? "noon" : `${h - 12} PM`})
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label="Fallback timezone"
          hint="Used when a recipient has no address + no US phone we can derive a timezone from."
        >
          <select
            value={fallbackTz}
            onChange={(e) => setFallbackTz(e.target.value)}
            className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          >
            {TIMEZONE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>

        {/* ── Shortlink (optional) ──────────────────────────── */}
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/40">
          <Field
            label="Shortlink target URL (optional)"
            hint="If set, we generate a short URL on your shortlink domain (e.g. sprfd.co/ABC123) that redirects here. Use {shortlink} in the body to insert it."
          >
            <input
              type="url"
              value={shortlinkTargetUrl}
              onChange={(e) => setShortlinkTargetUrl(e.target.value)}
              placeholder="https://shop.superfoodscompany.com/amazing-coffee"
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </Field>
        </div>

        {/* ── Coupon (optional) ────────────────────────────── */}
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/40">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={couponEnabled}
              onChange={(e) => setCouponEnabled(e.target.checked)}
              className="mt-0.5"
            />
            <div>
              <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Generate a campaign coupon</span>
              <p className="text-xs text-zinc-500">
                One shared discount code (e.g. <span className="font-mono">MAYBL47</span>) auto-created in Shopify when you schedule. Use <span className="font-mono">{"{coupon}"}</span> in the body to insert it. Auto-disabled after the expiry window.
              </p>
            </div>
          </label>
          {couponEnabled && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Discount %">
                <input
                  type="number"
                  min={1} max={80}
                  value={couponDiscountPct}
                  onChange={(e) => setCouponDiscountPct(Number(e.target.value))}
                  className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
              </Field>
              <Field label="Expires after (days)">
                <input
                  type="number"
                  min={1} max={365}
                  value={couponExpiresDays}
                  onChange={(e) => setCouponExpiresDays(Number(e.target.value))}
                  className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
              </Field>
            </div>
          )}
        </div>

        <Field label="Audience" hint="All SMS-subscribed customers in the selected subscription states.">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {SUB_STATUS_OPTIONS.map((o) => {
                const on = subStatuses.includes(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggleSubStatus(o.value)}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold ${on ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-zinc-300 bg-white text-zinc-700"}`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={previewAudience}
              disabled={previewing}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
            >
              {previewing ? "Counting…" : "Preview audience size"}
            </button>
            {audiencePreview != null && (
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {audiencePreview.toLocaleString()} recipients match this audience.
              </p>
            )}
          </div>
        </Field>

        {error && (
          <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
        )}

        <div className="flex gap-3 border-t border-zinc-200 pt-5 dark:border-zinc-800">
          <button
            type="button"
            onClick={justSaveDraft}
            disabled={busy}
            className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          >
            Save draft
          </button>
          <button
            type="button"
            onClick={scheduleNow}
            disabled={busy}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {busy ? "Scheduling…" : "Schedule campaign"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-400">{hint}</span>}
    </label>
  );
}

function tomorrowIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
