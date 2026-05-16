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

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { SmsPhonePreview } from "@/components/sms-phone-preview";

const TIMEZONE_OPTIONS = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Phoenix", label: "Arizona (Phoenix, no DST)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
];

// Archetype segments — independent boolean tags. Sorted by predicted
// conversion (engaged → cold) so the "cascade" pattern (include lower
// tiers, exclude higher tiers) reads naturally top-down. See
// TEXT-MARKETING.md § "Predictive segmentation" for definitions.
const ARCHETYPE_SEGMENTS = [
  { value: "engaged",      label: "Engaged",       hint: "Orders ≥1 + recent email-click / ATC / checkout (0.44% conv)" },
  { value: "cycle_hitter", label: "Cycle hitter",  hint: "Orders ≥2 + at expected reorder window (0.30% conv)" },
  { value: "just_ordered", label: "Just ordered",  hint: "Orders ≥2 + ordered recently vs cadence (0.19% conv)" },
  { value: "lapsed",       label: "Lapsed",        hint: "Orders ≥2 + 1.5–3× past expected reorder gap (0.10% conv)" },
  { value: "deep_lapsed",  label: "Deep lapsed",   hint: "Orders ≥2 + >3× past expected reorder gap" },
  { value: "single_order", label: "Single order",  hint: "Exactly 1 prior order (0.03% conv)" },
  { value: "cold",         label: "Cold",          hint: "0 prior orders (0.003% conv — spam tax)" },
];
// Flag segments — overlap with archetypes. Used as exclusions.
const FLAG_SEGMENTS = [
  { value: "active_sub",   label: "Active subscription", hint: "Has at least one status='active' subscription" },
];

export default function NewTextCampaignPage() {
  const workspace = useWorkspace();
  const router = useRouter();

  const [name, setName] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [sendDate, setSendDate] = useState(tomorrowIso());
  const [hour, setHour] = useState(9);
  const [fallbackHour, setFallbackHour] = useState(10);
  const [fallbackTz, setFallbackTz] = useState("America/Chicago");
  const [includedSegments, setIncludedSegments] = useState<string[]>([]);
  const [excludedSegments, setExcludedSegments] = useState<string[]>(["active_sub"]);
  const [audiencePreview, setAudiencePreview] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Coupon + shortlink fields
  const [couponEnabled, setCouponEnabled] = useState(false);
  const [couponDiscountPct, setCouponDiscountPct] = useState(15);
  const [couponExpiresDays, setCouponExpiresDays] = useState(21);
  const [shortlinkTargetUrl, setShortlinkTargetUrl] = useState("");

  // Sender phone + shortlink domain for preview rendering
  const [senderNumber, setSenderNumber] = useState<string | null>(null);
  const [shortlinkDomain, setShortlinkDomain] = useState<string | null>(null);
  useEffect(() => {
    if (!workspace?.id) return;
    fetch(`/api/workspaces/${workspace.id}/integrations`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (!d) return;
        setSenderNumber(d.twilio_phone_number || null);
        setShortlinkDomain(d.shortlink_domain || null);
      })
      .catch(() => { /* preview will show placeholder */ });
  }, [workspace?.id]);

  function toggleInclude(s: string) {
    setIncludedSegments((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
    setAudiencePreview(null);
  }
  function toggleExclude(s: string) {
    setExcludedSegments((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
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
        fallback_target_local_hour: fallbackHour,
        fallback_timezone: fallbackTz,
        audience_filter: {},
        included_segments: includedSegments,
        excluded_segments: excludedSegments,
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

  // Segment count uses 160 chars (GSM-7). Any emoji or non-Latin char
  // forces UCS-2 (70 chars/segment) but a hard 1-segment cap at 160
  // catches both — admin will see the warning and either trim text
  // or remove the emoji.
  const charCount = messageBody.length;
  const hasUcs2 = /[^\x00-\x7F]/.test(messageBody);
  const segmentSize = hasUcs2 ? 70 : 160;
  const segments = Math.ceil(charCount / segmentSize) || 1;
  const overflowsOneSegment = segments > 1;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">New text campaign</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Each recipient gets the message at <strong>{String(hour).padStart(2, "0")}:00 local time</strong> on {sendDate}, or <strong>{String(fallbackHour).padStart(2, "0")}:00 in {fallbackTz.split("/").pop()?.replace("_", " ")}</strong> if their timezone is unknown. Recipients with a known better-converting hour (later than planned) get sent at theirs.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
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
          hint={`${charCount} chars · ${segments} SMS segment${segments === 1 ? "" : "s"}${hasUcs2 ? " (UCS-2, emoji)" : " (GSM-7)"}${overflowsOneSegment ? ` — over 1 segment, would cost ${segments}× per recipient. Trim to ${segmentSize} chars${hasUcs2 ? " or remove emoji to use GSM-7 (160-char limit)" : ""}.` : ""}`}
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

        <div className="grid grid-cols-3 gap-4">
          <Field label="Send date (recipient local)">
            <input
              type="date"
              value={sendDate}
              onChange={(e) => setSendDate(e.target.value)}
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            />
          </Field>
          <Field label="Local hour" hint="Used when we can resolve the recipient's timezone.">
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
          <Field label="Fallback hour" hint="Used when we can't resolve the recipient's timezone — sent at this hour in the fallback timezone.">
            <select
              value={fallbackHour}
              onChange={(e) => setFallbackHour(Number(e.target.value))}
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

        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/40">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">Audience segments</div>
          <p className="mb-3 text-[11px] text-zinc-500">
            SMS-subscribed customers matching at least one <strong>Include</strong> segment AND none of the <strong>Exclude</strong> segments. Bad-phone customers and anyone messaged within the last 12 hours are filtered automatically.
          </p>

          <div className="space-y-3">
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Include</div>
              <div className="flex flex-wrap gap-2">
                {ARCHETYPE_SEGMENTS.map((o) => {
                  const on = includedSegments.includes(o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => toggleInclude(o.value)}
                      title={o.hint}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${on ? "border-emerald-500 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300" : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"}`}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-400">Exclude</div>
              <div className="flex flex-wrap gap-2">
                {/* All archetypes + the active_sub flag are excludable */}
                {[...ARCHETYPE_SEGMENTS, ...FLAG_SEGMENTS].map((o) => {
                  const on = excludedSegments.includes(o.value);
                  // Don't let admin exclude something they also included
                  // — that's a 0-recipient configuration.
                  const conflicted = includedSegments.includes(o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => toggleExclude(o.value)}
                      title={conflicted ? `Already included — can't exclude` : o.hint}
                      disabled={conflicted}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${on ? "border-rose-500 bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300" : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"} ${conflicted ? "opacity-30 cursor-not-allowed" : ""}`}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
              <button
                type="button"
                onClick={previewAudience}
                disabled={previewing || includedSegments.length === 0}
                className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
              >
                {previewing ? "Counting…" : includedSegments.length === 0 ? "Select at least one Include segment" : "Preview audience size"}
              </button>
              {audiencePreview != null && (
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {audiencePreview.toLocaleString()} recipients
                </p>
              )}
            </div>
          </div>
        </div>

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
            disabled={busy || overflowsOneSegment || includedSegments.length === 0}
            title={overflowsOneSegment ? "Trim to 1 segment first (avoids 2× cost per recipient)" : includedSegments.length === 0 ? "Pick at least one Include segment" : ""}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {busy ? "Scheduling…" : "Schedule campaign"}
          </button>
        </div>
        </div>

        <div className="hidden lg:block">
          <SmsPhonePreview
            messageBody={messageBody}
            mediaUrl={mediaUrl || undefined}
            senderNumber={senderNumber}
            couponEnabled={couponEnabled}
            hasShortlink={!!shortlinkTargetUrl.trim()}
            shortlinkDomain={shortlinkDomain}
          />
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
