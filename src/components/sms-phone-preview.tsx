"use client";

/**
 * iPhone-style SMS preview pane for the text-marketing campaign builder.
 *
 * Renders what the customer's phone will look like — status bar, sender
 * header, message bubble, optional MMS image. Substitutes the common
 * template placeholders ({first_name}, {coupon}, {shortlink}) with
 * believable sample values so the preview is faithful.
 *
 * Pure UI — no state, no fetching. Pass props from the form.
 */

import { useEffect, useState } from "react";

interface Props {
  messageBody: string;
  mediaUrl?: string;
  senderNumber?: string | null;
  /** True if the campaign will auto-generate a coupon — affects {coupon} preview. */
  couponEnabled?: boolean;
  /** True if a shortlink target was set — affects {shortlink} preview. */
  hasShortlink?: boolean;
  /** Workspace shortlink domain, e.g. "superfd.co". Falls back to a stand-in. */
  shortlinkDomain?: string | null;
  /** Sample first name used to substitute {first_name}. */
  sampleFirstName?: string;
}

export function SmsPhonePreview({
  messageBody,
  mediaUrl,
  senderNumber,
  couponEnabled,
  hasShortlink,
  shortlinkDomain,
  sampleFirstName = "Sarah",
}: Props) {
  // Render the current local time in the status bar so it feels alive.
  const [clock, setClock] = useState("9:41");
  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?[AP]M$/, ""));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  // Substitute placeholders for the preview rendering. Real send-time
  // substitution lives in src/lib/inngest/marketing-text.ts; this is
  // cosmetic.
  const previewedBody = (messageBody || "")
    .replace(/\{first_name\}/g, sampleFirstName)
    .replace(/\{coupon\}/g, couponEnabled ? "MAYBL47" : "{coupon}")
    .replace(/\{shortlink\}/g, hasShortlink ? `${shortlinkDomain || "sprfd.co"}/ABC123` : "{shortlink}");

  // Sender display: workspace's Twilio phone number, falling back to a
  // hint that they should configure one in Settings.
  const displaySender = senderNumber || "Set sender in settings";

  return (
    <div className="sticky top-6 flex flex-col items-center">
      {/* Phone frame */}
      <div className="relative w-[300px] rounded-[44px] bg-zinc-900 p-3 shadow-xl dark:bg-zinc-950 dark:ring-1 dark:ring-zinc-800">
        {/* Side buttons (cosmetic) */}
        <span className="absolute -left-[3px] top-24 h-12 w-[3px] rounded-l bg-zinc-700"></span>
        <span className="absolute -left-[3px] top-40 h-20 w-[3px] rounded-l bg-zinc-700"></span>
        <span className="absolute -right-[3px] top-32 h-16 w-[3px] rounded-r bg-zinc-700"></span>

        {/* Screen */}
        <div className="relative overflow-hidden rounded-[34px] bg-zinc-50">
          {/* Status bar */}
          <div className="flex h-7 items-center justify-between px-6 pt-2 text-[11px] font-semibold text-zinc-900">
            <span>{clock}</span>
            {/* Dynamic Island */}
            <div className="absolute left-1/2 top-2 h-5 w-20 -translate-x-1/2 rounded-full bg-zinc-900"></div>
            <span className="flex items-center gap-1">
              {/* signal */}
              <span className="flex items-end gap-[1px]">
                <span className="h-1 w-[3px] rounded-sm bg-zinc-900"></span>
                <span className="h-1.5 w-[3px] rounded-sm bg-zinc-900"></span>
                <span className="h-2 w-[3px] rounded-sm bg-zinc-900"></span>
                <span className="h-2.5 w-[3px] rounded-sm bg-zinc-900"></span>
              </span>
              {/* battery */}
              <span className="relative ml-1 inline-block h-2.5 w-5 rounded-sm border border-zinc-900">
                <span className="absolute inset-[1px] w-[60%] rounded-[1px] bg-zinc-900"></span>
              </span>
            </span>
          </div>

          {/* Conversation header */}
          <div className="border-b border-zinc-200 bg-zinc-50/95 px-3 pb-3 pt-1 backdrop-blur">
            <div className="flex items-center justify-center">
              <div className="flex flex-col items-center gap-1">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-300 text-base font-medium text-zinc-700">
                  {(displaySender || "?").slice(-2)}
                </div>
                <div className="text-[11px] font-medium leading-tight text-zinc-900">
                  {displaySender}
                </div>
              </div>
            </div>
          </div>

          {/* Message thread */}
          <div className="min-h-[360px] space-y-2 bg-zinc-50 px-3 py-3">
            <p className="text-center text-[10px] text-zinc-400">Text Message · Today {clock}</p>

            {mediaUrl ? (
              <div className="max-w-[80%]">
                <img
                  src={mediaUrl}
                  alt="MMS attachment"
                  className="rounded-2xl rounded-bl-md object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
            ) : null}

            {previewedBody.trim() ? (
              <div className="flex justify-start">
                <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-zinc-200 px-3 py-2 text-[13px] leading-tight text-zinc-900">
                  {linkify(previewedBody)}
                </div>
              </div>
            ) : (
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-zinc-200 px-3 py-2 text-[13px] italic text-zinc-400">
                  Your message will appear here.
                </div>
              </div>
            )}
          </div>

          {/* Home indicator */}
          <div className="flex h-6 items-center justify-center">
            <span className="h-1 w-28 rounded-full bg-zinc-900"></span>
          </div>
        </div>
      </div>

      {/* Caption */}
      <p className="mt-3 text-center text-[11px] text-zinc-500">
        Preview · placeholders shown with sample values
      </p>
    </div>
  );
}

/**
 * Wraps URL-looking substrings in a blue underlined span so they look
 * like links the way iOS auto-renders them. Doesn't make them real
 * anchor tags (the preview shouldn't be navigable).
 */
function linkify(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match http(s) URLs and bare-domain shortlink shapes like sprfd.co/ABC123
  const urlRe = /(https?:\/\/[^\s]+|[a-z0-9-]+\.(?:co|com|ai|io|net|app|link|to)\/[^\s]+)/gi;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={`u${i++}`} className="text-blue-600 underline decoration-blue-600/40">
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
