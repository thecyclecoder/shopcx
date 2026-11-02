/**
 * Renewals for subscriptions billed through OUR Shopify app (`billing_source = 'shopcx'`).
 *
 * ⭐ The premise, verified on a live contract: **Shopify fires nothing.** It stores a
 * `billingPolicy` and computes a cycle calendar, but it never charges and never advances
 * `nextBillingDate` on its own. So this cron is the thing that makes migrated subscriptions
 * earn money. If it doesn't run, they don't bill — not late, never.
 *
 * Much smaller than [[internal-subscription-renewals]] because Shopify does the downstream work:
 * a successful billing attempt CREATES the order, applies tax, and flows into our existing
 * order webhook → Amplifier path. This worker only decides WHEN to charge and handles the outcome.
 *
 * ## Two calendars, and which one is authoritative
 *
 * `subscriptions.next_billing_date` (ours) and Shopify's computed cycle schedule are INDEPENDENT
 * — observed 2026-09-09 on contract 35917070509: our field said 2027-01-15 while Shopify's next
 * unbilled cycle was 2026-11-03, and nothing reconciles them. Worse, `next_billing_date` is a
 * plain column: one stray write mutes a subscription until the date it names.
 *
 * So this worker uses ours only to pick CANDIDATES, then asks Shopify what is actually due before
 * charging. A wrong local date can therefore make a charge LATE (which the migration audit
 * catches) but can never make it WRONG. Shopify decides whether a cycle is billable; we decide
 * whether to bill it.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat, emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";
import { filterCandidatesByDunningRetryWindow } from "@/lib/inngest/internal-subscription-renewals";
import {
  cycleKeyFromNextBillingDate,
  cycleKeyFromDispatchedNextBillingDate,
  claimCycleCharge,
  resolveCycleCharge,
  listStaleInFlightClaims,
  type ResolveInput,
} from "@/lib/subscription-cycle-charge-claim";
import {
  getSubscriptionContract,
  resolveChargeableCycle,
  shopifyAttemptBilling,
  awaitBillingAttempt,
  shopifySyncBillingSchedule,
} from "@/lib/commerce/shopify-subscription-client";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";
import { rollForwardToFutureBillingDate } from "@/lib/dunning";
import { errText } from "@/lib/error-text";
import {
  checkShopcxRenewalPrice,
  surfaceRenewalPriceMismatch,
  shouldRepairUnnormalizedContract,
} from "@/lib/commerce/shopcx-renewal-price-check";

/** A cycle whose expected date has passed by less than this is still "due now", not overdue. */
const DUE_GRACE_MS = 6 * 60 * 60 * 1000;

export const RENEWAL_ATTEMPT_EVENT = "shopify-subscription/renewal-attempt";
const ATTEMPT_FN_ID = "shopify-subscription-renewal-attempt";

/**
 * ⚠️ Outcome beats go to THIS function's own reactive channel, NOT
 * `emitRenewalOutcomeHeartbeat`. That helper writes to `RENEWAL_OUTCOME_LOOP_ID`
 * (= "internal-subscription-renewal-outcome"), a single shared channel whose distribution feeds
 * the internal cron's `renewal-outcome-distribution` assertion. Mixing shopcx renewals into it
 * would skew a live assertion and manufacture false alarms. A dedicated outcome channel +
 * assertion for this path is worth adding before it runs at volume.
 */

// ─── Pending-attempt settlement ────────────────────────────────────────────────

/** `subscription_cycle_charges.source` for the renewal worker's claims. */
export const SHOPCX_RENEWAL_CLAIM_SOURCE = "shopcx";
/** `subscription_cycle_charges.source` for the portal ShopCX Order Now's claims. */
export const SHOPCX_PORTAL_CLAIM_SOURCE = "shopcx_portal_order_now";
/**
 * A pending claim is only settled once it is this old. Far beyond the worker's 30s poll plus its
 * step retries, so the settle never races a live attempt.
 */
const SETTLE_MIN_AGE_MS = 60 * 60 * 1000;

/** Pure: the Shopify idempotency key a claim's charge was sent with — see the two call sites. */
export function shopcxAttemptKeyForClaim(contractId: string, claim: { cycle_key: string; source: string | null }): string {
  return claim.source === SHOPCX_PORTAL_CLAIM_SOURCE
    ? `${contractId}:${claim.cycle_key}:portal`
    : `${contractId}:${claim.cycle_key}`;
}

export type PendingSettleVerdict = "succeeded" | "failed" | "pending" | "not_found";

/**
 * Pure: what Shopify's record of the attempt says about the claim.
 *
 * `not_found` is deliberately NOT `failed`: an attempt we cannot see may still have charged (it
 * aged out of the read window, or the read was partial), and releasing the claim would let the next
 * run charge the cycle again. It stays `in_flight` and the wedged-cycle monitor surfaces it.
 */
export function pendingSettleVerdict(read: {
  found?: boolean;
  attempt?: { success: boolean; terminal: boolean };
}): PendingSettleVerdict {
  if (!read.found || !read.attempt) return "not_found";
  if (!read.attempt.terminal) return "pending";
  return read.attempt.success ? "succeeded" : "failed";
}

type RenewalSub = {
  id: string; workspace_id: string; shopify_contract_id: string; status: string;
  next_billing_date: string | null; billing_source: string; customer_id: string | null;
  shopify_customer_id: string | null;
  billing_interval: string | null; billing_interval_count: number | null;
};

/**
 * Advance our date one cadence past a charged cycle, then re-time Shopify's display date.
 *
 * `expectCurrent` makes the write a compare-and-set on the date we read: the settle path passes it
 * so a sub something else already advanced (an Order Now) is never moved twice. Returns the new
 * date, or null when the compare-and-set lost.
 */
async function advanceAfterShopcxCharge(
  admin: ReturnType<typeof createAdminClient>,
  sub: Pick<RenewalSub, "id" | "workspace_id" | "shopify_contract_id" | "billing_interval" | "billing_interval_count">,
  scheduledFor: string,
  expectCurrent?: string,
): Promise<Date | null> {
  // ⭐ Advance by the customer's OWN cadence, anchored to the date they were DUE — never to
  // Shopify's cycle calendar.
  //
  // `billingAttemptExpectedDate` is the cycle END, so advancing to the next cycle's expected
  // date is only correct if we charged AT the previous cycle's end. A migrated contract's
  // calendar is re-anchored to its createdAt, so its first charge lands early inside cycle 1
  // and the next cycle's end is most of an extra interval away. Measured on 35945087149:
  // charged 2026-09-11, next cycle ended 2026-12-31 — a 111-day gap on a 56-day cadence,
  // i.e. roughly one whole interval of revenue deferred, per migrated subscription.
  //
  // Anchoring to the SCHEDULED date rather than to "now" also means a LATE charge (dunning
  // recovery, a retried run, or a migrated sub that was overdue on migration day) does not
  // permanently shift the customer's rhythm forward.
  //
  // We resolve cycles BY DATE, so there is no need to sit on Shopify's boundaries — the
  // selector finds whichever cycle contains whatever date we set.
  // ⭐ Anchor to what the customer was DUE, never to the clamped selector — see the two-dates
  // note where `plan` is built. `scheduledFor` is the un-clamped `next_billing_date`.
  //
  // ⚠️ Step AT LEAST one cadence. The cron charges at 10:00 UTC, but most rows carry a later
  // time of day (the checkout or Appstle time), so on the due day the anchor is still in the
  // future and a plain roll-forward is a no-op. The date then never moves, the cycle key
  // collides every morning, and the sub is never charged again. Ground truth 2026-10-09:
  // 36064133293 + 36063969453 charged at 10:00, both still dated 10-09 15:01 four days later.
  // Same defect order-now fixed on 2026-10-08 (`nextDateAfterCharge`); here we keep the DUE
  // anchor so a late charge still keeps the customer's rhythm.
  const anchor = new Date(scheduledFor);
  const advanceTo = rollForwardToFutureBillingDate(
    anchor,
    sub.billing_interval ?? "month",
    sub.billing_interval_count ?? 1,
    new Date(Math.max(Date.now(), anchor.getTime())),
  );
  let q = admin
    .from("subscriptions")
    // `succeeded`, not "paid" — the vocabulary the rules engine and the dashboard badge use.
    .update({ next_billing_date: advanceTo.toISOString(), last_payment_status: "succeeded", updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  if (expectCurrent !== undefined) q = q.eq("next_billing_date", expectCurrent);
  const { data: moved, error } = await q.select("id");
  if (error) throw new Error(`advance next_billing_date failed for ${sub.id}: ${error.message}`);
  if (expectCurrent !== undefined && !(moved?.length)) return null;

  // ⭐ ROLLING RETIME. Shopify caps `scheduleEdit` about 12 months out, so the sync done at
  // migration eventually runs out. Re-timing one cycle ahead on every charge keeps the
  // customer's Shopify-visible date correct indefinitely, for one mutation per renewal.
  //
  // ⚠️ This MUST be `shopifyRetimeContract`, not `shopifySyncBillingSchedule` alone. The
  // cycle schedule and the contract's `nextBillingDate` are INDEPENDENT — pinning cycles
  // leaves the display field on the old date, and the display field is the one the customer
  // and every Shopify surface read. Measured 2026-09-21 after the first cohort renewals:
  // 7 contracts sat exactly one interval out (28d on WEEK/4, 56d on WEEK/8, 14d on WEEK/2)
  // because the pin moved the schedule and nothing moved the date. `shopifyRetimeContract`
  // does both and then re-reads to confirm the new date did not land in a spent cycle.
  //
  // Non-fatal: the charge already succeeded and the worker resolves the cycle by index at
  // charge time, so a failed retime is display drift, never a missed renewal. The daily drift reconciler
  // catches whatever this misses.
  try {
    const { shopifyRetimeContract } = await import("@/lib/commerce/shopify-subscription-client");
    const retimed = await shopifyRetimeContract(
      sub.workspace_id, sub.shopify_contract_id, advanceTo.toISOString(),
    );
    // A refused pin is NOT a missed renewal: the next charge resolves the first unbilled cycle
    // by index (`resolveChargeableCycle`). But a refused retime writes nothing, so fall back to
    // the display-only set — the customer must still see the date we will actually bill on.
    if (!retimed.success) {
      console.warn(`[shopcx-renewal] ${sub.shopify_contract_id}: rolling pin refused (${retimed.error}) — setting display date only`);
      const { shopifySetNextBillingDate } = await import("@/lib/commerce/shopify-subscription-client");
      const shown = await shopifySetNextBillingDate(sub.workspace_id, sub.shopify_contract_id, advanceTo.toISOString());
      if (!shown.success) {
        console.error(`[shopcx-renewal] ${sub.shopify_contract_id}: display date set failed (${shown.error}) — Shopify-visible date is stale`);
      }
    }
  } catch (e) {
    console.error(`[shopcx-renewal] ${sub.shopify_contract_id}: retime threw (non-fatal):`, e instanceof Error ? e.message : e);
  }
  return advanceTo;
}

/** Our order uuid for a Shopify order gid, or undefined while the order webhook has not landed. */
async function orderUuidForShopifyOrder(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  orderGid: string | null | undefined,
): Promise<string | undefined> {
  const bare = orderGid?.replace("gid://shopify/Order/", "");
  if (!bare) return undefined;
  const { data: o } = await admin
    .from("orders").select("id").eq("workspace_id", workspaceId).eq("shopify_order_id", bare).maybeSingle();
  return (o as { id: string } | null)?.id;
}

export interface SettleDeps {
  listClaims(): Promise<Array<{ id: string; subscription_id: string; cycle_key: string; source: string | null }>>;
  loadSub(subscriptionId: string): Promise<RenewalSub | null>;
  findAttempt(workspaceId: string, contractId: string, key: string): Promise<{
    success: boolean; found?: boolean; attempt?: { success: boolean; terminal: boolean; orderId?: string };
  }>;
  resolveClaim(id: string, input: ResolveInput): Promise<{ updated: boolean }>;
  orderUuid(workspaceId: string, orderGid: string | undefined): Promise<string | undefined>;
  advance(sub: RenewalSub, scheduledFor: string, expectCurrent: string): Promise<Date | null>;
}

export type SettleCounts = Record<PendingSettleVerdict | "skipped" | "advanced", number>;

/**
 * Settle ShopCX cycle claims left `in_flight` by a pending billing attempt.
 *
 * ⭐ Without this a pending attempt wedged the sub for good. The worker (and portal Order Now)
 * leave the claim `in_flight` on a 3DS challenge or a 30s poll timeout; the billing-attempt webhook
 * only records; and `claimCycleCharge` never reclaims another claimant's `in_flight`, so every
 * later cron run refused the cycle and `guardRecentOrderNow` blocked every Order Now. A slow
 * success was never advanced (the sub was never billed again), and a later failure never reached
 * dunning.
 *
 * Each claim is settled from Shopify's OWN record of the attempt, found by the idempotency key we
 * sent (`findContractBillingAttempt`):
 *  - succeeded → advance our date (compare-and-set on the date the claim was keyed on, so an
 *    already-moved sub is never advanced twice), then resolve the claim `succeeded`;
 *  - failed → resolve the claim `failed`. That is all: the sub is still due, so the same cron run
 *    selects it, the worker reclaims the failed cycle, and Shopify replays the cached decline under
 *    the same key — the worker's own decline path then dispatches dunning, once;
 *  - still pending, or not found → left `in_flight` (never released on a guess).
 */
export async function settlePendingShopcxClaims(deps: SettleDeps): Promise<SettleCounts> {
  const counts: SettleCounts = { succeeded: 0, failed: 0, pending: 0, not_found: 0, skipped: 0, advanced: 0 };
  for (const claim of await deps.listClaims()) {
    const sub = await deps.loadSub(claim.subscription_id);
    if (!sub || sub.billing_source !== "shopcx" || !sub.shopify_contract_id) { counts.skipped++; continue; }
    const read = await deps.findAttempt(sub.workspace_id, sub.shopify_contract_id, shopcxAttemptKeyForClaim(sub.shopify_contract_id, claim));
    if (!read.success) { counts.skipped++; continue; }
    const verdict = pendingSettleVerdict(read);
    counts[verdict]++;
    if (verdict === "failed") {
      await deps.resolveClaim(claim.id, { status: "failed" });
    } else if (verdict === "succeeded") {
      // ⚠️ Advance BEFORE resolving. Resolved first, a run that dies in between leaves a `succeeded`
      // claim on an un-advanced date: the cron then claims that key every morning, finds it
      // succeeded, and skips the sub forever. This way a retry reloads the sub, sees the date
      // already moved (or the compare-and-set loses), and only resolves the claim. Only the cycle
      // this claim was keyed on is ever advanced.
      if (sub.next_billing_date && cycleKeyFromNextBillingDate(sub.next_billing_date) === claim.cycle_key) {
        if (await deps.advance(sub, sub.next_billing_date, sub.next_billing_date)) counts.advanced++;
      }
      const orderUuid = await deps.orderUuid(sub.workspace_id, read.attempt?.orderId);
      await deps.resolveClaim(claim.id, { status: "succeeded", order_id: orderUuid });
    }
  }
  return counts;
}

function liveSettleDeps(admin: ReturnType<typeof createAdminClient>, nowMs: number): SettleDeps {
  return {
    listClaims: () => listStaleInFlightClaims(admin, {
      sources: [SHOPCX_RENEWAL_CLAIM_SOURCE, SHOPCX_PORTAL_CLAIM_SOURCE],
      claimedBeforeIso: new Date(nowMs - SETTLE_MIN_AGE_MS).toISOString(),
    }),
    loadSub: async (id) => {
      const { data } = await admin
        .from("subscriptions")
        .select("id, workspace_id, shopify_contract_id, status, next_billing_date, billing_source, customer_id, shopify_customer_id, billing_interval, billing_interval_count")
        .eq("id", id)
        .maybeSingle();
      return data as RenewalSub | null;
    },
    findAttempt: async (workspaceId, contractId, key) => {
      const { findContractBillingAttempt } = await import("@/lib/commerce/shopify-subscription-client");
      return findContractBillingAttempt(workspaceId, contractId, key);
    },
    resolveClaim: (id, input) => resolveCycleCharge(admin, id, input),
    orderUuid: (workspaceId, orderGid) => orderUuidForShopifyOrder(admin, workspaceId, orderGid),
    advance: (sub, scheduledFor, expectCurrent) => advanceAfterShopcxCharge(admin, sub, scheduledFor, expectCurrent),
  };
}

// ─── Daily cron ────────────────────────────────────────────────────────────────

export const shopifySubscriptionRenewalCron = inngest.createFunction(
  {
    id: "shopify-subscription-renewal-cron",
    name: "Shopify subscription renewals — daily fan-out",
    retries: 1,
    triggers: [{ cron: "0 10 * * *" }], // 10:00 UTC — an hour after the internal cron, not concurrent
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // ⭐ A money-moving cron must be stoppable without a deploy. Checked BEFORE selection so an
    // off switch costs nothing and leaves no half-fanned-out batch.
    const gate = await step.run("check-kill-switch", () => enforceSwitch("shopify-subscription-renewal-cron"));
    if (gate.ok === "blocked_off") {
      await step.run("beat-switched-off", () =>
        emitCronHeartbeat("shopify-subscription-renewal-cron", {
          ok: true,
          produced: { due: 0, switched_off: true },
          detail: `kill switch off by ${gate.offBy} (${gate.scope})`,
        }),
      );
      return { due: 0, switched_off: true };
    }

    // Settle yesterday's pending attempts FIRST, so a claim that turned out failed is released
    // before selection and this same run retries it (see `settlePendingShopcxClaims`).
    const settled = await step.run("settle-pending-attempts", () =>
      settlePendingShopcxClaims(liveSettleDeps(admin, Date.now())),
    );

    const due = await step.run("find-due-subs", async () => {
      const now = new Date();
      const endOfToday = new Date();
      endOfToday.setUTCHours(23, 59, 59, 999);

      // ⭐ Keyset-paginate. A bare select is capped at the PostgREST max-rows (1000) and the
      // overflow is SILENTLY dropped — and a dropped candidate here is a renewal that never
      // happens. Same trap the internal cron documents; same reason it matters more than usual.
      const all: {
        id: string; workspace_id: string; shopify_contract_id: string | null; next_billing_date: string | null;
      }[] = [];
      let afterId: string | null = null;
      for (;;) {
        let q = admin
          .from("subscriptions")
          .select("id, workspace_id, shopify_contract_id, next_billing_date")
          .eq("billing_source", "shopcx")
          .eq("status", "active")
          // A shopcx sub with no contract id would build `gid://…/null` and skip silently forever.
          .not("shopify_contract_id", "is", null)
          .lte("next_billing_date", endOfToday.toISOString())
          .order("id", { ascending: true })
          .limit(1000);
        if (afterId) q = q.gt("id", afterId);
        const { data, error } = await q;
        // ⚠️ NEVER swallow this. A PostgREST error mid-loop reads as "no more rows", the loop
        // breaks, those subs are simply not billed, and the heartbeat reports a smaller `due` as if
        // healthy. On a path where nothing else bills these subs, a green outage is the worst
        // possible failure — fail loud.
        if (error) throw new Error(`due-sub selection failed: ${error.message}`);
        if (!data?.length) break;

        // Don't re-charge a sub whose dunning cycle says the next retry is still in the future.
        const pageIds = data.map((s) => s.id);
        const { data: cycles } = await admin
          .from("dunning_cycles")
          .select("subscription_id, next_retry_at")
          .in("subscription_id", pageIds)
          // ⚠️ `rotating` is the status createDunningCycle INSERTS with, and it carries a NULL
          // next_retry_at — so filtering on ["retrying","active"] + next_retry_at NOT NULL missed a
          // freshly-opened cycle entirely, and the cron re-selected the sub every morning during
          // the whole card-rotation phase. Match getActiveDunningCycle's open set instead.
          .in("status", ["active", "rotating", "retrying", "skipped", "paused"]);
        all.push(...filterCandidatesByDunningRetryWindow(data, cycles ?? [], now));

        if (data.length < 1000) break;
        afterId = data[data.length - 1].id;
      }
      return all;
    });

    if (due.length > 0) {
      // `expected_next_billing_date` lets the per-sub handler detect that something else already
      // advanced this cycle and skip instead of double-charging.
      await step.sendEvent(
        "renewal-events",
        due.map((s) => ({
          name: RENEWAL_ATTEMPT_EVENT,
          data: {
            subscription_id: s.id,
            workspace_id: s.workspace_id,
            expected_next_billing_date: s.next_billing_date,
          },
        })),
      );
    }

    // ⭐ Count the MUTED as well as the due. `.lte("next_billing_date", ...)` excludes NULLs, so a
    // shopcx sub with no billing date is never selected and never alerted on — the most complete
    // mute there is, and a bare `due` count cannot tell "nobody due" from "N subs invisible".
    const muted = await step.run("count-muted", async () => {
      const { count } = await admin
        .from("subscriptions").select("id", { count: "exact", head: true })
        .eq("billing_source", "shopcx").eq("status", "active").is("next_billing_date", null);
      return count ?? 0;
    });

    await step.run("emit-heartbeat", () =>
      emitCronHeartbeat("shopify-subscription-renewal-cron", {
        // ⭐ Count on the beat, never a bare ok. A cron that "succeeded" having selected ZERO subs
        // looks identical to a healthy quiet day — that is exactly how the close snapshots went a
        // month unwritten behind a green heartbeat.
        produced: { due: due.length, muted_null_billing_date: muted, settled },
      }),
    );

    return { due: due.length, muted, settled };
  },
);

// ─── Per-subscription attempt ──────────────────────────────────────────────────

export const shopifySubscriptionRenewalAttempt = inngest.createFunction(
  {
    id: "shopify-subscription-renewal-attempt",
    name: "Shopify subscription renewal — single attempt",
    retries: 2,
    concurrency: { limit: 8 },
    triggers: [{ event: RENEWAL_ATTEMPT_EVENT }],
  },
  async ({ event, step }) => {
    const { subscription_id, workspace_id, expected_next_billing_date, order_now } = event.data as {
      subscription_id: string; workspace_id: string; expected_next_billing_date: string | null;
      /** True when fired by a customer-pressed order-now (subscriptionOrderNow),
       *  not the nightly renewal cron. Drives the `nothing_due` marker on a
       *  no-chargeable-cycle / already-claimed skip so the async order-now verify
       *  reports a truthful no-op instead of looping on 'unknown' (spec:
       *  order-now verify 'nothing_due' verdict; ticket dd5e2ba0). */
      order_now?: boolean;
    };
    const admin = createAdminClient();

    // 1. Stale guard — re-read live. If the date moved since fan-out, another attempt already
    //    handled this cycle; charging again would bill twice and reopen dunning.
    const sub = await step.run("load-subscription", async () => {
      const { data } = await admin
        .from("subscriptions")
        .select("id, workspace_id, shopify_contract_id, status, next_billing_date, billing_source, customer_id, shopify_customer_id, billing_interval, billing_interval_count")
        .eq("id", subscription_id)
        .maybeSingle();
      return data as RenewalSub | null;
    });

    const gate = await step.run("check-kill-switch", () => enforceSwitch(ATTEMPT_FN_ID));
    if (gate.ok === "blocked_off") {
      return { status: "skipped", reason: `switched_off_by:${gate.offBy}` };
    }

    if (!sub) return { status: "skipped", reason: "subscription_gone" };
    if (sub.billing_source !== "shopcx") return { status: "skipped", reason: "not_shopcx_billed" };
    if (sub.status !== "active") return { status: "skipped", reason: `sub_${sub.status}` };
    if (expected_next_billing_date && sub.next_billing_date !== expected_next_billing_date) {
      await step.run("beat-stale", () => emitReactiveHeartbeat(ATTEMPT_FN_ID, { produced: { outcome: "stale_skip" } }));
      // An order-now whose cycle the cron (or another press) already charged is a truthful no-op.
      if (order_now) {
        await step.run("log-order-now-nothing-due", async () => {
          const { logOrderNowNothingDue } = await import("@/lib/commerce/order-now-verify");
          await logOrderNowNothingDue({
            workspace_id,
            customer_id: sub.customer_id,
            subscription_id,
            contract_id: sub.shopify_contract_id,
            next_billing_date: sub.next_billing_date,
            reason: "stale_next_billing_date",
            billing_source: "shopcx",
          });
        });
      }
      return { status: "skipped", reason: "stale_next_billing_date" };
    }

    // ⭐ The claim key comes from the DISPATCHED date, never a live read. A successful charge
    // advances `next_billing_date`, so an order-now that loaded the sub seconds after the cron
    // charged it derived the NEXT cycle's key, claimed it cleanly, and charged again — the same
    // shape as the internal double charge on sub e9b8a6d9. Both dispatchers (the cron fan-out and
    // `subscriptionOrderNow`) stamp it; an event without one is refused, never keyed off live state.
    // See docs/brain/specs/a-renewal-cycle-key-must-not-derive-from-a-field-the-charge-moves.md.
    const cycleKey = cycleKeyFromDispatchedNextBillingDate(expected_next_billing_date);
    if (!cycleKey) {
      await step.run("beat-missing-cycle", () => emitReactiveHeartbeat(ATTEMPT_FN_ID, { produced: { outcome: "missing_dispatched_cycle" } }));
      return { status: "skipped", reason: "missing_dispatched_cycle" };
    }

    // 2. Resolve the cycle to bill AT CHARGE TIME — the first non-skipped UNBILLED cycle by index,
    //    NOT the cycle that contains our date. Our DB row only PLANS the date; Shopify's billing
    //    calendar is resolved here, when we charge. A date that lands inside an already-BILLED cycle
    //    used to strand the sub forever (we skipped on BILLED and nothing ever advanced it); by
    //    index, the first unbilled cycle is always billable. `scheduledFor` stays the un-clamped
    //    `next_billing_date` — the only valid anchor for advancing the customer's anniversary.
    const plan = await step.run("resolve-chargeable-cycle", async () => {
      const contract = await getSubscriptionContract(workspace_id, sub.shopify_contract_id);
      if (!contract.success || !contract.contract) {
        return { ok: false as const, reason: contract.error ?? "contract_unreadable" };
      }
      if (contract.contract.status !== "ACTIVE") {
        return { ok: false as const, reason: `contract_${contract.contract.status.toLowerCase()}` };
      }

      const due = sub.next_billing_date;
      if (!due) return { ok: false as const, reason: "no_next_billing_date" };

      const resolved = await resolveChargeableCycle(workspace_id, sub.shopify_contract_id, new Date());
      if (!resolved.success || resolved.index == null || !resolved.originTime) {
        return { ok: false as const, reason: resolved.error ?? "cycle_unresolvable" };
      }
      return {
        ok: true as const,
        cycleIndex: resolved.index,
        originTime: resolved.originTime,
        scheduledFor: due,
      };
    });

    if (!plan.ok) {
      await step.run("beat-nodue", () => emitReactiveHeartbeat(ATTEMPT_FN_ID, { produced: { outcome: "no_cycle_due" } }));
      // A customer-pressed order-now with no chargeable cycle resolvable (the
      // current cycle already billed, the next is not yet due) is a truthful
      // no-op — surface the `nothing_due` marker the async order-now verify reads
      // so the ticket confirms "no charge; next order <date>" instead of looping
      // on 'unknown' (spec: order-now verify 'nothing_due' verdict; ticket dd5e2ba0).
      if (order_now) {
        await step.run("log-order-now-nothing-due", async () => {
          const { logOrderNowNothingDue } = await import("@/lib/commerce/order-now-verify");
          await logOrderNowNothingDue({
            workspace_id,
            customer_id: sub.customer_id,
            subscription_id,
            contract_id: sub.shopify_contract_id,
            next_billing_date: sub.next_billing_date,
            reason: `no_cycle_due:${plan.reason}`,
            billing_source: "shopcx",
          });
        });
      }
      return { status: "skipped", reason: plan.reason };
    }

    // 3. Claim the cycle BEFORE charging. Shopify's own idempotencyKey is the second guard; this
    //    is ours, and it is what makes a retried Inngest step safe.
    const claim = await step.run("claim-cycle", () =>
      claimCycleCharge(admin, {
        workspace_id,
        subscription_id: sub.id,
        cycle_key: cycleKey,
        // ⭐ EVENT-scoped, not a constant. `claimCycleCharge` treats a same-claimant collision as a
        // RESUME and returns ok:true — so a constant claimant lets a duplicate event charge again.
        // Matches internal-subscription-renewals.ts, which keys on event.id for exactly this reason.
        claimant: (event as { id?: string }).id || `sub:${sub.id}:cycle:${cycleKey}`,
        source: SHOPCX_RENEWAL_CLAIM_SOURCE,
      }),
    );
    if (!claim.ok) {
      await step.run("beat-dupe", () => emitReactiveHeartbeat(ATTEMPT_FN_ID, { produced: { outcome: "duplicate_blocked" } }));
      // Same truthful-no-op case as the no-cycle-due branch: a customer-pressed
      // order-now hit a cycle already claimed by a real charge. Emit the marker.
      if (order_now) {
        await step.run("log-order-now-nothing-due", async () => {
          const { logOrderNowNothingDue } = await import("@/lib/commerce/order-now-verify");
          await logOrderNowNothingDue({
            workspace_id,
            customer_id: sub.customer_id,
            subscription_id,
            contract_id: sub.shopify_contract_id,
            next_billing_date: sub.next_billing_date,
            reason: "cycle_already_claimed",
            billing_source: "shopcx",
          });
        });
      }
      return { status: "skipped", reason: "cycle_already_claimed", cycle_key: cycleKey };
    }

    // 3b. Log-only pricing check (CEO 2026-10-10). Compares the contract against the pricing rules
    //     and files a billing_alert card on a material gap. It NEVER blocks or delays the charge
    //     below: the contract is the price, and a wrong contract is fixed at its write path.
    //     Best-effort — every helper here swallows its own errors.
    //
    //     ⭐ The one repair: a contract with NO structural allocation that would overcharge is the
    //     shape a failed ingest normalization leaves (lines at MSRP, S&S only as an inert checkout
    //     copy) — a new PDP subscriber renewing at full MSRP. The normalizer IS that write path and
    //     is idempotent, so run it here, before the charge. It can only lower the price to the rules.
    await step.run("price-check-log", async () => {
      let verdict = await checkShopcxRenewalPrice(workspace_id, sub.shopify_contract_id);
      let repaired = false;
      if (shouldRepairUnnormalizedContract(verdict)) {
        const { shopcxNormalizeNewContract } = await import("@/lib/commerce/shopcx-line-ops");
        const r = await shopcxNormalizeNewContract(workspace_id, sub.shopify_contract_id);
        if (!r.success) console.error(`[shopcx-renewal] ${sub.shopify_contract_id}: pre-charge normalize FAILED — ${r.error}`);
        repaired = r.success && (r.normalized ?? false);
        if (repaired) verdict = await checkShopcxRenewalPrice(workspace_id, sub.shopify_contract_id);
      }
      if ("lines" in verdict) {
        const alert = await surfaceRenewalPriceMismatch(admin, {
          workspaceId: workspace_id, subscriptionId: sub.id, customerId: sub.customer_id,
          contractId: sub.shopify_contract_id, cycleKey, verdict,
        });
        return { status: verdict.status, expected: verdict.expectedCents, actual: verdict.actualCents, alerted: alert.inserted, repaired };
      }
      return "reason" in verdict ? { status: "unchecked", reason: verdict.reason, repaired } : { status: "match", repaired };
    });

    // 4. Charge. Targeting the resolved cycle explicitly — omitting the selector bills Shopify's
    //    CURRENT calendar cycle, which after a migration re-anchor is usually not the one we mean.
    const charged = await step.run("attempt-billing", async () => {
      const started = await shopifyAttemptBilling(
        workspace_id,
        sub.shopify_contract_id,
        `${sub.shopify_contract_id}:${cycleKey}`,
        // Address by INDEX — the first unbilled cycle `resolveChargeableCycle` found — with an
        // `originTime` guaranteed to sit inside that cycle (Shopify rejects a future-cycle attempt
        // whose origin time is outside the selected cycle).
        { billingCycleSelector: { index: plan.cycleIndex }, originTime: plan.originTime },
      );
      if (!started.success || !started.attemptId) {
        // ⚠️ `gql` funnels transport faults (HTTP 5xx, DNS, non-JSON) into the same {success:false}
        // as a genuine userError. Treating "we could not reach Shopify" as a decline stamps the
        // cycle failed and duns a customer whose card was never asked. THROW so Inngest retries;
        // only a real userError is a decline.
        const msg = started.error ?? "attempt_not_accepted";
        if (/HTTP \d|fetch|network|ENOTFOUND|ECONNRESET|timeout|Throttled|not connected/i.test(msg)) {
          throw new Error(`transient Shopify failure, retrying: ${msg}`);
        }
        return { settled: false as const, error: msg };
      }
      const outcome = await awaitBillingAttempt(workspace_id, started.attemptId);
      return {
        settled: true as const,
        attemptId: started.attemptId,
        success: outcome.success,
        pending: outcome.pending ?? false,
        orderId: outcome.orderId ?? null,
        orderName: outcome.orderName ?? null,
        errorCode: outcome.errorCode ?? null,
        error: outcome.error ?? null,
      };
    });

    // 5a. Unresolved — 3DS or a poll timeout. NOT a failure and NOT a success. Leave the claim
    //     in_flight and the date untouched; the next cron run settles it from Shopify's record of
    //     this attempt (`settlePendingShopcxClaims`). Do NOT dun: the customer may yet be charged,
    //     and dunning a paying customer is worse than late.
    if (charged.settled && charged.pending) {
      await step.run("beat-pending", () => emitReactiveHeartbeat(ATTEMPT_FN_ID, { produced: { outcome: "pending" } }));
      return { status: "pending", attempt_id: charged.attemptId, cycle_key: cycleKey };
    }

    // 5b. Success — Shopify created the order. Advance our calendar.
    if (charged.settled && charged.success) {
      await step.run("resolve-claim-succeeded", async () => {
        // ⚠️ `subscription_cycle_charges.order_id` is a **uuid** column, but Shopify hands back a
        // GID (`gid://shopify/Order/…`). Writing it raises 22P02, `resolveCycleCharge` throws, the
        // step dies — and `advance-next-billing-date` NEVER RUNS. The customer is charged once and
        // then skipped forever, because the cycle now reads BILLED. Resolve to OUR order uuid, and
        // simply omit it when the order webhook has not landed yet: the charge is recorded either
        // way, and a missing link is repairable where a dead run is not.
        const orderUuid = await orderUuidForShopifyOrder(admin, workspace_id, charged.orderId);
        return resolveCycleCharge(admin, claim.id, { status: "succeeded", order_id: orderUuid });
      });
      await step.run("advance-next-billing-date", async () => {
        await advanceAfterShopcxCharge(admin, sub, plan.scheduledFor);
      });

      await step.run("beat-charged", () => emitReactiveHeartbeat(ATTEMPT_FN_ID, { produced: { outcome: "charged" } }));
      return { status: "charged", order: charged.orderName, cycle_key: cycleKey };
    }

    // 5c. Declined / not accepted — release the claim and hand to dunning.
    const failure = charged.settled ? (charged.error ?? charged.errorCode ?? "declined") : charged.error;
    await step.run("resolve-claim-failed", () =>
      resolveCycleCharge(admin, claim.id, { status: "failed" }),
    );

    // ⭐ Mark the ROW failed too. Only the success path wrote `last_payment_status`, so a sub whose
    // card just declined kept advertising `succeeded` from its previous cycle — on the dashboard
    // badge, the portal, and every CS surface the orchestrator reads. Measured 2026-09-21:
    // 36065771693 sat mid-dunning with a declined card and a row reading `succeeded`.
    //
    // ⚠️ `next_billing_date` is deliberately NOT touched. Dunning owns the retry schedule from
    // here and holds the date in the past ON PURPOSE so the cycle stays targetable;
    // `resetBillingDateAfterDunning` sets the real one when the cycle closes.
    await step.run("mark-row-failed", async () => {
      await admin
        .from("subscriptions")
        .update({ last_payment_status: "failed", updated_at: new Date().toISOString() })
        .eq("id", sub.id);
    });
    await step.run("dispatch-dunning", async () => {
      await inngest.send({
        // ⚠️ The topic is `dunning/payment-failed` — every other producer uses it and
        // `inngest/dunning.ts` triggers on it. A private name here means declines vanish silently:
        // no cycle, no rotation, no email, and the same idempotencyKey tomorrow so Shopify replays
        // the cached attempt instead of retrying the card.
        name: "dunning/payment-failed",
        data: {
          workspace_id,
          subscription_id: sub.id,
          shopify_contract_id: sub.shopify_contract_id,
          customer_id: sub.customer_id,
          // Without this, dunning takes its `no-customer-skip` branch and exhausts the cycle on the
          // FIRST decline with no retries at all.
          shopify_customer_id: sub.shopify_customer_id,
          error_code: charged.settled ? charged.errorCode : null,
          error_message: failure,
          billing_attempt_id: charged.settled ? charged.attemptId : null,
          source: "shopcx-renewal",
        },
      });
    });
    await step.run("beat-declined", () => emitReactiveHeartbeat(ATTEMPT_FN_ID, { produced: { outcome: "declined_to_dunning" } }));
    return { status: "declined", reason: errText(failure), cycle_key: cycleKey };
  },
);
