/**
 * Checkout error logging — records anything that would STOP a checkout or hurt
 * a customer, to the `checkout_errors` table so we can diagnose missing
 * checkouts at go-live. Best-effort + never throws: logging a failure must
 * never itself break the (already-failing) checkout path.
 *
 * Server code calls logCheckoutError directly; the client posts to
 * /api/checkout/log-error which calls this.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type CheckoutErrorStage =
  | "client_token"
  | "identify"
  | "otp"
  | "tax"
  | "tokenize"
  | "braintree_charge"
  | "order_insert"
  | "subscription_insert"
  | "validation"
  | "submit"
  | "other";

export interface CheckoutErrorInput {
  workspaceId: string;
  stage: CheckoutErrorStage;
  side?: "client" | "server";
  cartToken?: string | null;
  customerId?: string | null;
  anonymousId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  context?: Record<string, unknown>;
  userAgent?: string | null;
}

export async function logCheckoutError(input: CheckoutErrorInput): Promise<void> {
  try {
    if (!input.workspaceId || !input.stage) return;
    const admin = createAdminClient();
    await admin.from("checkout_errors").insert({
      workspace_id: input.workspaceId,
      cart_token: input.cartToken ?? null,
      customer_id: input.customerId ?? null,
      anonymous_id: input.anonymousId ?? null,
      stage: input.stage,
      side: input.side ?? "server",
      error_code: input.errorCode ?? null,
      error_message: (input.errorMessage ?? "").toString().slice(0, 2000) || null,
      context: input.context ?? {},
      user_agent: input.userAgent ?? null,
    });
  } catch (e) {
    // Never throw from the logger.
    console.warn("[checkout-error-log] insert failed:", e instanceof Error ? e.message : e);
  }
}
