/**
 * One-time charges against vaulted SHOPIFY payment methods.
 *
 * ⭐ Separate from [[shopify-subscription-renewals]] on purpose. It shares the Shopify mechanics
 * (build/bill/cancel a contract) but NONE of the subscription bookkeeping: no cycle-charge ledger
 * row, no `next_billing_date` to advance, and deliberately no dunning dispatch. A declined
 * one-time charge is not a subscription at risk — rotating the customer's card and emailing them
 * about a subscription they do not have would be wrong.
 *
 * The rows live in [[../tables/one_time_charges]] rather than `subscriptions` so that analytics,
 * the portal, the cancel flow, dunning and the Appstle→internal sweeps exclude them STRUCTURALLY.
 * See the migration header for why a `kind` column would have been the `is_internal = false`
 * mistake a second time.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat, emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";
import { executeOneTimeCharge, sweepOneTimeCharges } from "@/lib/commerce/shopify-one-time-charge";
import { errText } from "@/lib/error-text";

export const ONE_TIME_CHARGE_EVENT = "one-time-charge/attempt";
const CRON_FN_ID = "one-time-charge-cron";
const ATTEMPT_FN_ID = "one-time-charge-attempt";

// ─── Cron: fan out anything due ────────────────────────────────────────────────

export const oneTimeChargeCron = inngest.createFunction(
  {
    id: CRON_FN_ID,
    name: "One-time charges — fan-out",
    retries: 1,
    // Hourly, not daily: a one-time charge is usually queued in response to something a human or
    // an agent just did, so a day's latency would make the mechanism useless for its own use case.
    triggers: [{ cron: "20 * * * *" }],
  },
  async ({ step }) => {
    // ⭐ Money-moving cron ⇒ stoppable without a deploy, checked BEFORE selection so an off
    // switch costs nothing and leaves no half-fanned-out batch.
    const gate = await step.run("check-kill-switch", () => enforceSwitch(CRON_FN_ID));
    if (gate.ok === "blocked_off") {
      await step.run("beat-switched-off", () =>
        emitCronHeartbeat(CRON_FN_ID, {
          ok: true,
          produced: { due: 0, switched_off: true },
          detail: `kill switch off by ${gate.offBy} (${gate.scope})`,
        }),
      );
      return { due: 0, switched_off: true };
    }

    const due = await step.run("find-due-charges", async () => {
      const admin = createAdminClient();
      // ⚠️ Keyset-paginate. A bare select is capped at the PostgREST max-rows (1000) and the
      // overflow is dropped SILENTLY — here that is a charge that simply never happens.
      const all: { id: string; workspace_id: string }[] = [];
      let afterId: string | null = null;
      for (;;) {
        let q = admin
          .from("one_time_charges")
          .select("id, workspace_id")
          .eq("status", "pending")
          .lte("charge_at", new Date().toISOString())
          .order("id", { ascending: true })
          .limit(1000);
        if (afterId) q = q.gt("id", afterId);
        const { data, error } = await q;
        if (error) throw new Error(`find_due_charges_failed: ${error.message}`);
        const batch = (data ?? []) as { id: string; workspace_id: string }[];
        all.push(...batch);
        if (batch.length < 1000) break;
        afterId = batch[batch.length - 1].id;
      }
      return all;
    });

    if (due.length) {
      await step.sendEvent(
        "fan-out",
        due.map((c) => ({
          name: ONE_TIME_CHARGE_EVENT,
          data: { charge_id: c.id, workspace_id: c.workspace_id },
        })),
      );
    }

    // Reconcile crashed runs, contracts a failed cancel left live, and orders that landed after
    // their attempt settled.
    //
    // ⚠️ Scoped to workspaces with rows that NEED attention — NOT to the workspaces that happened
    // to have a due charge this tick. Those are different sets: an order lands minutes after its
    // charge settles, by which time there may be nothing due at all, and keying the sweep off
    // `due` would leave it unlinked and still classified `recurring` forever.
    const swept = await step.run("sweep", async () => {
      const admin = createAdminClient();
      const { data: needy } = await admin
        .from("one_time_charges")
        .select("workspace_id, status, order_id")
        .or("status.eq.charging,and(status.eq.charged,order_id.is.null)")
        .limit(1000);
      const workspaces = [...new Set((needy ?? []).map((r) => String(r.workspace_id)))];
      let reconciled = 0;
      let cancelled = 0;
      let linked = 0;
      for (const ws of workspaces) {
        const r = await sweepOneTimeCharges(ws);
        reconciled += r.reconciled;
        cancelled += r.cancelled;
        linked += r.linked;
      }
      return { reconciled, cancelled, linked, workspaces: workspaces.length };
    });

    await step.run("beat", () =>
      emitCronHeartbeat(CRON_FN_ID, { ok: true, produced: { due: due.length, ...swept } }),
    );
    return { due: due.length, ...swept };
  },
);

// ─── Per-charge attempt ────────────────────────────────────────────────────────

export const oneTimeChargeAttempt = inngest.createFunction(
  {
    id: ATTEMPT_FN_ID,
    name: "One-time charge — single attempt",
    // ⚠️ Retries exist for TRANSPORT faults only. `executeOneTimeCharge` releases its claim back
    // to `pending` before throwing, so a retry re-claims cleanly; a settled decline returns
    // normally and is never retried.
    retries: 2,
    concurrency: { limit: 8 },
    triggers: [{ event: ONE_TIME_CHARGE_EVENT }],
  },
  async ({ event, step }) => {
    const { charge_id, workspace_id } = event.data as { charge_id: string; workspace_id: string };

    const gate = await step.run("check-kill-switch", () => enforceSwitch(ATTEMPT_FN_ID));
    if (gate.ok === "blocked_off") {
      return { status: "skipped", reason: `switched_off_by:${gate.offBy}` };
    }

    const result = await step.run("charge", async () => {
      try {
        return await executeOneTimeCharge(workspace_id, charge_id);
      } catch (e) {
        // Transport fault — the claim is already released. Rethrow so Inngest retries rather than
        // recording a decline for a card that was never asked.
        throw new Error(errText(e));
      }
    });

    await step.run("beat", () =>
      emitReactiveHeartbeat(ATTEMPT_FN_ID, { produced: { outcome: result.status } }),
    );
    return result;
  },
);
