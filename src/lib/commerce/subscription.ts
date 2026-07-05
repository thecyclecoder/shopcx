// commerce/subscription.ts — Mutation ops for subscriptions.
//
// Every subscription mutation flows through here as one canonical
// subscriptionX surface (renaming the current appstleX + subX exports).
// Each op branches on isInternalSubscription() — internal → internalSub*
// handlers; else → the existing appstleX / subX wrappers, which top-guard
// with healOnTouch and handle the Appstle boundary.
//
// Ships with zero consumers. Phase 3 flips src/lib/appstle.ts and
// src/lib/subscription-items.ts to thin @deprecated shims that call the
// exports below; M4/M5 migrates callers off the shims.
//
// See docs/brain/reference/commerce-sdk-inventory.html § Rename map for
// the full old→new pairing, and docs/brain/libraries/commerce__subscription.md
// for the surface reference.

import {
  isInternalSubscription,
  internalSubscriptionAction,
  internalSubSkipNextOrder,
  internalSubUpdateBillingInterval,
  internalSubUpdateNextBillingDate,
} from "@/lib/internal-subscription";
import {
  appstleSubscriptionAction,
  appstleSkipNextOrder,
  appstleUpdateBillingInterval,
  appstleUpdateNextBillingDate,
  appstleSwitchPaymentMethod,
  appstleSendPaymentUpdateEmail,
  appstleAddFreeProduct,
  appstleSwapProduct,
  appstleAttemptBilling,
  orderNowByContract,
} from "@/lib/appstle";
import {
  subAddItem,
  subRemoveItem,
  subChangeQuantity,
  subSwapVariant,
  subUpdateLineItemPrice,
} from "@/lib/subscription-items";

export type { SubscriptionView, SubscriptionLineView, SubscriptionPricingView } from "./types";

type OpResult = { success: boolean; error?: string };

// ── Status: pause / resume / cancel ─────────────────────────────────

export async function subscriptionAction(
  workspaceId: string,
  contractId: string,
  action: "pause" | "cancel" | "resume",
  cancelReason?: string,
  cancelledBy?: string,
): Promise<OpResult> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubscriptionAction(workspaceId, contractId, action);
  }
  return appstleSubscriptionAction(workspaceId, contractId, action, cancelReason, cancelledBy);
}

// ── Schedule ────────────────────────────────────────────────────────

export async function subscriptionSkipNextOrder(
  workspaceId: string,
  contractId: string,
): Promise<OpResult> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubSkipNextOrder(workspaceId, contractId);
  }
  return appstleSkipNextOrder(workspaceId, contractId);
}

export async function subscriptionUpdateBillingInterval(
  workspaceId: string,
  contractId: string,
  interval: "DAY" | "WEEK" | "MONTH" | "YEAR",
  intervalCount: number,
): Promise<OpResult> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubUpdateBillingInterval(workspaceId, contractId, interval, intervalCount);
  }
  return appstleUpdateBillingInterval(workspaceId, contractId, interval, intervalCount);
}

export async function subscriptionUpdateNextBillingDate(
  workspaceId: string,
  contractId: string,
  nextBillingDate: string,
): Promise<OpResult> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubUpdateNextBillingDate(workspaceId, contractId, nextBillingDate);
  }
  return appstleUpdateNextBillingDate(workspaceId, contractId, nextBillingDate);
}

// ── Payment method ──────────────────────────────────────────────────

export async function subscriptionSwitchPaymentMethod(
  workspaceId: string,
  contractId: string,
  paymentMethodId: string,
): Promise<OpResult> {
  // Internal branch is handled inside appstleSwitchPaymentMethod (Braintree
  // token → customer_payment_methods.is_default flip). Delegate to preserve
  // that path exactly; the wrapper top-guards with healOnTouch on the
  // Appstle branch.
  return appstleSwitchPaymentMethod(workspaceId, contractId, paymentMethodId);
}

export async function subscriptionSendPaymentUpdateEmail(
  workspaceId: string,
  contractId: string,
): Promise<OpResult> {
  return appstleSendPaymentUpdateEmail(workspaceId, contractId);
}

// ── Line items ──────────────────────────────────────────────────────

export async function subscriptionAddItem(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number = 1,
): Promise<OpResult> {
  return subAddItem(workspaceId, contractId, variantId, quantity);
}

export async function subscriptionRemoveItem(
  workspaceId: string,
  contractId: string,
  variantOrLine: string | { variantId?: string; lineGid?: string },
): Promise<OpResult & { alreadyAbsent?: boolean }> {
  return subRemoveItem(workspaceId, contractId, variantOrLine);
}

export async function subscriptionChangeQuantity(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number,
): Promise<OpResult> {
  return subChangeQuantity(workspaceId, contractId, variantId, quantity);
}

export async function subscriptionSwapVariant(
  workspaceId: string,
  contractId: string,
  oldVariantId: string,
  newVariantId: string,
  quantity: number = 1,
): Promise<OpResult & { newLineGid?: string }> {
  return subSwapVariant(workspaceId, contractId, oldVariantId, newVariantId, quantity);
}

export async function subscriptionUpdateLineItemPrice(
  workspaceId: string,
  contractId: string,
  variantId: string,
  basePriceCents: number,
  lineGid?: string,
): Promise<OpResult> {
  return subUpdateLineItemPrice(workspaceId, contractId, variantId, basePriceCents, lineGid);
}

// ── Free / swap product convenience wrappers ────────────────────────

export async function subscriptionAddFreeProduct(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number = 1,
): Promise<OpResult> {
  return appstleAddFreeProduct(workspaceId, contractId, variantId, quantity);
}

export async function subscriptionSwapProduct(
  workspaceId: string,
  contractId: string,
  oldVariantId: string,
  newVariantId: string,
): Promise<OpResult> {
  return appstleSwapProduct(workspaceId, contractId, oldVariantId, newVariantId);
}

// ── Billing ─────────────────────────────────────────────────────────

/**
 * Immediate billing retry against a specific Appstle billing-attempt id.
 *
 * Preserves the internal-* early return: when the caller passes a synthetic
 * `internal-<contract>` id (stamped by dunning on internal subs), the Appstle
 * PUT is skipped and success is returned — the real renewal is driven by
 * the internal daily renewal cron. See docs/brain/libraries/appstle.md § Gotchas
 * (signature vercel:cdfbac68e30a91f9).
 */
export async function subscriptionAttemptBilling(
  workspaceId: string,
  billingAttemptId: string,
): Promise<OpResult> {
  return appstleAttemptBilling(workspaceId, billingAttemptId);
}

/**
 * Flavor-aware "order now" (bill_now) for a sub identified by contract id.
 *
 * Preserves the Angel-precedent Braintree-vs-Appstle branch: internal subs
 * fire the `internal-subscription/renewal-attempt` Inngest event (async
 * Braintree charge → order → Avalara → advance next_billing_date); Appstle
 * subs go through get-upcoming → attempt-billing. See
 * docs/brain/libraries/appstle.md § orderNowByContract + § Gotchas.
 */
export async function subscriptionOrderNow(
  workspaceId: string,
  contractId: string,
): Promise<OpResult & { summary?: string; internal?: boolean }> {
  return orderNowByContract(workspaceId, contractId);
}
