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
import {
  assignArm,
  getExperiment,
  isExperimentRunning,
  PRE_RENEWAL_EXPERIMENT_SLUG,
  type ExperimentArm,
} from "@/lib/subscriber-experiments";
import { resolveEffectiveSwitch } from "@/lib/control-tower/kill-switch-resolver";
import { generateJourneyToken, getJourneyUrl } from "@/lib/journey-tokens";
import { sendJourneyCTA } from "@/lib/email";
import { priceSubscription, PriceInvariantError } from "@/lib/commerce/price";
import { ensureFreshSubscriptionTaxQuote } from "@/lib/avalara-subscription";
import {
  resolveRecipientTimezone,
  computeSendInstant,
  isValidIanaTimezone,
  isWithinSmsSendWindow,
  localDateKey,
  SMS_WINDOW_START_HOUR,
  SMS_WINDOW_END_HOUR,
  type CustomerForTzResolve,
  type TimezoneSource,
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

/** Local hour the SMS targets — well inside the 9 AM-8 PM send window so quiet hours
 *  (night) are never breached. The email is transactional and sends immediately. */
export const PRE_RENEWAL_SMS_LOCAL_HOUR = 11;

/** Twilio SendAt must be >=15 min out; we keep a 16-min buffer. A target instant closer than
 *  this (or already past) rolls to 11:00 local the NEXT day — we NEVER send a reminder text
 *  without a SendAt, so a passed-slot can't fall through to an immediate (possibly night) send. */
const SMS_MIN_SCHEDULE_LEAD_MS = 16 * 60_000;

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
 * Read surface — the ledger's single read chokepoint (all `.from("pre_renewal_reminders")`
 * access lives in this module, CLAUDE.md raw-`.from` rule). The M4 results SDK
 * ([[../../docs/brain/libraries/reminder-results-sdk]]) reads send/suppression counts through here
 * rather than hand-rolling the query.
 * --------------------------------------------------------------------------------------------- */

/** One reminder-ledger row, as the results lens reads it (read-only projection). */
export interface ReminderLedgerRow {
  group_id: string;
  customer_id: string;
  experiment_arm: ExperimentArm;
  status: string;
  channels: string[] | null;
  journey_session_id: string | null;
  email_status: string | null;
  sms_status: string | null;
  sms_suppression_reason: string | null;
}

/**
 * Every reminder-ledger row for a workspace, arm-stamped — the read surface the M4 results
 * dashboard rolls up into per-arm send/suppression counts. Pure read, mutates nothing. Returns []
 * when the workspace has no reminders yet.
 */
export async function listReminderLedger(
  workspaceId: string,
  admin: Admin = createAdminClient(),
): Promise<ReminderLedgerRow[]> {
  const { data, error } = await admin
    .from("pre_renewal_reminders")
    .select(
      "group_id, customer_id, experiment_arm, status, channels, journey_session_id, email_status, sms_status, sms_suppression_reason",
    )
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`listReminderLedger(${workspaceId}): ${error.message}`);
  return (data as ReminderLedgerRow[] | null) ?? [];
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
 * Phase 2 — exact charge preview (what the renewal will bill, before billing).
 * --------------------------------------------------------------------------------------------- */

export interface ReminderChargePreviewItem {
  title: string;
  quantity: number;
}

export interface ReminderChargePreview {
  subscriptionId: string;
  /** The renewal this preview is for (YYYY-MM-DD or ISO), null if the sub has none. */
  nextBillingDate: string | null;
  /** Product items that will renew — Shipping Protection lines excluded (not products). */
  items: ReminderChargePreviewItem[];
  /** The FULL amount the renewal will charge, in cents — merchandise after discounts + shipping +
   *  protection + tax when `amountLabel` is 'total', or the pre-tax base when `amountLabel` is
   *  'plus tax'. Null when it can't be resolved at all (the reminder then omits the amount). */
  amountCents: number | null;
  /** Shipping the renewal will charge, in cents; null when not resolvable. */
  shippingCents: number | null;
  /** Tax the renewal will charge, in cents; null when it can't be quoted exactly before billing
   *  (Shopify-computed at billing for shopcx subs, or an Avalara quote that didn't resolve) — the
   *  amount is then shown 'plus tax' rather than as a bare number. */
  taxCents: number | null;
  /** 'total' ⇒ `amountCents` already includes tax (the exact charge). 'plus tax' ⇒ tax is excluded
   *  and unquotable, so the amount must render as "$X plus tax", never a bare pre-tax number. */
  amountLabel: "total" | "plus tax";
  /** True when the renewal is free (comped) — `sub.comp`, or a resolver total of 0 with every
   *  product line at $0. Copy then reads "This order is on us", never a bare "$0.00". */
  comp: boolean;
}

function isShippingProtectionTitle(title: string): boolean {
  const t = (title || "").toLowerCase();
  return t.includes("shipping protection") || t.includes("shipping insurance") || t.includes("route protection");
}

/** The full subscription row `priceSubscription` + the tax quote need to resolve a renewal charge.
 *  Matches the canonical money-resolver select ([[commerce/subscription]]), trimmed to the columns
 *  the reminder preview reads. */
const REMINDER_PREVIEW_SUB_SELECT =
  "id, items, next_billing_date, is_internal, comp, delivery_price_cents, pricing_offer_id, applied_discounts, shipping_protection_added, shipping_protection_amount_cents";

/**
 * Resolve, for ONE subscription, exactly what its next renewal will charge — the FULL amount
 * (merchandise after discounts + shipping + protection + tax), via the ONE money resolver
 * `priceSubscription` ([[commerce/price]]) for EVERY engine, so the number matches what the Portal
 * shows, with tax layered on top — never a per-engine re-implementation (CEO 2026-11-23: ShopCX
 * subs carry `price_cents` lines, so the old hand-summed `items[].price` resolved them to no amount;
 * a customer must also never see one number and be charged a higher one).
 *
 *   • Base (all engines) → `priceSubscription(workspaceId, sub).pricing.total_cents` = merch after
 *     discounts + shipping + protection, exactly as the Portal renders it. A `PriceInvariantError`
 *     (a line that can't be priced) ⇒ `amountCents: null` (omit rather than guess).
 *   • internal subs → layer the renewal path's OWN tax quote on top of that base.
 *     `ensureFreshSubscriptionTaxQuote` ([[avalara-subscription]], the same quote the internal
 *     renewal worker reads) returns `{ tax_cents }`; the full charge is `base + tax_cents`
 *     ('total'). We QUOTE only (SalesOrder, commit=false); no filing. Avalara enabled but no quote
 *     ⇒ pre-tax base labelled 'plus tax'; Avalara disabled ⇒ $0 tax so base IS the charge ('total').
 *   • shopcx subs → Shopify computes + applies tax AT billing (shopify-subscription-renewals.ts),
 *     so tax can't be quoted here: `taxCents=null`, amount shown 'plus tax' on top of the base.
 *   • comped subs (`sub.comp`, or a resolver total of 0 with every product line at $0) → the
 *     renewal is free; `comp=true`, amount 0, and copy reads "This order is on us", never "$0.00".
 *
 * Read-only (quote is non-committing).
 */
export async function reminderChargePreview(
  workspaceId: string,
  subscriptionId: string,
  admin: Admin = createAdminClient(),
): Promise<ReminderChargePreview | null> {
  const { data: sub } = await admin
    .from("subscriptions")
    .select(REMINDER_PREVIEW_SUB_SELECT)
    .eq("workspace_id", workspaceId)
    .eq("id", subscriptionId)
    .maybeSingle();
  if (!sub) return null;

  const rawItems = (Array.isArray(sub.items) ? sub.items : []) as {
    title?: string; quantity?: number; price?: string | number; price_cents?: number; variant_id?: string;
  }[];
  const productItems = rawItems.filter((i) => !isShippingProtectionTitle(i.title || ""));
  const items: ReminderChargePreviewItem[] = productItems.map((i) => ({
    title: i.title || "Item",
    quantity: i.quantity || 1,
  }));

  let amountCents: number | null = null;
  let shippingCents: number | null = null;
  let taxCents: number | null = null;
  let amountLabel: "total" | "plus tax" = "plus tax";
  let comp = !!sub.comp;

  // Base merchandise total from the ONE money resolver — the SAME number the Portal shows for every
  // engine (ShopCX lines carry `price_cents`, internal subs price live). On PriceInvariantError the
  // charge can't be stated → omit the amount rather than guess.
  let base: number | null = null;
  try {
    const { pricing } = await priceSubscription(workspaceId, sub as Record<string, unknown>);
    base = pricing.total_cents;
    shippingCents = pricing.shipping_cents;
  } catch (e) {
    if (!(e instanceof PriceInvariantError)) {
      // Any other resolver failure also means we can't state the charge exactly — omit it.
    }
    base = null;
  }

  // A resolver total of 0 with every product line at $0 is a comped renewal too (belt-and-suspenders
  // with sub.comp for free subs whose comp flag isn't set).
  if (base === 0 && productItems.length > 0 && productItems.every((i) => Number(i.price_cents ?? i.price ?? 0) === 0)) {
    comp = true;
  }

  if (comp) {
    // Free renewal — the charge is $0; copy says "This order is on us", never a bare "$0.00".
    amountCents = 0;
    taxCents = 0;
    shippingCents = shippingCents ?? 0;
    amountLabel = "total";
  } else if (base == null) {
    amountCents = null; // couldn't resolve the base → omit rather than guess
  } else if (sub.is_internal) {
    // Layer the renewal path's own tax quote (quote-only — SalesOrder, commit=false) ON TOP of the
    // resolver total, never re-deriving merchandise from the quote.
    const quote = await ensureFreshSubscriptionTaxQuote(workspaceId, sub.id).catch(() => null);
    if (quote) {
      taxCents = quote.tax_cents;
      amountCents = base + quote.tax_cents;
      amountLabel = "total";
    } else if (await isAvalaraEnabled(workspaceId, admin)) {
      // Tax applies but is unquotable here → show the base 'plus tax'.
      taxCents = null;
      amountCents = base;
      amountLabel = "plus tax";
    } else {
      // Avalara disabled ⇒ renewal charges $0 tax, so the base IS the full charge.
      taxCents = 0;
      amountCents = base;
      amountLabel = "total";
    }
  } else {
    // ShopCX-engine: Shopify applies tax at billing, so it can't be quoted exactly before the charge
    // → taxCents null, the base shown 'plus tax'.
    taxCents = null;
    amountLabel = "plus tax";
    amountCents = base;
  }

  return {
    subscriptionId: sub.id,
    nextBillingDate: sub.next_billing_date ?? null,
    items,
    amountCents,
    shippingCents,
    taxCents,
    amountLabel,
    comp,
  };
}

/** Is Avalara enabled for this workspace? When false the renewal charges $0 tax, so a pre-tax
 *  preview is the exact full charge (shown 'total'), not a 'plus tax' estimate. */
async function isAvalaraEnabled(workspaceId: string, admin: Admin): Promise<boolean> {
  const { data: ws } = await admin
    .from("workspaces")
    .select("avalara_enabled")
    .eq("id", workspaceId)
    .maybeSingle();
  return !!ws?.avalara_enabled;
}

/** Format a cents amount as `$12.34`. */
function fmtMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Render a preview's amount for customer copy: "This order is on us" for a comped (free) renewal
 *  (never a bare "$0.00"); `$X` when it already includes tax ('total'); `$X plus tax` when tax is
 *  excluded/unquotable — never a bare pre-tax number. Null when the amount couldn't be resolved
 *  (caller omits it). PURE — exported for testing. */
export function fmtPreviewAmount(p: ReminderChargePreview): string | null {
  if (p.comp) return "This order is on us";
  if (p.amountCents == null) return null;
  const money = fmtMoney(p.amountCents);
  return p.amountLabel === "plus tax" ? `${money} plus tax` : money;
}

/** Format a YYYY-MM-DD / ISO date as a short human date (e.g. "Nov 27"). */
function fmtDate(d: string | null): string {
  if (!d) return "soon";
  const dt = new Date(d.length === 10 ? `${d}T00:00:00Z` : d);
  if (Number.isNaN(dt.getTime())) return "soon";
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
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

  // The experiment status is the real on/off switch (CEO requirement): skip the whole workspace
  // unless the test is `running`. `draft` sends nothing; `stopped`/`complete` halts all reminders.
  // Cheap no-op — one experiment read, no subscription scan — and the cron still heartbeats.
  const experiment = await getExperiment(workspaceId, PRE_RENEWAL_EXPERIMENT_SLUG, admin);
  if (!isExperimentRunning(experiment)) return out;

  const groups = await scanEligibleReminders(workspaceId, now, admin);
  if (groups.length === 0) return out;

  // Workspace send context (name/color for the email, phone + marketing Messaging
  // Service for SMS). The scheduled reminder text MUST go through the marketing
  // Messaging Service so Twilio holds it until the local send window — the same
  // column marketing-text.ts reads (src/lib/inngest/marketing-text.ts ~line 457).
  const { data: ws } = await admin
    .from("workspaces")
    .select("name, help_primary_color, twilio_phone_number, twilio_marketing_messaging_service_sid")
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
  ws: {
    name?: string | null;
    help_primary_color?: string | null;
    twilio_phone_number?: string | null;
    twilio_marketing_messaging_service_sid?: string | null;
  } | null,
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

  // ── Phase 2: exact charge preview — state the renewal date, items + exact amount, from the
  // SAME pricing the renewal bills. One preview per in-window sub (group collapse shows each
  // sub's date + amount). Stamp the previewed total on the ledger so a mismatch with the actual
  // renewal charge can be audited (null when no amount resolved exactly). ──
  const previews = (await Promise.all(
    group.subscriptionIds.map((sid) => reminderChargePreview(workspaceId, sid, admin).catch(() => null)),
  )).filter((p): p is ReminderChargePreview => !!p);

  // Stamp the amount actually shown on the ledger so the audit can compare it to the real renewal
  // charge, and record whether that amount already includes tax. previewed_includes_tax is true
  // only when every resolved-amount preview is a tax-inclusive 'total'; false when any is 'plus
  // tax'; null when no amount resolved.
  const resolvedPreviews = previews.filter((p) => p.amountCents != null);
  update.previewed_amount_cents = resolvedPreviews.length
    ? resolvedPreviews.reduce((acc, p) => acc + (p.amountCents as number), 0)
    : null;
  update.previewed_includes_tax = resolvedPreviews.length
    ? resolvedPreviews.every((p) => p.amountLabel === "total")
    : null;

  const renewalLines = previews.map((p) => {
    const itemList = p.items.map((i) => (i.quantity > 1 ? `${i.quantity}x ${i.title}` : i.title)).join(", ");
    const amount = fmtPreviewAmount(p);
    const amountPart = amount ? ` — ${amount}` : "";
    return `Renews ${fmtDate(p.nextBillingDate)}: ${itemList || "your subscription"}${amountPart}`;
  });

  const leadIn = renewalLines.length
    ? `Your next order is coming up. Here's what will renew:\n${renewalLines.join("\n")}\n\nReview it — swap flavors, change quantities, update your delivery date, or adjust anything before we bill.`
    : "Your next order is coming up soon. Take a moment to review it — swap flavors, change quantities, update your delivery date, or adjust anything before we bill.";

  // Short SMS: the house block layout (hook / CTA + link / deadline) is built inside
  // maybeSendConsentedSms from the earliest in-window preview.
  const firstPreview = previews[0];

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

  // ── Phase 3: consented SMS (gated on marketing consent + the 9 AM-8 PM local window). ──
  const smsResult = await maybeSendConsentedSms(
    workspaceId,
    customer,
    token,
    firstPreview,
    now,
    ws?.twilio_marketing_messaging_service_sid ?? null,
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
 * The quiet-hours scheduling decision for a reminder text (TCPA). PURE — no I/O, exported for
 * testing. A text is only ever scheduled for an instant that is provably between 9 AM and 8 PM in
 * the recipient's VERIFIED local time; if no such instant can be guaranteed (fallback or invalid
 * timezone), the person gets no text (email only).
 */
export type SmsSendDecision =
  | {
      send: false;
      smsStatus: "suppressed_no_timezone" | "suppressed_quiet_hours";
      reason: string;
      timezone: string;
      source: TimezoneSource;
    }
  | { send: true; sendAt: Date; timezone: string; source: TimezoneSource };

/**
 * Decide IF and WHEN a reminder text may be sent to this recipient:
 *
 *   • Resolve the recipient's timezone. If the resolver fell back to the workspace default
 *     (source 'fallback') or the resolved zone is not a valid IANA name, we do NOT actually know
 *     the recipient's local time → `suppressed_no_timezone`, email only. This closes the gap where
 *     a Hawaii/Alaska customer got the Central-time 11 AM text at 7-8 AM local, and the gap where
 *     an invalid `customers.timezone` string was silently treated as UTC and sent immediately.
 *   • Otherwise target 11:00 on the recipient's LOCAL calendar date today; if that instant is
 *     already past or <16 min away, roll to 11:00 local TOMORROW (Twilio SendAt allows up to 7
 *     days). We ALWAYS return a SendAt — never an immediate, possibly-night send.
 *   • Hard guard: assert the chosen instant is inside the 9 AM-8 PM local window. 11:00 local
 *     always is, but the assert fails closed (`suppressed_quiet_hours`) against any DST / resolver
 *     edge rather than risk a quiet-hours breach.
 */
export function planReminderSmsSend(
  customer: CustomerForTzResolve | null | undefined,
  now: Date,
): SmsSendDecision {
  const tz = resolveRecipientTimezone(customer, DEFAULT_FALLBACK_TZ);

  // No verified timezone → no text. A fallback resolution means we don't know the recipient's
  // zone; an invalid IANA string can't be trusted (getTimezoneOffsetMinutes would treat it as UTC).
  if (tz.source === "fallback" || !isValidIanaTimezone(tz.timezone)) {
    return {
      send: false,
      smsStatus: "suppressed_no_timezone",
      reason:
        tz.source === "fallback"
          ? "no verified timezone (resolver fell back to workspace default) — email only"
          : `invalid timezone '${tz.timezone}' — email only`,
      timezone: tz.timezone,
      source: tz.source,
    };
  }

  // Target 11:00 on the recipient's LOCAL calendar date; roll to tomorrow if today's slot is
  // past / too close for Twilio's minimum lead. localDateKey is non-null here (zone validated above).
  const minScheduleAt = now.getTime() + SMS_MIN_SCHEDULE_LEAD_MS;
  const todayKey = localDateKey(now, tz.timezone) ?? toDateKey(now);
  let sendAt = computeSendInstant(todayKey, PRE_RENEWAL_SMS_LOCAL_HOUR, tz.timezone);
  if (sendAt.getTime() < minScheduleAt) {
    const tomorrowKey =
      localDateKey(new Date(now.getTime() + 86_400_000), tz.timezone) ?? toDateKey(new Date(now.getTime() + 86_400_000));
    sendAt = computeSendInstant(tomorrowKey, PRE_RENEWAL_SMS_LOCAL_HOUR, tz.timezone);
  }

  // Fail closed: never schedule outside 9 AM-8 PM local, whatever the computation produced.
  if (!isWithinSmsSendWindow(sendAt, tz.timezone)) {
    return {
      send: false,
      smsStatus: "suppressed_quiet_hours",
      reason: `computed send ${sendAt.toISOString()} is outside ${SMS_WINDOW_START_HOUR}:00-${SMS_WINDOW_END_HOUR}:00 local`,
      timezone: tz.timezone,
      source: tz.source,
    };
  }

  return { send: true, sendAt, timezone: tz.timezone, source: tz.source };
}

/**
 * Build the reminder SMS body in the house block layout (sms-marketing SKILL.md step 4): a short
 * hook block (what renews + when + the amount label), a blank line, a CTA label line with the link
 * on its own line in the middle, a blank line, then a short deadline line. GSM-7 only (no em
 * dashes, straight quotes). PURE — exported for testing.
 */
export function buildReminderSmsBody(
  preview: ReminderChargePreview | undefined,
  journeyUrl: string,
): string {
  const hook = (() => {
    if (!preview) return "Your next order is coming up soon.";
    const when = fmtDate(preview.nextBillingDate);
    if (preview.comp) return `Your next order renews ${when} and it is on us.`;
    const amount = fmtPreviewAmount(preview); // '$X' | '$X plus tax' | null (never comp here)
    return amount
      ? `Your next order renews ${when} for ${amount}.`
      : `Your next order renews ${when}.`;
  })();
  const deadline = preview
    ? `Make changes before ${fmtDate(preview.nextBillingDate)}.`
    : "Make changes before it renews.";

  // hook / blank / CTA label + link-on-its-own-line / blank / deadline.
  return `${hook}\n\nReview your order:\n${journeyUrl}\n\n${deadline}`;
}

/**
 * Send the reminder by SMS ONLY to a customer with live marketing consent, scheduled for their
 * local 9 AM-8 PM window. A non-consented customer, a customer who sent STOP (sms_marketing_status
 * 'unsubscribed'), a bad phone, OR a customer whose local time can't be verified gets NO text — the
 * suppression is counted on the ledger (the email still goes). Never texts a suppressed or
 * non-consented customer and never sends without a SendAt inside the window (TCPA).
 */
async function maybeSendConsentedSms(
  workspaceId: string,
  customer: SmsCustomer | null | undefined,
  token: string | null,
  preview: ReminderChargePreview | undefined,
  now: Date,
  messagingServiceSid: string | null,
): Promise<{ sent: boolean; suppressed: boolean; update: Record<string, unknown> }> {
  const update: Record<string, unknown> = {};

  // A scheduled reminder text can ONLY be held to the local send window when it goes
  // through the workspace's marketing Messaging Service — sendSMS refuses a SendAt
  // without one. If the workspace has no Messaging Service configured, send no text
  // (email still goes) and record the suppression so it's visible on the ledger.
  if (!messagingServiceSid) {
    update.sms_status = "suppressed_no_messaging_service";
    update.sms_suppression_reason = "workspace has no marketing Messaging Service — scheduled text cannot be held to the send window";
    return { sent: false, suppressed: true, update };
  }

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

  // Decide if/when the text may send — only ever an instant inside the recipient's verified
  // 9 AM-8 PM local window. Fallback / invalid timezone → no text, email only.
  const plan = planReminderSmsSend(customer, now);
  update.sms_resolved_timezone = plan.timezone;
  update.sms_timezone_source = plan.source;
  if (!plan.send) {
    update.sms_status = plan.smsStatus;
    update.sms_suppression_reason = plan.reason;
    return { sent: false, suppressed: true, update };
  }

  // Defense in depth: re-assert the window at the exact instant we'll deliver, immediately before
  // the send. If it somehow fails, suppress rather than breach quiet hours.
  if (!isWithinSmsSendWindow(plan.sendAt, plan.timezone)) {
    update.sms_status = "suppressed_quiet_hours";
    update.sms_suppression_reason = `send instant ${plan.sendAt.toISOString()} failed the window guard at dispatch`;
    return { sent: false, suppressed: true, update };
  }

  const journeyUrl = getJourneyUrl(token);
  const body = buildReminderSmsBody(preview, journeyUrl);

  try {
    // verdict.allowed guarantees a consented customer with a phone; we ALWAYS pass SendAt,
    // and ALWAYS the marketing Messaging Service (non-null here — the guard above returned
    // already if it was missing) so Twilio holds the text until plan.sendAt.
    const res = await sendSMS(workspaceId, customer!.phone!, body, {
      sendAt: plan.sendAt,
      messagingServiceSid,
    });
    if (res.success) {
      update.sms_status = "scheduled";
      update.sms_scheduled_send_at = plan.sendAt.toISOString();
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
