/**
 * sms-marketing-agent — the READ-side engine of the CMO/Iris SMS Marketing Agent. Decides
 * whether "now" is a valid cadence window, and if so builds + schedules one theme's worth of
 * per-segment promotional campaigns from the DB-driven template library ([[sms_campaign_templates]]),
 * gated by the bounded proxy in [[sms_marketing_policy]] and supervised by Iris via
 * [[director_activity]]. The CMO-side mirror of src/lib/storefront/optimizer-agent.ts.
 *
 * North star (CLAUDE.md § North star): this agent optimizes a BOUNDED proxy (attributed
 * revenue-per-send, within the policy's weekly cap + segment scope + send windows). Iris owns
 * the objective (owned-channel revenue) and supervises. Every rail (dormant policy, weekly cap,
 * stale segments, no coupon configured) ⇒ SKIP + record the reason, never guess-and-execute.
 *
 * The engine is READ-ONLY over the policy (authoring lives in [[sms-marketing-policy-authoring]]).
 * It writes only sms_campaigns (the campaigns it schedules) + director_activity (its reasoning).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { recordDirectorActivity } from "@/lib/director-activity";

const WORKSPACE_TZ = "America/Chicago"; // the workspace's primary tz for "which calendar day is it"
const PERSONAL_LINK_LEN = 31;           // rendered length of superfd.co/{slug}/{short_code}
const SMS_SEGMENT_LIMIT = 160;          // GSM-7 single-segment cap
const FRESHNESS_WINDOW_MS = 26 * 60 * 60 * 1000; // segments must be refreshed within 26h
const FRESHNESS_MIN_COVERAGE = 0.8;     // ≥80% of the subscribable book must be fresh, else escalate
const STOREFRONT_ORIGIN = "https://superfoodscompany.com";

export interface SmsSendWindow { weekday: number; hour: number; theme: string }
export interface SmsThemeOffer { code: string; collection: string; discount_label: string }
export interface SmsMarketingPolicy {
  workspace_id: string;
  active: boolean;
  weekly_send_cap: number;
  min_days_between_sends: number;
  send_windows: SmsSendWindow[];
  segment_scope: string[];
  theme_config: Record<string, SmsThemeOffer>;
}
export interface SmsTemplate { theme: string; segment: string; hook: string; cta: string; signoff: string }

type Admin = ReturnType<typeof createAdminClient>;

/** Central-time calendar parts for a given instant — weekday (0=Sun) + YYYY-MM-DD, computed in
 *  the workspace tz so "today" and the send_date match how recipients experience the day. */
export function centralDay(now: Date): { weekday: number; dateStr: string } {
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: WORKSPACE_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now); // en-CA → YYYY-MM-DD
  // Anchor the calendar date at noon UTC to read its weekday without tz drift.
  const weekday = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return { weekday, dateStr };
}

function daysBetween(aDateStr: string, bDateStr: string): number {
  const a = new Date(`${aDateStr}T12:00:00Z`).getTime();
  const b = new Date(`${bDateStr}T12:00:00Z`).getTime();
  return Math.round(Math.abs(a - b) / 86_400_000);
}

/** Monday-of-week (ISO) date string for the given Central date. */
function isoWeekStart(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun
  const backToMon = (dow + 6) % 7; // Mon=0 offset
  d.setUTCDate(d.getUTCDate() - backToMon);
  return d.toISOString().slice(0, 10);
}

export type SendGateDecision =
  | { send: false; reason: string }
  | { send: true; theme: string; hour: number; dateStr: string };

/**
 * Pure cadence decision — is `now` a valid window to send, given the policy + the agent's recent
 * send days? Exported for unit testing. Enforces (in order): active → today has a window →
 * weekly cap not hit → min-gap since last send → theme has coupon wiring. Any failure is a rail.
 */
export function evaluateSendGate(
  policy: SmsMarketingPolicy,
  now: Date,
  recentAgentSendDates: string[],
): SendGateDecision {
  if (!policy.active) return { send: false, reason: "policy dormant (active=false)" };
  const { weekday, dateStr } = centralDay(now);
  const windows = Array.isArray(policy.send_windows) ? policy.send_windows : [];
  const match = windows.find((w) => w.weekday === weekday);
  if (!match) return { send: false, reason: `no send window on weekday ${weekday}` };

  const weekStart = isoWeekStart(dateStr);
  const thisWeek = [...new Set(recentAgentSendDates)].filter((d) => d >= weekStart && d <= dateStr);
  if (thisWeek.length >= policy.weekly_send_cap) {
    return { send: false, reason: `weekly cap reached (${thisWeek.length}/${policy.weekly_send_cap})` };
  }
  if (thisWeek.includes(dateStr)) return { send: false, reason: "already sent today" };

  const lastSend = [...recentAgentSendDates].sort().reverse()[0];
  if (lastSend && daysBetween(lastSend, dateStr) < policy.min_days_between_sends) {
    return { send: false, reason: `min gap not met (last send ${lastSend}, need ${policy.min_days_between_sends}d)` };
  }

  const offer = policy.theme_config?.[match.theme];
  if (!offer?.code || !offer?.collection) {
    return { send: false, reason: `theme '${match.theme}' has no coupon/collection configured (rail — escalate)` };
  }
  return { send: true, theme: match.theme, hour: match.hour, dateStr };
}

export function composeBody(t: { hook: string; cta: string; signoff: string }): string {
  return `${t.hook}\n\n${t.cta}\n{shortlink}\n\n${t.signoff}`;
}
export function renderedLength(body: string): number {
  return body.length - "{shortlink}".length + PERSONAL_LINK_LEN;
}
export function isGsm7(s: string): boolean {
  return !/[^\x00-\x7F]/.test(s);
}

export async function loadSmsPolicy(admin: Admin, workspaceId: string): Promise<SmsMarketingPolicy | null> {
  const { data } = await admin
    .from("sms_marketing_policy")
    .select("workspace_id, active, weekly_send_cap, min_days_between_sends, send_windows, segment_scope, theme_config")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return (data as SmsMarketingPolicy | null) ?? null;
}

/** The segment-freshness RAIL. Returns ok=false (escalate, don't send) when the segment book
 *  isn't fresh enough — the SUMMERFIT staleness lesson + the known refresh regression
 *  (docs/brain/inngest/refresh-customer-segments.md). */
async function checkSegmentFreshness(admin: Admin, workspaceId: string): Promise<{ ok: boolean; detail: string }> {
  const base = () => admin
    .from("customers")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("sms_marketing_status", "subscribed")
    .not("phone", "is", null)
    .or("phone_status.is.null,phone_status.eq.good");
  const { count: total } = await base();
  if (!total) return { ok: false, detail: "no subscribable customers" };
  const since = new Date(Date.now() - FRESHNESS_WINDOW_MS).toISOString();
  const { count: fresh } = await base().gte("segments_refreshed_at", since);
  const coverage = (fresh || 0) / total;
  if (coverage < FRESHNESS_MIN_COVERAGE) {
    return { ok: false, detail: `segments stale: ${Math.round(coverage * 100)}% fresh (<${FRESHNESS_MIN_COVERAGE * 100}%) — refresh before sending` };
  }
  return { ok: true, detail: `${Math.round(coverage * 100)}% of the book refreshed within 26h` };
}

export interface AgentRunResult {
  status: "sent" | "skipped";
  theme?: string;
  reason?: string;
  campaigns: Array<{ id: string; segment: string; chars: number }>;
  skippedSegments: Array<{ segment: string; reason: string }>;
}

/**
 * One autonomous run for a workspace. Loads the policy, evaluates the cadence gate + freshness
 * rail, and — only if both pass — builds + schedules one theme's per-segment campaigns, tagging
 * them source='sms-agent'. Records a director_activity row for Iris either way (a skip logs its
 * reason; a send logs what + why). NEVER throws — returns a structured result the cron logs.
 */
export async function runSmsMarketingAgent(workspaceId: string, now = new Date()): Promise<AgentRunResult> {
  const admin = createAdminClient();
  const empty: AgentRunResult = { status: "skipped", campaigns: [], skippedSegments: [] };

  const policy = await loadSmsPolicy(admin, workspaceId);
  if (!policy) return { ...empty, reason: "no policy row" };

  // Recent agent send days (last 14d) for the cap + gap checks.
  const fourteenAgo = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const { data: recent } = await admin
    .from("sms_campaigns")
    .select("send_date")
    .eq("workspace_id", workspaceId)
    .eq("source", "sms-agent")
    .gte("send_date", fourteenAgo);
  const recentDates = [...new Set((recent || []).map((r) => r.send_date as string))];

  const gate = evaluateSendGate(policy, now, recentDates);
  if (!gate.send) {
    // Only surface a director_activity line for MEANINGFUL skips (a rail hit), not the daily
    // "no window today" no-op — otherwise the recap floods.
    if (!/no send window/.test(gate.reason) && !/dormant/.test(gate.reason)) {
      await recordDirectorActivity(admin, {
        workspaceId, directorFunction: "cmo", actionKind: "sms_send_skipped",
        reason: `SMS agent skipped a send: ${gate.reason}`, metadata: { reason: gate.reason },
      });
    }
    return { ...empty, reason: gate.reason };
  }

  // Freshness rail — escalate, don't send on a stale book.
  const fresh = await checkSegmentFreshness(admin, workspaceId);
  if (!fresh.ok) {
    await recordDirectorActivity(admin, {
      workspaceId, directorFunction: "cmo", actionKind: "sms_send_blocked_stale_segments",
      reason: `SMS agent BLOCKED a ${gate.theme} send — ${fresh.detail}. Escalating instead of texting a stale audience.`,
      metadata: { theme: gate.theme, detail: fresh.detail },
    });
    return { ...empty, theme: gate.theme, reason: `stale segments: ${fresh.detail}` };
  }

  const offer = policy.theme_config[gate.theme];
  const target = `${STOREFRONT_ORIGIN}/discount/${offer.code}?redirect=/collections/${offer.collection}`;

  // Load the theme's templates once (+ fallback '*').
  const { data: tplRows } = await admin
    .from("sms_campaign_templates")
    .select("theme, segment, hook, cta, signoff")
    .eq("workspace_id", workspaceId)
    .eq("theme", gate.theme)
    .eq("is_active", true);
  const templates = (tplRows || []) as SmsTemplate[];
  const bySeg = new Map(templates.map((t) => [t.segment, t]));

  const result: AgentRunResult = { status: "sent", theme: gate.theme, campaigns: [], skippedSegments: [] };
  const themeLabel = gate.theme === "vip" ? "VIP Sale" : "Weekend Sale";

  for (const segment of policy.segment_scope) {
    const tpl = bySeg.get(segment) || bySeg.get("*");
    if (!tpl) { result.skippedSegments.push({ segment, reason: "no template" }); continue; }
    const body = composeBody(tpl);
    if (!isGsm7(body)) { result.skippedSegments.push({ segment, reason: "non-GSM-7 char" }); continue; }
    if (renderedLength(body) > SMS_SEGMENT_LIMIT) {
      result.skippedSegments.push({ segment, reason: `renders ${renderedLength(body)} > 160 chars` });
      continue;
    }
    const excluded = segment === "active_sub" ? [] : ["active_sub"];

    const { data: row, error } = await admin.from("sms_campaigns").insert({
      workspace_id: workspaceId,
      name: `${themeLabel} — ${segment} (agent ${gate.dateStr})`,
      message_body: body,
      send_date: gate.dateStr,
      target_local_hour: gate.hour,
      fallback_target_local_hour: gate.hour,
      fallback_timezone: WORKSPACE_TZ,
      audience_filter: {},
      included_segments: [segment],
      excluded_segments: excluded,
      coupon_enabled: false,
      coupon_expires_days_after_send: 21,
      shortlink_target_url: target,
      source: "sms-agent",
      agent_theme: gate.theme,
      created_by: null,
    }).select("id").single();
    if (error || !row) { result.skippedSegments.push({ segment, reason: `insert failed: ${error?.message}` }); continue; }

    await inngest.send({ name: "marketing/text-campaign.scheduled", data: { campaign_id: row.id } });
    await admin.from("sms_campaigns").update({ status: "scheduled", scheduled_at: new Date().toISOString() }).eq("id", row.id);
    result.campaigns.push({ id: row.id, segment, chars: renderedLength(body) });
  }

  await recordDirectorActivity(admin, {
    workspaceId, directorFunction: "cmo", actionKind: "scheduled_sms_campaign",
    reason:
      `SMS agent scheduled a ${themeLabel} (${offer.discount_label}, code ${offer.code}) to ${result.campaigns.length} segment(s) ` +
      `for ${gate.dateStr} at ${String(gate.hour).padStart(2, "0")}:00 local. ${fresh.detail}.` +
      (result.skippedSegments.length ? ` Skipped: ${result.skippedSegments.map((s) => `${s.segment}(${s.reason})`).join(", ")}.` : ""),
    metadata: {
      theme: gate.theme, offer_code: offer.code, collection: offer.collection, send_date: gate.dateStr,
      hour: gate.hour, campaigns: result.campaigns, skipped: result.skippedSegments,
    },
  });

  if (result.campaigns.length === 0) result.status = "skipped";
  return result;
}
