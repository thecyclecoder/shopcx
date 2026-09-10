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
  claimCycleCharge,
  resolveCycleCharge,
} from "@/lib/subscription-cycle-charge-claim";
import {
  getSubscriptionContract,
  getUpcomingBillingCycles,
  getBillingCycleForDate,
  shopifyAttemptBilling,
  awaitBillingAttempt,
} from "@/lib/commerce/shopify-subscription-client";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";
import { errText } from "@/lib/error-text";

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
        produced: { due: due.length, muted_null_billing_date: muted },
      }),
    );

    return { due: due.length, muted };
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
    const { subscription_id, workspace_id, expected_next_billing_date } = event.data as {
      subscription_id: string; workspace_id: string; expected_next_billing_date: string | null;
    };
    const admin = createAdminClient();

    // 1. Stale guard — re-read live. If the date moved since fan-out, another attempt already
    //    handled this cycle; charging again would bill twice and reopen dunning.
    const sub = await step.run("load-subscription", async () => {
      const { data } = await admin
        .from("subscriptions")
        .select("id, workspace_id, shopify_contract_id, status, next_billing_date, billing_source, customer_id, shopify_customer_id")
        .eq("id", subscription_id)
        .maybeSingle();
      return data as {
        id: string; workspace_id: string; shopify_contract_id: string; status: string;
        next_billing_date: string | null; billing_source: string; customer_id: string | null;
        shopify_customer_id: string | null;
      } | null;
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
      return { status: "skipped", reason: "stale_next_billing_date" };
    }

    // 2. Ask SHOPIFY what is actually due. Our date only chose the candidate.
    const plan = await step.run("resolve-due-cycle", async () => {
      const contract = await getSubscriptionContract(workspace_id, sub.shopify_contract_id);
      if (!contract.success || !contract.contract) {
        return { ok: false as const, reason: contract.error ?? "contract_unreadable" };
      }
      if (contract.contract.status !== "ACTIVE") {
        return { ok: false as const, reason: `contract_${contract.contract.status.toLowerCase()}` };
      }

      // ⭐ Target the cycle CONTAINING our billing date — do NOT hunt for a past-due cycle.
      // Shopify anchors the cycle calendar to the contract's createdAt, not to the nextBillingDate
      // we set, so a MIGRATED contract is born up to a full interval out of step (observed on
      // 35945087149: our date 2026-10-15 vs Shopify's first cycle 2026-11-05). Past-due hunting
      // finds nothing there and the customer is silently never charged.
      const due = sub.next_billing_date;
      if (!due) return { ok: false as const, reason: "no_next_billing_date" };

      // ⚠️ Shopify rejects a selector date BEFORE the contract's createdAt with
      // "Billing cycle start date out of range" — and a migrated contract is created TODAY while
      // the customer may already be overdue, so this is the normal case for anyone due on or
      // before migration day (63 such subs live right now), not an edge case. Left unhandled they
      // resolve to nothing and are silently never charged.
      // Clamping to just inside the contract's first cycle is correct: that cycle covers the
      // charge we owe, and the customer is due now.
      const created = contract.contract.createdAt ? new Date(contract.contract.createdAt).getTime() : 0;
      const selectorDate =
        created && new Date(due).getTime() < created
          ? new Date(created + 1000).toISOString()
          : due;

      const cyc = await getBillingCycleForDate(workspace_id, sub.shopify_contract_id, selectorDate);
      if (!cyc.success || !cyc.cycle) return { ok: false as const, reason: cyc.error ?? "cycle_unresolvable" };
      // BILLED is Shopify's own idempotency signal — this cycle already charged, whoever did it.
      if (cyc.cycle.status === "BILLED") return { ok: false as const, reason: "cycle_already_billed" };
      if (cyc.cycle.skipped) return { ok: false as const, reason: "cycle_skipped" };
      return { ok: true as const, cycleIndex: cyc.cycle.index, expectedDate: cyc.cycle.endAt, dueDate: selectorDate };
    });

    if (!plan.ok) {
      await step.run("beat-nodue", () => emitReactiveHeartbeat(ATTEMPT_FN_ID, { produced: { outcome: "no_cycle_due" } }));
      return { status: "skipped", reason: plan.reason };
    }

    // 3. Claim the cycle BEFORE charging. Shopify's own idempotencyKey is the second guard; this
    //    is ours, and it is what makes a retried Inngest step safe.
    const cycleKey = cycleKeyFromNextBillingDate(sub.next_billing_date);
    const claim = await step.run("claim-cycle", () =>
      claimCycleCharge(admin, {
        workspace_id,
        subscription_id: sub.id,
        cycle_key: cycleKey,
        // ⭐ EVENT-scoped, not a constant. `claimCycleCharge` treats a same-claimant collision as a
        // RESUME and returns ok:true — so a constant claimant lets a duplicate event charge again.
        // Matches internal-subscription-renewals.ts, which keys on event.id for exactly this reason.
        claimant: (event as { id?: string }).id || `sub:${sub.id}:cycle:${cycleKeyFromNextBillingDate(sub.next_billing_date)}`,
        source: "shopcx",
      }),
    );
    if (!claim.ok) {
      await step.run("beat-dupe", () => emitReactiveHeartbeat(ATTEMPT_FN_ID, { produced: { outcome: "duplicate_blocked" } }));
      return { status: "skipped", reason: "cycle_already_claimed", cycle_key: cycleKey };
    }

    // 4. Charge. Targeting the resolved cycle explicitly — omitting the selector bills Shopify's
    //    CURRENT calendar cycle, which after a migration re-anchor is usually not the one we mean.
    const charged = await step.run("attempt-billing", async () => {
      const started = await shopifyAttemptBilling(
        workspace_id,
        sub.shopify_contract_id,
        `${sub.shopify_contract_id}:${cycleKey}`,
        // Address by DATE, matching how the cycle was resolved — index is stable today but the
        // date is what our schedule actually means.
        { billingCycleSelector: { date: plan.dueDate } },
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
    //     in_flight and the date untouched so the webhook (or tomorrow's cron) settles it. Do NOT
    //     dun: the customer may yet be charged, and dunning a paying customer is worse than late.
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
        let orderUuid: string | undefined;
        const bare = charged.orderId?.replace("gid://shopify/Order/", "");
        if (bare) {
          const { data: o } = await admin
            .from("orders").select("id").eq("workspace_id", workspace_id).eq("shopify_order_id", bare).maybeSingle();
          orderUuid = (o as { id: string } | null)?.id;
        }
        return resolveCycleCharge(admin, claim.id, { status: "succeeded", order_id: orderUuid });
      });
      await step.run("advance-next-billing-date", async () => {
        const next = await getSubscriptionContract(workspace_id, sub.shopify_contract_id);
        const cycles = await getUpcomingBillingCycles(workspace_id, sub.shopify_contract_id, { first: 6 });
        // ⭐ Must be STRICTLY AFTER the cycle we just charged. `now` still sits inside that cycle,
        // so it comes back in this page — and if its status has not flipped to BILLED yet
        // (read-after-write lag) a bare `find(UNBILLED)` returns the cycle we just billed. We would
        // re-arm the same date, resolve BILLED tomorrow, and skip forever.
        const upcoming = (cycles.cycles ?? []).find(
          (c) => c.status === "UNBILLED" && !c.skipped && new Date(c.expectedDate).getTime() > new Date(plan.expectedDate).getTime(),
        );
        // ⚠️ NO fallback to contract.nextBillingDate: Shopify never advances it, so that would
        // write back the very date we just charged. Leaving the date alone is recoverable and
        // visible to the renewal-integrity assertion; silently re-arming it is neither.
        const advanceTo = upcoming?.expectedDate ?? null;
        if (!advanceTo) {
          console.error(`[shopcx-renewal] charged ${sub.shopify_contract_id} but found no cycle after ${plan.expectedDate} — date NOT advanced, needs attention`);
          return;
        }
        await admin
          .from("subscriptions")
          // `succeeded`, not "paid" — the vocabulary the rules engine and the dashboard badge use.
          .update({ next_billing_date: advanceTo, last_payment_status: "succeeded", updated_at: new Date().toISOString() })
          .eq("id", sub.id);
      });
      await step.run("beat-charged", () => emitReactiveHeartbeat(ATTEMPT_FN_ID, { produced: { outcome: "charged" } }));
      return { status: "charged", order: charged.orderName, cycle_key: cycleKey };
    }

    // 5c. Declined / not accepted — release the claim and hand to dunning.
    const failure = charged.settled ? (charged.error ?? charged.errorCode ?? "declined") : charged.error;
    await step.run("resolve-claim-failed", () =>
      resolveCycleCharge(admin, claim.id, { status: "failed" }),
    );
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
