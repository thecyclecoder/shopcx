/**
 * Software-mode support handoff — live hours + honest escalation messaging.
 *
 * Spec: software-mode-live-hours-handoff. In "software mode" (a self-serve SaaS tenant
 * workspace — anything that is NOT the managed Superfoods home workspace, where June / the
 * CS Director own escalations) the AI answers everything and the rare human handoff is honest
 * about WHEN a person will answer:
 *   - inside the workspace's live hours → "I'm bringing in a person now, stay here" + a
 *     dashboard_notifications card so a live owner can pick it up immediately.
 *   - outside the window (or no hours configured) → "We'll reply by email within one business
 *     day" and the ticket simply waits in the inbox (no notification, no June routing).
 *
 * The managed Superfoods home workspace is NOT software mode — its escalations keep flowing to
 * June / the CS Director via the triage-escalations cron. Every other tenant is software mode.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * The managed home workspace (Superfoods). Its support escalations route to June / the CS
 * Director (the triage-escalations June-review cron). Every OTHER workspace is a software-mode
 * SaaS tenant handled by the live-hours handoff below — there is exactly one managed workspace
 * in the system today, so "software mode" is defined as "not the managed home workspace".
 * Shares the id used by src/lib/media-buyer/publish-identity.ts `SUPERFOODS_WORKSPACE_ID` and
 * the PM workspace in src/lib/inngest/spec-drift-reconcile.ts.
 */
export const MANAGED_SUPPORT_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

/** True when the workspace is a software-mode SaaS tenant (no June / CS Director routing). */
export function isSoftwareModeWorkspace(workspaceId: string): boolean {
  return workspaceId !== MANAGED_SUPPORT_WORKSPACE_ID;
}

/**
 * Per-workspace support "live hours" — the window a live person is in chat. Stored in
 * `workspaces.support_live_hours` (jsonb); null = never live (always the email promise).
 */
export type SupportLiveHours = {
  /** IANA time zone the start/end bounds are expressed in, e.g. "America/New_York". */
  tz: string;
  /** Days of week the window is active. 0=Sun … 6=Sat. */
  days: number[];
  /** Local "HH:MM" start bound (inclusive). */
  start: string;
  /** Local "HH:MM" end bound (exclusive). */
  end: string;
};

/** Parse "HH:MM" to minutes-since-midnight, or null if malformed / out of range. */
function parseHhMm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Resolve the wall-clock weekday + hour + minute of `now` in the given IANA tz. */
function partsInTimeZone(
  tz: string,
  now: Date,
): { weekday: number; hour: number; minute: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const map: Record<string, string> = {};
    for (const p of fmt.formatToParts(now)) map[p.type] = p.value;
    const weekday = WEEKDAY_INDEX[map.weekday];
    // hour12:false emits "24" for midnight in some environments — normalize to 0.
    let hour = parseInt(map.hour, 10);
    if (hour === 24) hour = 0;
    const minute = parseInt(map.minute, 10);
    if (weekday === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { weekday, hour, minute };
  } catch {
    // Invalid tz → fail closed to "not live" (the email promise), never throw.
    return null;
  }
}

/**
 * True when `now` falls inside the workspace's configured live hours.
 *
 * null/invalid config → false (never live → always the email promise). Supports overnight
 * windows where `end` <= `start` (e.g. 22:00–02:00 spans midnight). A zero-length window
 * (start === end) is treated as never live.
 */
export function isWithinLiveHours(cfg: SupportLiveHours | null | undefined, now: Date): boolean {
  if (!cfg || typeof cfg !== "object") return false;
  if (!cfg.tz || !Array.isArray(cfg.days) || !cfg.start || !cfg.end) return false;
  const startMin = parseHhMm(cfg.start);
  const endMin = parseHhMm(cfg.end);
  if (startMin === null || endMin === null) return false;
  if (startMin === endMin) return false;
  const parts = partsInTimeZone(cfg.tz, now);
  if (!parts) return false;
  const nowMin = parts.hour * 60 + parts.minute;
  if (startMin < endMin) {
    // Same-day window: the configured day must match AND now in [start, end).
    if (!cfg.days.includes(parts.weekday)) return false;
    return nowMin >= startMin && nowMin < endMin;
  }
  // Overnight window (spans midnight). The "day" the window belongs to is its START day:
  //   after start on the start day, OR before end on the following day.
  if (nowMin >= startMin) {
    return cfg.days.includes(parts.weekday);
  }
  if (nowMin < endMin) {
    const prevDay = (parts.weekday + 6) % 7;
    return cfg.days.includes(prevDay);
  }
  return false;
}

/** Validate / normalize a raw `support_live_hours` jsonb value into a SupportLiveHours or null. */
export function normalizeSupportLiveHours(raw: unknown): SupportLiveHours | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.tz !== "string" || typeof o.start !== "string" || typeof o.end !== "string") {
    return null;
  }
  if (!Array.isArray(o.days)) return null;
  const days = o.days.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6);
  return { tz: o.tz, days, start: o.start, end: o.end };
}

/** The honest customer-facing handoff reply for the time of day. Plain text, ≤2 sentences. */
export function softwareHandoffReply(live: boolean): string {
  return live
    ? "I'm bringing in a person to help you right now. Please stay in this chat and someone will be with you shortly."
    : "I've passed this along to our team. We'll reply by email within one business day.";
}

/** Load + normalize a workspace's configured live hours (null = never live). */
export async function getSupportLiveHours(
  admin: AdminClient,
  workspaceId: string,
): Promise<SupportLiveHours | null> {
  const { data } = await admin
    .from("workspaces")
    .select("support_live_hours")
    .eq("id", workspaceId)
    .maybeSingle();
  return normalizeSupportLiveHours((data as { support_live_hours?: unknown } | null)?.support_live_hours ?? null);
}

/**
 * Route a software-mode escalation: send the honest, time-of-day-appropriate customer reply to
 * the widget and — inside live hours only — raise a dashboard_notifications card so a live owner
 * can pick it up now. Outside live hours the ticket just waits in the inbox for the promised
 * email reply. No June / CS Director routing (that is gated out of the triage cron for software
 * workspaces). Best-effort by design; the caller owns the authoritative escalation write.
 */
export async function routeSoftwareModeEscalation(opts: {
  admin: AdminClient;
  workspaceId: string;
  ticketId: string;
  reason: string;
  now?: Date;
}): Promise<{ live: boolean; message: string }> {
  const { admin, workspaceId, ticketId, reason } = opts;
  const now = opts.now ?? new Date();
  const cfg = await getSupportLiveHours(admin, workspaceId);
  const live = isWithinLiveHours(cfg, now);
  const message = softwareHandoffReply(live);

  // Honest customer-facing reply reaches the widget (external outbound AI message — the same
  // channel every agent reply from the ShopCX inbox already uses).
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "external",
    author_type: "ai",
    body: message,
  });

  // Inside live hours a founder/owner gets a bell card to pick it up now.
  if (live) {
    await admin.from("dashboard_notifications").insert({
      workspace_id: workspaceId,
      type: "system",
      title: "Live chat handoff — a customer is waiting",
      body: `A support chat escalated during live hours and needs a person now: ${reason}`.slice(0, 500),
      link: `/dashboard/tickets/${ticketId}`,
      metadata: { ticket_id: ticketId, reason, kind: "software_mode_live_handoff" },
    });
  }

  return { live, message };
}
