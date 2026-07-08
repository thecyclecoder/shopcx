/**
 * Vault a Braintree nonce and (by default) migrate the customer's Appstle
 * subs to internal in one synchronous sequence — the "strangler migration"
 * step. Shared by:
 *
 * - src/lib/portal/handlers/payment-method-update.ts (portal "add a card" +
 *   recover / failed-payment magic-link flows)
 * - src/app/api/journey/[token]/submit-payment/route.ts (the add_payment_method
 *   mini-site journey — Phase 2 of spec-add-payment-method-journey.md)
 *
 * Migration ordering = Option A migrate-first (per spec § Phase 2): vault →
 * save → migrate → return. The customer is fully on internal billing before
 * the caller signals done. Migration runs SYNCHRONOUSLY inside this call.
 *
 * Failure behavior:
 *   - Vault failure → throws. Callers decide (portal → 502 to client; journey
 *     → keep session in_progress, show retry, NEVER signal completion).
 *   - Migration failure → logged (mig.failed) but NOT re-thrown; the vault
 *     succeeded and we don't want to lose the card because one sub couldn't
 *     migrate. Matches the portal handler's original behavior.
 *
 * The Braintree-customer resolution mirrors the portal handler exactly: prefer
 * an existing customer_payment_methods.braintree_customer_id, else resolve-or-
 * create via resolveBraintreeCustomerId (the same helper checkout uses).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  vaultPaymentMethod,
  savePaymentMethod,
  resolveBraintreeCustomerId,
  type VaultResult,
} from "@/lib/integrations/braintree-customer";
import { migrateCustomerAppstleSubsToInternal } from "@/lib/migrate-to-internal";
import {
  dispatchOrderNowRetryOnMigrate,
  defaultOrderNowRetryDeps,
  subscriptionOrderNowVerified,
  type OrderNowRetryOutcome,
} from "@/lib/commerce/order-now-verify";

export interface VaultAndMigrateInput {
  workspaceId: string;
  customerId: string;
  customerEmail: string;
  customerFirstName?: string | null;
  customerLastName?: string | null;
  paymentMethodNonce: string;
  deviceData?: string;
  /** default true — makes the vaulted card the customer's default. */
  makeDefault?: boolean;
  /** default true — sweeps Appstle subs to internal after the save. */
  migrate?: boolean;
  /** forwarded to migrateCustomerAppstleSubsToInternal — flags this as a failed-payment recovery. */
  isRecovery?: boolean;
  /** default = `isRecovery` — when the migrate is a recovery (the customer
   *  came in from the update-payment-method journey after an order-now
   *  decline), retry order-now DETERMINISTICALLY on each migrated internal
   *  sub. Phase 3 of order-now-verify-async-result-then-decline-recovery-
   *  migrate-and-deterministic-retry. Set false to opt out (e.g. checkout
   *  auto-migrate where the order is already being charged). */
  retryOrderNowOnMigrate?: boolean;
}

export interface VaultAndMigrateResult {
  paymentMethodId: string;
  braintreeCustomerId: string;
  vaulted: VaultResult;
  migratedCount: number;
  /** Phase 3: one entry per migrated sub the recovery flow retried
   *  order-now on (empty when retryOrderNowOnMigrate is false OR no subs
   *  actually migrated). Callers surface this in logs; the ledger stamp
   *  itself is driven by the async verify. */
  orderNowRetries: OrderNowRetryOutcome[];
}

export async function vaultAndMigratePaymentMethod(
  input: VaultAndMigrateInput,
): Promise<VaultAndMigrateResult> {
  const admin = createAdminClient();
  const makeDefault = input.makeDefault !== false;
  const doMigrate = input.migrate !== false;

  // Resolve the Braintree customer id. Prefer an existing PM row; for a
  // FIRST-card customer there's none, so resolve-or-create.
  const { data: existingPm } = await admin
    .from("customer_payment_methods")
    .select("braintree_customer_id")
    .eq("workspace_id", input.workspaceId)
    .eq("customer_id", input.customerId)
    .not("braintree_customer_id", "is", null)
    .limit(1)
    .maybeSingle();

  let braintreeCustomerId = (existingPm?.braintree_customer_id as string | undefined) || undefined;
  if (!braintreeCustomerId) {
    braintreeCustomerId = (await resolveBraintreeCustomerId({
      workspaceId: input.workspaceId,
      customerId: input.customerId,
      email: input.customerEmail,
      firstName: input.customerFirstName || undefined,
      lastName: input.customerLastName || undefined,
    })) || undefined;
  }
  if (!braintreeCustomerId) throw new Error("no_braintree_customer");

  const vaulted = await vaultPaymentMethod(
    input.workspaceId,
    braintreeCustomerId,
    input.paymentMethodNonce,
    input.deviceData,
  );

  const saved = await savePaymentMethod({
    workspaceId: input.workspaceId,
    customerId: input.customerId,
    braintreeCustomerId,
    braintreePaymentMethodToken: vaulted.token,
    paymentType: vaulted.paymentType,
    cardBrand: vaulted.cardBrand,
    last4: vaulted.last4,
    expirationMonth: vaulted.expirationMonth,
    expirationYear: vaulted.expirationYear,
    makeDefault,
  });

  let migratedCount = 0;
  let migrated: Array<{ contractId: string; subId: string; billableCustomerId: string }> = [];
  if (doMigrate) {
    try {
      const mig = await migrateCustomerAppstleSubsToInternal(
        input.workspaceId,
        input.customerId,
        { isRecovery: !!input.isRecovery },
      );
      migratedCount = mig.migrated.length;
      migrated = mig.migrated;
      if (mig.failed.length) {
        console.error("[vault-and-migrate] migration failures:", mig.failed);
      }
    } catch (e) {
      // Non-fatal: vault + save succeeded, don't lose the card because a sub
      // couldn't migrate. Matches the portal handler's original behavior.
      console.error("[vault-and-migrate] migration threw (non-fatal):", e instanceof Error ? e.message : e);
    }
  }

  // Phase 3: order-now deterministic retry on the migrated internal subs. The
  // journey completing means the customer just fixed their card — retry the
  // original bill_now on the (now internal) sub so the order they were
  // told-was-coming actually lands, without waiting for the next scheduled
  // renewal. Idempotent — subscriptionOrderNowVerified fires an
  // internal-subscription/renewal-attempt Inngest event AND the retry
  // dispatcher's guard predicate (commerce.order_now.retry_after_migrate
  // customer_events row since migrated_at) blocks a double-charge on a
  // re-drive of vaultAndMigratePaymentMethod.
  const orderNowRetries: OrderNowRetryOutcome[] = [];
  const doRetry = (input.retryOrderNowOnMigrate ?? !!input.isRecovery) && migrated.length > 0;
  if (doRetry) {
    const migratedAt = new Date().toISOString();
    for (const m of migrated) {
      // Look up the sub's post-migration shopify_contract_id (now internal).
      const { data: subRow } = await admin
        .from("subscriptions")
        .select("shopify_contract_id")
        .eq("id", m.subId)
        .eq("workspace_id", input.workspaceId)
        .maybeSingle();
      const contractId = (subRow?.shopify_contract_id as string | null) || null;
      if (!contractId) continue;
      try {
        // Wire the retry to the async-verify pipeline explicitly — the
        // `fireVerifiedOrderNow` slot is subscriptionOrderNowVerified, which
        // (a) fires subscriptionOrderNow → for the migrated internal sub =
        // the `internal-subscription/renewal-attempt` Inngest event (real
        // Braintree charge + paid order), and (b) schedules the Phase 1
        // async verify so the ledger stamps against a real paid order.
        const retryDeps = {
          ...defaultOrderNowRetryDeps(),
          fireVerifiedOrderNow: (
            workspace_id: string,
            contract_id: string,
            ctx: Parameters<typeof subscriptionOrderNowVerified>[2],
          ) => subscriptionOrderNowVerified(workspace_id, contract_id, ctx),
        };
        const outcome = await dispatchOrderNowRetryOnMigrate(
          {
            workspace_id: input.workspaceId,
            customer_id: input.customerId,
            subscription_id: m.subId,
            contract_id: contractId,
            migrated_at: migratedAt,
          },
          retryDeps,
        );
        orderNowRetries.push(outcome);
      } catch (e) {
        console.error(
          `[vault-and-migrate] order-now retry threw (non-fatal) for sub ${m.subId}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  return {
    paymentMethodId: saved.id,
    braintreeCustomerId,
    vaulted,
    migratedCount,
    orderNowRetries,
  };
}
