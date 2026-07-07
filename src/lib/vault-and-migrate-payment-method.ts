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
}

export interface VaultAndMigrateResult {
  paymentMethodId: string;
  braintreeCustomerId: string;
  vaulted: VaultResult;
  migratedCount: number;
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
  if (doMigrate) {
    try {
      const mig = await migrateCustomerAppstleSubsToInternal(
        input.workspaceId,
        input.customerId,
        { isRecovery: !!input.isRecovery },
      );
      migratedCount = mig.migrated.length;
      if (mig.failed.length) {
        console.error("[vault-and-migrate] migration failures:", mig.failed);
      }
    } catch (e) {
      // Non-fatal: vault + save succeeded, don't lose the card because a sub
      // couldn't migrate. Matches the portal handler's original behavior.
      console.error("[vault-and-migrate] migration threw (non-fatal):", e instanceof Error ? e.message : e);
    }
  }

  return {
    paymentMethodId: saved.id,
    braintreeCustomerId,
    vaulted,
    migratedCount,
  };
}
