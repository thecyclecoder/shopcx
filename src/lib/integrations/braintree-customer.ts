/**
 * Resolve (or create) the Braintree customer for a given shopcx
 * customer. Three-tier lookup so we never duplicate Braintree records:
 *
 *   1. Local DB  — customers.braintree_customer_id, if we've seen them before.
 *   2. Braintree — search Braintree by email. Handles cases where a BT
 *                  customer exists from a prior code path / manual entry
 *                  / a different shopcx workspace that already touched
 *                  this merchant.
 *   3. Create    — new BT customer, stamp the id back onto our customers row.
 *
 * Returns the resolved Braintree customer id. Throws if Braintree
 * isn't configured for the workspace.
 *
 * Email is the dedup key. We don't try to dedup by phone — phone is
 * common across household members and we'd merge separate people.
 */
import braintree from "braintree";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBraintreeGateway } from "@/lib/integrations/braintree";

interface ResolveInput {
  workspaceId: string;
  customerId: string;        // our customers.id
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

export async function resolveBraintreeCustomerId(
  input: ResolveInput,
): Promise<string> {
  const admin = createAdminClient();

  // ── 1. Local lookup ─────────────────────────────────────────────
  const { data: cust } = await admin
    .from("customers")
    .select("braintree_customer_id, first_name, last_name, phone")
    .eq("id", input.customerId)
    .maybeSingle();
  if (cust?.braintree_customer_id) return cust.braintree_customer_id as string;

  const gateway = await getBraintreeGateway(input.workspaceId);

  // ── 2. Braintree search by email ────────────────────────────────
  //
  // gateway.customer.search returns a stream. We drain it into an
  // array; in practice there's at most one match per email. If there
  // ARE multiple, we pick the most-recently-created one — usually the
  // one we want to attach new cards to.
  const found = await searchBraintreeCustomersByEmail(gateway, input.email);
  if (found.length > 0) {
    const winner = found.reduce((best, c) => {
      const bt = best?.createdAt ? new Date(best.createdAt).getTime() : 0;
      const ct = c?.createdAt ? new Date(c.createdAt).getTime() : 0;
      return ct > bt ? c : best;
    }, found[0]);
    if (winner?.id) {
      await admin
        .from("customers")
        .update({ braintree_customer_id: winner.id })
        .eq("id", input.customerId);
      return winner.id;
    }
  }

  // ── 3. Create a fresh BT customer ───────────────────────────────
  const createResult = await gateway.customer.create({
    firstName: input.firstName || cust?.first_name || "",
    lastName: input.lastName || cust?.last_name || "",
    email: input.email,
    phone: input.phone || cust?.phone || undefined,
  });
  if (!createResult.success || !createResult.customer) {
    throw new Error(`Braintree customer.create failed: ${createResult.message || "unknown"}`);
  }
  const btId = createResult.customer.id;
  await admin
    .from("customers")
    .update({ braintree_customer_id: btId })
    .eq("id", input.customerId);
  return btId;
}

// ────────────────────────────────────────────────────────────────────
// Braintree search drain — gateway.customer.search returns a stream.
// We promise-wrap the drain so callers get a plain array.
// ────────────────────────────────────────────────────────────────────
function searchBraintreeCustomersByEmail(
  gateway: braintree.BraintreeGateway,
  email: string,
): Promise<Array<{ id: string; createdAt?: string }>> {
  return new Promise((resolve, reject) => {
    const matches: Array<{ id: string; createdAt?: string }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream: any = gateway.customer.search((s: any) => {
      s.email().is(email);
    });
    stream.on("data", (c: braintree.Customer & { createdAt?: string }) => {
      matches.push({ id: c.id, createdAt: c.createdAt });
    });
    stream.on("end", () => resolve(matches));
    stream.on("error", reject);
  });
}

// ────────────────────────────────────────────────────────────────────
// Persisted payment-method shape — the row we insert into
// customer_payment_methods after a successful paymentMethod.create.
// ────────────────────────────────────────────────────────────────────
export interface PaymentMethodSaveInput {
  workspaceId: string;
  customerId: string;
  braintreeCustomerId: string;
  braintreePaymentMethodToken: string;
  paymentType:
    | "credit_card"
    | "paypal_account"
    | "apple_pay_card"
    | "google_pay_card"
    | "venmo_account"
    | "us_bank_account"
    | "unknown";
  cardBrand?: string | null;
  last4?: string | null;
  expirationMonth?: string | null;
  expirationYear?: string | null;
  paypalEmail?: string | null;
  cartToken?: string | null;
  makeDefault?: boolean;
}

export async function savePaymentMethod(input: PaymentMethodSaveInput): Promise<{ id: string }> {
  const admin = createAdminClient();

  // If this is being made the new default, demote every other default across the
  // customer's LINK GROUP — linked accounts are one person, so there's exactly one
  // default per person (not per profile, which produced two "default" cards).
  if (input.makeDefault) {
    const { linkGroupIds } = await import("@/lib/customer-links");
    const groupIds = await linkGroupIds(admin, input.workspaceId, input.customerId);
    await admin
      .from("customer_payment_methods")
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq("workspace_id", input.workspaceId)
      .in("customer_id", groupIds)
      .eq("is_default", true);
  }

  // Upsert by braintree_payment_method_token (UNIQUE) so re-running a
  // vault for the same card just refreshes its row instead of erroring.
  // provider='braintree' stamps the row so dunning + renewal know to
  // charge through Braintree, never Shopify (the token is meaningless
  // to Shopify's gateway).
  const { data: row, error } = await admin
    .from("customer_payment_methods")
    .upsert(
      {
        workspace_id: input.workspaceId,
        customer_id: input.customerId,
        braintree_customer_id: input.braintreeCustomerId,
        braintree_payment_method_token: input.braintreePaymentMethodToken,
        provider: "braintree",
        payment_type: input.paymentType,
        card_brand: input.cardBrand || null,
        last4: input.last4 || null,
        expiration_month: input.expirationMonth || null,
        expiration_year: input.expirationYear || null,
        paypal_email: input.paypalEmail || null,
        is_default: input.makeDefault ?? true,
        status: "active",
        created_from_cart_token: input.cartToken || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "braintree_payment_method_token" },
    )
    .select("id")
    .single();

  if (error || !row) throw new Error(`payment method save failed: ${error?.message || "unknown"}`);
  return { id: row.id as string };
}

// ────────────────────────────────────────────────────────────────────
// Vault a nonce into Braintree (paymentMethod.create) — returns the
// resulting BT payment method, including the new token and any card
// metadata (brand, last4, expiry) we'd want to mirror locally.
// ────────────────────────────────────────────────────────────────────
export interface VaultResult {
  token: string;
  paymentType: PaymentMethodSaveInput["paymentType"];
  cardBrand: string | null;
  last4: string | null;
  expirationMonth: string | null;
  expirationYear: string | null;
  paypalEmail: string | null;
}

export async function vaultPaymentMethod(
  workspaceId: string,
  braintreeCustomerId: string,
  paymentMethodNonce: string,
  deviceData?: string,
): Promise<VaultResult> {
  const gateway = await getBraintreeGateway(workspaceId);
  const result = await gateway.paymentMethod.create({
    customerId: braintreeCustomerId,
    paymentMethodNonce,
    deviceData,
    options: {
      verifyCard: true,
      makeDefault: true,
    },
  });
  if (!result.success || !result.paymentMethod) {
    const msg =
      result.message ||
      (result as { verification?: { processorResponseText?: string } }).verification?.processorResponseText ||
      "paymentMethod.create failed";
    throw new Error(msg);
  }
  const pm = result.paymentMethod as braintree.PaymentMethod & {
    cardType?: string;
    last4?: string;
    expirationMonth?: string;
    expirationYear?: string;
  };
  const typeRaw = (pm as { paymentInstrumentName?: string }).paymentInstrumentName?.toLowerCase() || "";

  // The Node SDK returns different classes for each instrument type.
  // We sniff via duck-typing rather than relying on `instanceof` to
  // avoid importing all of the typing surface. CreditCard is the
  // overwhelming common case for the v1 storefront.
  let paymentType: PaymentMethodSaveInput["paymentType"] = "unknown";
  if (typeRaw.includes("paypal")) paymentType = "paypal_account";
  else if (typeRaw.includes("apple")) paymentType = "apple_pay_card";
  else if (typeRaw.includes("google")) paymentType = "google_pay_card";
  else if (typeRaw.includes("venmo")) paymentType = "venmo_account";
  else if (typeRaw.includes("us_bank")) paymentType = "us_bank_account";
  else if (pm.cardType || pm.last4) paymentType = "credit_card";

  // PayPal accounts carry the payer email instead of card details.
  const paypalEmail = paymentType === "paypal_account"
    ? ((pm as { email?: string; payerEmail?: string }).email || (pm as { payerEmail?: string }).payerEmail || null)
    : null;

  return {
    token: pm.token,
    paymentType,
    cardBrand: pm.cardType || null,
    last4: pm.last4 || null,
    expirationMonth: pm.expirationMonth || null,
    expirationYear: pm.expirationYear || null,
    paypalEmail,
  };
}
