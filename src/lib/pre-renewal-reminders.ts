/**
 * Pre-renewal reminder channel — the daily job that reminds a subscriber ~5 days
 * before their next billing date and drops them into the next-order journey.
 *
 * This is the reminder the whole M2/M3 retention test measures. About five days
 * before each subscription's next_billing_date, across BOTH live engines
 * (billing_source 'shopcx' + 'internal'), we:
 *
 *   1. Scan subscriptions whose next_billing_date lands in the window, excluding
 *      status != 'active', subs in an active dunning cycle ([[../tables/dunning]]
 *      `dunning_cycles` status active/skipped/paused), and subs edited in the last
 *      few days (updated_at within PRE_RENEWAL_RECENT_EDIT_DAYS — a just-edited sub
 *      was already acted on; don't nudge).
 *   2. Collapse the audience to ONE reminder per customer identity GROUP via the
 *      customer_links group_id ([[subscriber-experiments]] `resolveGroupId`), so a
 *      person's several / close-together renewals become a single reminder keyed on
 *      the EARLIEST in-window next_billing_date.
 *   3. Ask the subscriber-experiment harness for the arm (`assignArm` — sticky,
 *      assigned once at first eligibility, honours the harness kill switch). Only the
 *      treatment arm is reminded; the holdout gets nothing new (its row records the
 *      counterfactual decision).
 *   4. For treatment: mint a next-order journey session + send a transactional email
 *      (Phase 2), and — only for SMS-consented customers — a consented, quiet-hours
 *      respecting SMS at the recipient's local send window (Phase 3).
 *
 * Every intended + actual send is written to [[../tables/pre_renewal_reminders]]
 * stamped with the arm. This module is the SINGLE chokepoint for that ledger — all
 * `.from("pre_renewal_reminders")` access lives here (CLAUDE.md raw-`.from` rule).
 *
 * Supervisable autonomy (north star): the cron node
 * `pre-renewal-reminder-cron` is registered under the `retention` function in the
 * control-tower registry with a kill_switches ancestry; `runPreRenewalReminders`
 * honours an effective OFF (no sends) and the cron heartbeats every tick.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { assignArm, PRE_RENEWAL_EXPERIMENT_SLUG } from "@/lib/subscriber-experiments";
import { resolveEffectiveSwitch } from "@/lib/control-tower/kill-switch-resolver";
import { generateJourneyToken, getJourneyUrl } from "@/lib/journey-tokens";
import { sendJourneyCTA } from "@/lib/email";
import {
  resolveRecipientTimezone,
  computeSendInstant,
  type CustomerForTzResolve,
} from "@/lib/marketing-text-timezone";
import { sendSMS } from "@/lib/twilio";

type Admin = ReturnType<typeof createAdminClient>;

/** The control-tower loop_id / node id for the daily cron (owner: retention). */
export const PRE_RENEWAL_REMINDER_LOOP_ID = "pre-renewal-reminder-cron";

/** Reminder lands ~5 days before billing; we select a ±1 day band around it so a
 *  daily cron that misses a tick still catches the renewal. */
export const PRE_RENEWAL_WINDOW_DAYS = 5;
const WINDOW_LOW_DAYS = PRE_RENEWAL_WINDOW_DAYS - 1; // 4
const WINDOW_HIGH_DAYS = PRE_RENEWAL_WINDOW_DAYS + 1; // 6

/** A sub edited within this many days was just acted on — skip (don't re-nudge). */
export const PRE_RENEWAL_RECENT_EDIT_DAYS = 3;

/** Local hour the SMS targets — well inside business hours so quiet hours (night)
 *  are never breached. The email is transactional and sends immediately. */
export const PRE_RENEWAL_SMS_LOCAL_HOUR = 11;

/** Workspace timezone fallback when a recipient's tz can't be resolved. */
const DEFAULT_FALLBACK_TZ = "America/Chicago";

/** Live billing engines the reminder covers (Appstle is being sunset). */
const LIVE_BILLING_SOURCES = ["shopcx", "internal"] as const;

export interface ReminderGroup {
  groupId: string;
  /** Representative account (the earliest-renewing sub's customer). */
  customerId: string;
  /** Earliest in-window next_billing_date across the group's selected subs. */
  nextBillingDate: string; // YYYY-MM-DD
  /** The earliest sub — pre-selected into the next-order journey. */
  subscriptionId: string;
  subscriptionIds: string[];
}

export interface PreRenewalRunResult {
  workspaces: number;
  groups: number;
  treatment: number;
  holdout: number;
  emailsSent: number;
  smsSent: number;
  smsSuppressed: number;
  skipped: number;
  killSwitchOff?: boolean;
}

/** YYYY-MM-DD in UTC — stable, timezone-free dedupe key for a renewal date. */
function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------------------------------------
 * Phase 1 — eligibility scan + dedupe.
 * --------------------------------------------------------------------------------------------- */

/**
 * Build the deduped reminder audience for one workspace: active subs renewing in
 * the window, minus dunning + just-edited subs, collapsed to one group per person.
 */
export async function scanEligibleReminders(
  workspaceId: string,
  now: Date,
  admin: Admin = createAdminClient(),
): Promise<ReminderGroup[]> {
  const low = new Date(now.getTime() + WINDOW_LOW_DAYS * 86_400_000);
  const high = new Date(now.getTime() + WINDOW_HIGH_DAYS * 86_400_000);
  const recentEditCutoff = new Date(now.getTime() - PRE_RENEWAL_RECENT_EDIT_DAYS * 86_400_000);

  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, customer_id, next_billing_date, updated_at, shopify_contract_id")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .in("billing_source", LIVE_BILLING_SOURCES as unknown as string[])
    .gte("next_billing_date", low.toISOString())
    .lte("next_billing_date", high.toISOString())
    .order("next_billing_date", { ascending: true });

  const candidates = (subs || []).filter(
    (s) => s.customer_id && s.next_billing_date,
  ) as { id: string; customer_id: string; next_billing_date: string; updated_at: string | null; shopify_contract_id: string | null }[];
  if (candidates.length === 0) return [];

  // Exclude subs in an active dunning cycle (active/skipped/paused). A failing
  // renewal belongs to the dunning path, not a next-order nudge.
  const subIds = candidates.map((s) => s.id);
  const dunningSubs = new Set<string>();
  const { data: dunning } = await admin
    .from("dunning_cycles")
    .select("subscription_id")
    .eq("workspace_id", workspaceId)
    .in("subscription_id", subIds)
    .in("status", ["active", "skipped", "paused"]);
  for (const d of dunning || []) {
    if (d.subscription_id) dunningSubs.add(d.subscription_id as string);
  }

  // Resolve each candidate's identity GROUP and collapse to one reminder per group,
  // keyed on the earliest in-window next_billing_date.
  const byGroup = new Map<string, ReminderGroup>();
  for (const sub of candidates) {
    if (dunningSubs.has(sub.id)) continue;
    // Just-edited → already acted on; skip.
    if (sub.updated_at && new Date(sub.updated_at) >= recentEditCutoff) continue;

    const groupId = await resolveGroupIdCached(admin, sub.customer_id);
    const existing = byGroup.get(groupId);
    if (!existing) {
      byGroup.set(groupId, {
        groupId,
        customerId: sub.customer_id,
        nextBillingDate: toDateKey(new Date(sub.next_billing_date)),
        subscriptionId: sub.id,
        subscriptionIds: [sub.id],
      });
    } else {
      existing.subscriptionIds.push(sub.id);
      // Candidates come back ordered by next_billing_date asc, so the first seen is
      // already the earliest — keep it as the representative.
    }
  }

  return [...byGroup.values()];
}

// A tiny per-run memo so a workspace with many subs on one person doesn't re-query
// customer_links for every account. Keyed by customer_id within a single scan.
const _groupCache = new Map<string, string>();
async function resolveGroupIdCached(admin: Admin, customerId: string): Promise<string> {
  const hit = _groupCache.get(customerId);
  if (hit) return hit;
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId)
    .maybeSingle();
  const groupId = (link?.group_id as string | undefined) ?? customerId;
  _groupCache.set(customerId, groupId);
  return groupId;
}

/* ------------------------------------------------------------------------------------------------
 * Phases 1-3 — per-workspace run: arm → ledger → email → SMS.
 * --------------------------------------------------------------------------------------------- */

/**
 * Process one workspace's reminder audience. Returns per-channel counts. Idempotent:
 * the UNIQUE (workspace_id, group_id, renewal_window_key) insert is the guard that
 * makes a re-run (or the same sub seen on consecutive days) a no-op — a conflicting
 * insert means this reminder already fired, so we never double-send.
 */
export async function runPreRenewalRemindersForWorkspace(
  workspaceId: string,
  now: Date,
  admin: Admin = createAdminClient(),
): Promise<Omit<PreRenewalRunResult, "workspaces">> {
  const out = { groups: 0, treatment: 0, holdout: 0, emailsSent: 0, smsSent: 0, smsSuppressed: 0, skipped: 0 };

  const groups = await scanEligibleReminders(workspaceId, now, admin);
  if (groups.length === 0) return out;

  // Workspace send context (name/color for the email, phone for SMS).
  const { data: ws } = await admin
    .from("workspaces")
    .select("name, help_primary_color, twilio_phone_number")
    .eq("id", workspaceId)
    .maybeSingle();

  for (const group of groups) {
    out.groups++;

    // Sticky arm at first eligibility. assignArm reads the stored arm if present,
    // else mints one (honouring the harness kill switch) under the UNIQUE
    // (experiment_id, group_id) guard. null ⇒ experiment not running / switch off.
    const arm = await assignArm(workspaceId, PRE_RENEWAL_EXPERIMENT_SLUG, group.customerId, admin);
    if (!arm) {
      out.skipped++;
      continue;
    }

    // Insert the ledger row FIRST — the unique conflict is the atomic double-send
    // guard. If it already exists this reminder was handled; skip.
    const { data: inserted, error: insErr } = await admin
      .from("pre_renewal_reminders")
      .insert({
        workspace_id: workspaceId,
        group_id: group.groupId,
        customer_id: group.customerId,
        renewal_window_key: group.nextBillingDate,
        next_billing_date: group.nextBillingDate,
        experiment_arm: arm,
        channels: [],
        status: arm === "holdout" ? "holdout" : "pending",
      })
      .select("id")
      .maybeSingle();

    if (insErr) {
      // 23505 unique_violation ⇒ already reminded for this (group, window). Not an error.
      if (insErr.code === "23505") {
        out.skipped++;
        continue;
      }
      throw new Error(`pre_renewal_reminders insert: ${insErr.message}`);
    }
    const ledgerId = inserted?.id as string | undefined;

    if (arm === "holdout") {
      out.holdout++;
      continue; // Holdout gets nothing new — the row is the counterfactual record.
    }

    out.treatment++;
    if (!ledgerId) {
      out.skipped++;
      continue;
    }

    await sendTreatmentReminder(workspaceId, ledgerId, group, ws, now, admin, out);
  }

  return out;
}

/**
 * Treatment path: mint the next-order journey session, send the transactional email
 * (Phase 2), then the consented SMS (Phase 3). Stamps the ledger row throughout.
 */
async function sendTreatmentReminder(
  workspaceId: string,
  ledgerId: string,
  group: ReminderGroup,
  ws: { name?: string | null; help_primary_color?: string | null; twilio_phone_number?: string | null } | null,
  now: Date,
  admin: Admin,
  out: { emailsSent: number; smsSent: number; smsSuppressed: number },
): Promise<void> {
  // The next-order journey definition (slug 'next-order', seeded per workspace).
  const { data: journeyDef } = await admin
    .from("journey_definitions")
    .select("id, is_active")
    .eq("workspace_id", workspaceId)
    .eq("slug", "next-order")
    .maybeSingle();

  // The customer we reach (email + phone + tz inputs).
  const { data: customer } = await admin
    .from("customers")
    .select("email, first_name, phone, timezone, default_address, sms_marketing_status, phone_status")
    .eq("id", group.customerId)
    .maybeSingle();

  const channels: string[] = [];
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  // ── Mint the journey session (one CTA = one mini-site). ──
  let token: string | null = null;
  if (journeyDef?.id && journeyDef.is_active !== false) {
    token = generateJourneyToken();
    const { data: session } = await admin
      .from("journey_sessions")
      .insert({
        workspace_id: workspaceId,
        journey_id: journeyDef.id,
        customer_id: group.customerId,
        subscription_id: group.subscriptionId,
        token,
        token_expires_at: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
        status: "pending",
        config_snapshot: {
          codeDriven: true,
          liveRendered: true,
          journeyType: "next_order",
          workspaceId,
          source: "pre-renewal-reminder",
        },
      })
      .select("id")
      .maybeSingle();
    update.journey_session_id = session?.id ?? null;
    update.journey_token = token;
  }

  const workspaceName = ws?.name || "Support";
  const leadIn =
    "Your next order is coming up soon. Take a moment to review it — swap flavors, change quantities, update your delivery date, or adjust anything before we bill.";

  // ── Phase 2: transactional email (goes to every treatment customer). ──
  if (customer?.email && token) {
    try {
      const res = await sendJourneyCTA({
        workspaceId,
        toEmail: customer.email,
        customerName: customer.first_name || "",
        journeyToken: token,
        contextMessage: leadIn,
        workspaceName,
        primaryColor: ws?.help_primary_color || undefined,
        subject: `Your next order is almost here — review it first`,
        buttonLabel: "Review my next order",
        expiryHours: null,
      });
      if (res.messageId) {
        channels.push("email");
        update.email_status = "sent";
        update.email_sent_at = new Date().toISOString();
        out.emailsSent++;
      } else {
        update.email_status = "failed";
        update.email_error = res.error || "no message id";
      }
    } catch (e) {
      update.email_status = "failed";
      update.email_error = errText(e);
    }
  } else if (!token) {
    update.email_status = "failed";
    update.email_error = "next-order journey not active for workspace";
  } else {
    update.email_status = "failed";
    update.email_error = "customer has no email";
  }

  // ── Phase 3: consented SMS (gated on marketing consent + quiet hours). ──
  const smsResult = await maybeSendConsentedSms(
    workspaceId,
    customer,
    token,
    leadIn,
    now,
  );
  Object.assign(update, smsResult.update);
  if (smsResult.sent) {
    channels.push("sms");
    out.smsSent++;
  } else if (smsResult.suppressed) {
    out.smsSuppressed++;
  }

  update.channels = channels;
  update.status = "sent";

  await admin.from("pre_renewal_reminders").update(update).eq("id", ledgerId);
}

/* ------------------------------------------------------------------------------------------------
 * Phase 3 — consented SMS with timezone / quiet-hours + STOP honored.
 * --------------------------------------------------------------------------------------------- */

interface SmsCustomer extends CustomerForTzResolve {
  phone?: string | null;
  sms_marketing_status?: string | null;
  phone_status?: string | null;
}

/** The legal send/suppress decision for a recipient (TCPA). `allowed` ⇒ consented + a
 *  good phone; otherwise the specific suppression reason so the M3 guardrail can split
 *  opt-outs (STOP) from plain non-consent. PURE — no I/O, exported for testing. */
export type SmsConsentVerdict =
  | { allowed: true }
  | { allowed: false; smsStatus: "suppressed_stop" | "suppressed_no_consent"; reason: string };

export function classifySmsConsent(customer: SmsCustomer | null | undefined): SmsConsentVerdict {
  const consent = customer?.sms_marketing_status;
  // STOP honored via the Twilio inbound → marketing-consent path: an opted-out customer
  // reads 'unsubscribed'. Distinguish from never-consented for the guardrail.
  if (consent === "unsubscribed") {
    return { allowed: false, smsStatus: "suppressed_stop", reason: "customer sent STOP / sms_marketing_status=unsubscribed" };
  }
  if (consent !== "subscribed" || !customer?.phone) {
    return { allowed: false, smsStatus: "suppressed_no_consent", reason: `no sms marketing consent (status=${consent ?? "none"})` };
  }
  // Bad phone (marked invalid/unsubscribed by a past Twilio failure) → suppress.
  if (customer.phone_status && customer.phone_status !== "good") {
    return { allowed: false, smsStatus: "suppressed_no_consent", reason: `phone_status=${customer.phone_status}` };
  }
  return { allowed: true };
}

/**
 * Send the reminder by SMS ONLY to a customer with live marketing consent, at their
 * local send window with quiet hours respected. A non-consented customer, a customer
 * who sent STOP (sms_marketing_status 'unsubscribed'), or a bad phone gets NO text —
 * the suppression is counted on the ledger so the M3 opt-out/complaint guardrails can
 * read it. Never texts a suppressed or non-consented customer (TCPA).
 */
async function maybeSendConsentedSms(
  workspaceId: string,
  customer: SmsCustomer | null | undefined,
  token: string | null,
  leadIn: string,
  now: Date,
): Promise<{ sent: boolean; suppressed: boolean; update: Record<string, unknown> }> {
  const update: Record<string, unknown> = {};

  // Never text a suppressed or non-consented customer (TCPA). The pure gate records
  // the specific suppression reason (STOP vs non-consent) for the M3 guardrail.
  const verdict = classifySmsConsent(customer);
  if (!verdict.allowed) {
    update.sms_status = verdict.smsStatus;
    update.sms_suppression_reason = verdict.reason;
    return { sent: false, suppressed: true, update };
  }
  if (!token) {
    update.sms_status = "failed";
    update.sms_error = "no journey token to link";
    return { sent: false, suppressed: false, update };
  }

  // Resolve the recipient's timezone + compute the local send instant. Targeting a
  // business-hours local hour inherently respects quiet hours (no night sends).
  const tz = resolveRecipientTimezone(customer, DEFAULT_FALLBACK_TZ);
  const sendAt = computeSendInstant(toDateKey(now), PRE_RENEWAL_SMS_LOCAL_HOUR, tz.timezone);
  update.sms_resolved_timezone = tz.timezone;
  update.sms_timezone_source = tz.source;

  // Twilio SendAt must be ≥15 min out and ≤7 days. If the local window already
  // passed today (or is <16 min away), send immediately rather than schedule.
  const minScheduleAt = new Date(now.getTime() + 16 * 60_000);
  const useSchedule = sendAt.getTime() >= minScheduleAt.getTime();

  const journeyUrl = getJourneyUrl(token);
  const body = `${leadIn}\n\n${journeyUrl}`;

  try {
    // verdict.allowed guarantees a consented customer with a phone.
    const res = await sendSMS(workspaceId, customer!.phone!, body, useSchedule ? { sendAt } : undefined);
    if (res.success) {
      update.sms_status = useSchedule ? "scheduled" : "sent";
      update.sms_scheduled_send_at = useSchedule ? sendAt.toISOString() : new Date().toISOString();
      return { sent: true, suppressed: false, update };
    }
    update.sms_status = "failed";
    update.sms_error = res.error || `twilio error ${res.errorCode ?? ""}`.trim();
    return { sent: false, suppressed: false, update };
  } catch (e) {
    update.sms_status = "failed";
    update.sms_error = errText(e);
    return { sent: false, suppressed: false, update };
  }
}

/* ------------------------------------------------------------------------------------------------
 * Top-level run — fan out across workspaces, honouring the cron kill switch.
 * --------------------------------------------------------------------------------------------- */

/**
 * The daily pre-renewal reminder run. Honours the cron's effective kill switch (an
 * OFF trip stops all sends but still returns cleanly so the cron can heartbeat), then
 * processes every workspace. A workspace with no running experiment is a cheap no-op
 * (assignArm returns null → every group skipped).
 */
export async function runPreRenewalReminders(
  now: Date = new Date(),
  admin: Admin = createAdminClient(),
): Promise<PreRenewalRunResult> {
  _groupCache.clear();
  const base: PreRenewalRunResult = {
    workspaces: 0, groups: 0, treatment: 0, holdout: 0,
    emailsSent: 0, smsSent: 0, smsSuppressed: 0, skipped: 0,
  };

  const sw = await resolveEffectiveSwitch(PRE_RENEWAL_REMINDER_LOOP_ID);
  if (sw.off) {
    return { ...base, killSwitchOff: true };
  }

  const { data: workspaces } = await admin.from("workspaces").select("id");
  for (const w of workspaces || []) {
    const r = await runPreRenewalRemindersForWorkspace(w.id as string, now, admin);
    base.workspaces++;
    base.groups += r.groups;
    base.treatment += r.treatment;
    base.holdout += r.holdout;
    base.emailsSent += r.emailsSent;
    base.smsSent += r.smsSent;
    base.smsSuppressed += r.smsSuppressed;
    base.skipped += r.skipped;
  }
  return base;
}
