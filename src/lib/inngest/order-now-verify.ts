/**
 * Async-aware order-now verify — Phase 1 of docs/brain/specs/order-now-verify-async-result-then-decline-recovery-migrate-and-deterministic-retry.md
 *
 * Fired by `subscriptionOrderNowVerified` (and other order-now entry points)
 * after firing bill_now. Sleeps for the flavor-specific delay, reads the REAL
 * outcome from customer_events / subscriptions / orders, and stamps the
 * ticket_resolution_events row with the verdict:
 *
 *   - paid  → verified_outcome='confirmed'
 *   - declined → verified_outcome='drifted'  (Phase 2 hooks the recovery
 *     journey trigger onto this branch)
 *   - unknown → re-schedule one more time (attempt+1, capped at 3); the
 *     third unknown stamps 'drifted' so the ledger row terminally resolves.
 *
 * Delay picked from `is_internal`: 30s for internal (deterministic Braintree
 * pipeline, order lands quickly), 5m for Appstle (vendor is slow + can
 * decline minutes later).
 *
 * See docs/brain/libraries/order-now-verify.md.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  scheduleOrderNowVerify,
  verifyOrderNowOutcome,
  type OrderNowVerdict,
} from "@/lib/commerce/order-now-verify";

const MAX_ATTEMPTS = 3;
const APPSTLE_DELAY = "5m";
const INTERNAL_DELAY = "30s";
const NEXT_ATTEMPT_DELAY = "5m";

interface OrderNowVerifyEventData {
  workspace_id: string;
  subscription_id: string;
  contract_id: string;
  fired_at: string;
  is_internal: boolean;
  resolution_event_id: string | null;
  ticket_id: string | null;
  customer_id: string | null;
  attempt: number;
}

export const orderNowVerify = inngest.createFunction(
  {
    id: "commerce-order-now-verify",
    name: "Order-now — verify async result",
    retries: 2,
    concurrency: [{ limit: 20 }],
    triggers: [{ event: "commerce/order-now.verify" }],
  },
  async ({ event, step }) => {
    const data = event.data as OrderNowVerifyEventData;
    const attempt = data.attempt ?? 1;

    // First attempt uses the flavor-specific delay. Retries use the shorter
    // NEXT_ATTEMPT_DELAY — by then the vendor has usually finalized, we
    // just need one more read.
    const delay = attempt === 1
      ? (data.is_internal ? INTERNAL_DELAY : APPSTLE_DELAY)
      : NEXT_ATTEMPT_DELAY;

    await step.sleep(`wait-attempt-${attempt}`, delay);

    const verdict = await step.run("read-outcome", async () => {
      const admin = createAdminClient();
      const res = await verifyOrderNowOutcome(admin, {
        workspace_id: data.workspace_id,
        subscription_id: data.subscription_id,
        contract_id: data.contract_id,
        fired_at: data.fired_at,
      });
      return res.verdict;
    });

    if (verdict === "unknown" && attempt < MAX_ATTEMPTS) {
      await step.run("reschedule", async () => {
        await scheduleOrderNowVerify({
          workspace_id: data.workspace_id,
          subscription_id: data.subscription_id,
          contract_id: data.contract_id,
          fired_at: data.fired_at,
          is_internal: data.is_internal,
          resolution_event_id: data.resolution_event_id ?? undefined,
          ticket_id: data.ticket_id ?? undefined,
          customer_id: data.customer_id ?? undefined,
          attempt: attempt + 1,
        });
      });
      return { ok: true, verdict, rescheduled: true, attempt };
    }

    // Terminal verdict (paid, declined, or unknown after MAX_ATTEMPTS).
    // Unknown-terminal stamps as 'drifted' so the ledger row resolves
    // rather than staying forever pending.
    const outcomeForLedger = verdict === "paid" ? "confirmed" : "drifted";

    if (data.resolution_event_id) {
      await step.run("stamp-ledger", async () => {
        await stampResolutionOutcome(
          data.workspace_id,
          data.resolution_event_id!,
          outcomeForLedger,
        );
      });
    }

    return {
      ok: true,
      verdict,
      terminal: true,
      attempt,
      ticket_resolution_events_id: data.resolution_event_id,
    };
  },
);

/**
 * Stamp a ticket_resolution_events row's verified_at + verified_outcome.
 * Idempotent (compare-and-set on verified_at IS NULL) so a re-drive of the
 * verify event doesn't overwrite an earlier verdict. Mirrors
 * `stampResolutionVerified` in action-executor.ts.
 */
async function stampResolutionOutcome(
  workspaceId: string,
  resolutionEventId: string,
  outcome: "confirmed" | "drifted",
): Promise<void> {
  const admin = createAdminClient();
  try {
    await admin
      .from("ticket_resolution_events")
      .update({
        verified_at: new Date().toISOString(),
        verified_outcome: outcome,
      })
      .eq("id", resolutionEventId)
      .eq("workspace_id", workspaceId)
      .is("verified_at", null);
  } catch {
    // Never fail the verify path because a ledger stamp failed — the
    // return payload still carries the verdict for Control Tower.
  }
}

/**
 * Verdict a completed run resolves to — exported for callers (Phase 2/3/4)
 * that want to inspect the terminal outcome.
 */
export type OrderNowVerifyTerminalVerdict = OrderNowVerdict;
