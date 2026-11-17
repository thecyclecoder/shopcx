/**
 * Failed-payment RECOVERY after a customer saves a new card — the one implementation for every
 * surface where a card can be fixed.
 *
 * ⭐ Why this file exists (2026-11-17). This logic lived inline in the portal's `recover=1`
 * handler (src/lib/portal/handlers/payment-method-update.ts). The add_payment_method JOURNEY
 * (src/app/api/journey/[token]/submit-payment/route.ts) only vaulted + migrated, so a customer
 * who fixed their card there got the card saved and nothing else: a dunning-cancelled sub stayed
 * cancelled and the missed payment was never collected. Ground truth: a bucket-A customer from
 * the 2026-11-16 recovery-email send added a card via the journey after Sol promised to restart
 * his subscription — nothing restarted. Both surfaces now call `runPaymentRecovery`.
 *
 * What it does (moved verbatim from the portal handler):
 *  1. Reactivate subs DUNNING cancelled across the link group (keyed on an exhausted dunning
 *     cycle — never voluntary cancels).
 *  2. Pin the new card to every active/paused internal sub in the group.
 *  3. Charge NOW only subs that were failing (open dunning cycle) or just reactivated — healthy
 *     subs are not charged. The internal renewal pipeline charges → creates the order → closes
 *     the dunning cycle on success.
 *  4. Slack the team.
 * Every step is non-fatal: the card is already saved, a recovery hiccup must not lose it.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type PaymentRecoveryInput = {
  workspaceId: string;
  customer: { id: string; email: string; first_name: string | null; last_name: string | null };
  paymentMethodId: string;
  cardBrand: string | null | undefined;
  last4: string | null | undefined;
  migratedCount: number;
  /** "always" (portal recover link — the customer came to fix a failure) or "if_recovered"
   *  (journey — only DM the team when something was actually reactivated or charged). */
  notify: "always" | "if_recovered";
  logPrefix: string;
};

export type PaymentRecoveryResult = { pinnedCount: number; reactivatedCount: number; chargedCount: number };

export async function runPaymentRecovery(input: PaymentRecoveryInput): Promise<PaymentRecoveryResult> {
  const admin = createAdminClient();
  const { workspaceId, customer, logPrefix } = input;
  let pinnedCount = 0;
  let reactivatedCount = 0;
  let chargedCount = 0;

  try {
    const { linkGroupIds } = await import("@/lib/customer-links");
    const groupIds = await linkGroupIds(admin, workspaceId, customer.id);
    // Reactivate subs that DUNNING cancelled (keyed on an exhausted dunning cycle
    // — never voluntary cancels). Done before the pin query so revived subs are
    // active and get the new card pinned in the same pass.
    let reactivatedIds: string[] = [];
    try {
      const { reactivateDunningCancelledSubs } = await import("@/lib/inngest/internal-dunning");
      reactivatedIds = await reactivateDunningCancelledSubs(workspaceId, groupIds);
      reactivatedCount = reactivatedIds.length;
    } catch (e) {
      console.error(`${logPrefix} dunning reactivate failed (non-fatal):`, e instanceof Error ? e.message : e);
    }
    const { data: subs } = await admin
      .from("subscriptions")
      .select("id")
      .eq("workspace_id", workspaceId)
      .in("customer_id", groupIds)
      .eq("is_internal", true)
      .in("status", ["active", "paused"]);
    const subIds = (subs || []).map((s) => s.id as string);
    if (subIds.length) {
      await admin.from("subscriptions")
        .update({ payment_method_id: input.paymentMethodId, updated_at: new Date().toISOString() })
        .in("id", subIds);
      pinnedCount = subIds.length;
    }

    // Recover the missed payment NOW for any sub that was failing (an open dunning cycle) or
    // that we just reactivated. Healthy subs (no dunning cycle) are NOT charged.
    try {
      const { data: openCycles } = await admin
        .from("dunning_cycles")
        .select("subscription_id")
        .eq("workspace_id", workspaceId)
        .in("customer_id", groupIds)
        .in("status", ["active", "retrying", "open"]);
      const chargeSet = new Set<string>([
        ...reactivatedIds,
        ...(openCycles || []).map((c) => c.subscription_id as string).filter(Boolean),
      ]);
      // Only charge subs that are now internal + active (migrated + reactivated).
      const chargeIds = subIds.filter((id) => chargeSet.has(id)).concat(
        reactivatedIds.filter((id) => !subIds.includes(id)),
      );
      if (chargeIds.length) {
        const dedupedChargeIds = [...new Set(chargeIds)];
        // ⭐ Stamp each sub's pre-charge next_billing_date onto the event so the per-cycle claim
        // pins to the DISPATCHED cycle rather than a post-advance live read — see
        // docs/brain/specs/a-renewal-cycle-key-must-not-derive-from-a-field-the-charge-moves.md.
        const { data: chargeSubs } = await admin
          .from("subscriptions")
          .select("id, next_billing_date")
          .eq("workspace_id", workspaceId)
          .in("id", dedupedChargeIds);
        const nextBillingById = new Map<string, string | null>(
          (chargeSubs || []).map((s) => [s.id as string, (s.next_billing_date as string | null) ?? null]),
        );
        const { inngest } = await import("@/lib/inngest/client");
        for (const subscription_id of dedupedChargeIds) {
          await inngest.send({
            name: "internal-subscription/renewal-attempt",
            data: {
              workspace_id: workspaceId,
              subscription_id,
              expected_next_billing_date: nextBillingById.get(subscription_id) ?? null,
              // ⭐ Recovery charge: the renewal re-anchors next_billing_date to NOW + one interval
              // and closes the (possibly already-exhausted) dunning cycle as recovered. See
              // internal-subscription-renewals.ts § advance-next-billing-date.
              recovery: true,
            },
          });
        }
        chargedCount = dedupedChargeIds.length;
      }
    } catch (e) {
      console.error(`${logPrefix} recover immediate-charge failed (non-fatal):`, e instanceof Error ? e.message : e);
    }
  } catch (e) {
    console.error(`${logPrefix} recover pin failed (non-fatal):`, e instanceof Error ? e.message : e);
  }

  if (input.notify === "always" || reactivatedCount > 0 || chargedCount > 0) {
    try {
      const { notifyPaymentRecovered } = await import("@/lib/notify-payment-recovered");
      await notifyPaymentRecovered(workspaceId, {
        customerName: [customer.first_name, customer.last_name].filter(Boolean).join(" "),
        email: customer.email || "",
        brand: input.cardBrand as string,
        last4: input.last4 as string,
        migratedCount: input.migratedCount,
        pinnedCount,
        reactivatedCount,
      });
    } catch (e) {
      console.error(`${logPrefix} recover Slack notify failed (non-fatal):`, e instanceof Error ? e.message : e);
    }
  }

  return { pinnedCount, reactivatedCount, chargedCount };
}
