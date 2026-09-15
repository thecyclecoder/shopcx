/**
 * One-time charges — the QUEUE, and the Shopify-vaulted rail.
 *
 * ⭐ TWO RAILS, ONE FRONT DOOR. `src/lib/one-time-charge.ts` (`chargeOneTimeOrder`, PR #2737)
 * already charges a vaulted BRAINTREE card and builds the order itself. It had no production
 * caller. This module is the queue for both, and `executeOneTimeCharge` PREFERS Braintree
 * whenever the customer has an active card there — same reason the payment-recovery email routes
 * to our own flow: anywhere we can keep someone on internal rails, we do. The Shopify contract
 * dance below exists only for customers we cannot reach that way (Shop Pay agreements and
 * Shopify-vaulted cards), which is precisely the set that has no Braintree token.
 *
 * ⭐ WHY THIS EXISTS. A Shop Pay agreement or a Shopify-vaulted card cannot be charged by any
 * Admin API call except `subscriptionBillingAttemptCreate`, which bills a subscription CONTRACT.
 * So the only way to take a single payment from one — no checkout, no customer interaction — is
 * to build a contract, bill it once, and cancel it. That is what this module does. For a customer
 * whose card we hold in Braintree, use the internal path instead; this is for the ones we don't.
 *
 * ⭐ WHY IT IS NOT A SUBSCRIPTION. See the migration header
 * (`20261229120000_one_time_charges.sql`): `subscriptions` is read by analytics, the portal, the
 * cancel flow, dunning and the Appstle→internal sweeps, and a row excluded from those only by a
 * predicate every reader must remember is the `is_internal = false` mistake again. A separate
 * table cannot silently widen.
 *
 * ⚠️ `billingPolicy.maxCycles` DOES NOT BIND. Verified live on contract 36017143981: created with
 * `minCycles: 1, maxCycles: 1`, it still exposed 8 addressable billing cycles, identical to an
 * uncapped contract. Shopify stores the policy and computes a calendar; it never enforces either.
 * The contract is CANCELLED the moment the charge settles — that is the real guarantee.
 *
 * See [[docs/brain/tables/one_time_charges]] and [[docs/brain/lifecycles/shopcx-subscriptions]].
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  shopifyCreateContract,
  shopifySubscriptionAction,
  shopifyAttemptBilling,
  awaitBillingAttempt,
  getSubscriptionContract,
} from "@/lib/commerce/shopify-subscription-client";
import { errText } from "@/lib/error-text";

export type OneTimeChargeStatus = "pending" | "charging" | "charged" | "failed" | "cancelled";

export interface QueuedChargeItem {
  /** INTERNAL variant UUID — never a shopify_variant_id (CLAUDE.md § internal joins use UUIDs). */
  variant_id: string;
  quantity: number;
  /** Charged price per unit. Omit to use the catalog price at charge time. */
  price_cents?: number | null;
}

export interface CreateOneTimeChargeInput {
  customerId: string;
  items: QueuedChargeItem[];
  /** Why this charge exists. A charge nobody can explain is a chargeback. */
  reason: string;
  createdBy: string;
  /** Defaults to now — the next cron tick picks it up. */
  chargeAt?: string;
  currency?: string;
}

export interface OneTimeChargeResult {
  success: boolean;
  error?: string;
  chargeId?: string;
}

/**
 * Record the intent. Nothing is charged here and no Shopify object is created — that happens in
 * `executeOneTimeCharge`, so a queued charge can still be cancelled with a single UPDATE and
 * never leaves a contract behind if it is pulled.
 */
export async function createOneTimeCharge(
  workspaceId: string,
  input: CreateOneTimeChargeInput,
): Promise<OneTimeChargeResult> {
  if (!input.items?.length) return { success: false, error: "no_items" };
  if (!input.reason?.trim()) return { success: false, error: "reason_required" };
  for (const it of input.items) {
    if (!it.variant_id) return { success: false, error: "item_missing_variant_id" };
    if (!Number.isInteger(it.quantity) || it.quantity < 1) {
      return { success: false, error: `invalid quantity for ${it.variant_id}` };
    }
  }

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("id, shopify_customer_id")
    .eq("workspace_id", workspaceId)
    .eq("id", input.customerId)
    .maybeSingle();
  if (!customer) return { success: false, error: "customer_not_found" };
  if (!customer.shopify_customer_id) {
    // Without a Shopify customer there is no vaulted Shopify payment method to reach, and this
    // whole mechanism is pointless. Refuse at CREATE so it surfaces to whoever asked, rather than
    // failing silently on a cron tick days later.
    return { success: false, error: "customer_has_no_shopify_id" };
  }

  const { data, error } = await admin
    .from("one_time_charges")
    .insert({
      workspace_id: workspaceId,
      customer_id: input.customerId,
      shopify_customer_id: customer.shopify_customer_id,
      items: input.items,
      currency: input.currency ?? "USD",
      charge_at: input.chargeAt ?? new Date().toISOString(),
      reason: input.reason.trim(),
      created_by: input.createdBy,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return { success: false, error: error.message };
  return { success: true, chargeId: (data as { id: string }).id };
}

/** Pull a queued charge. Only a `pending` row can be cancelled — one already charging or charged cannot. */
export async function cancelOneTimeCharge(
  workspaceId: string,
  chargeId: string,
): Promise<OneTimeChargeResult> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("one_time_charges")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", chargeId)
    .eq("status", "pending")
    .select("id");
  // ⚠️ PostgREST returns NO error when an update matches zero rows, so the row count is the only
  // signal that the compare-and-set lost.
  if (!data?.length) return { success: false, error: "not_pending" };
  return { success: true, chargeId };
}

/**
 * Claim a pending charge for this run.
 *
 * THIS ROW IS THE CLAIM — there is no cycle-charge ledger entry, because a one-time charge has
 * exactly one charge and per-cycle keying would be meaningless. The compare-and-set is atomic;
 * a second runner gets zero rows back and skips.
 */
async function claim(workspaceId: string, chargeId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("one_time_charges")
    .update({ status: "charging", charging_since: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", chargeId)
    .eq("status", "pending")
    .select("id");
  return !!data?.length;
}

async function settle(
  workspaceId: string,
  chargeId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("one_time_charges")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", chargeId);
}

/**
 * Charge the customer's vaulted BRAINTREE card if they have one.
 *
 * Returns `null` when there is no active Braintree card — the caller then falls through to the
 * Shopify contract path. A `{success:false}` is a real decline and must NOT fall through: the
 * customer's card was already asked and charging a second rail would risk billing them twice.
 */
async function chargeViaBraintreeIfPossible(
  workspaceId: string,
  row: { id: string; customer_id: string; items: unknown; reason: string | null },
): Promise<{ success: boolean; error?: string; order_id?: string; order_number?: string; amount_cents?: number } | null> {
  const admin = createAdminClient();
  const { data: pm } = await admin
    .from("customer_payment_methods")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", row.customer_id)
    .eq("provider", "braintree")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (!pm) return null;

  const { chargeOneTimeOrder } = await import("@/lib/one-time-charge");
  const r = await chargeOneTimeOrder({
    workspaceId,
    customerId: row.customer_id,
    items: (row.items as QueuedChargeItem[]).map((i) => ({
      variant_id: i.variant_id,
      quantity: i.quantity,
      // Their entitled price, not catalog — the whole point of that field.
      ...(i.price_cents != null ? { unit_price_cents: i.price_cents } : {}),
    })),
    sourceName: "one-time-charge",
    reason: row.reason ?? undefined,
  });
  return {
    success: r.success,
    error: r.error ?? r.details,
    order_id: r.order_id,
    order_number: r.order_number,
    amount_cents: r.amount_cents,
  };
}

/** The customer's default vaulted Shopify payment method, and the delivery details to ship to. */
async function resolveShopifyContext(
  workspaceId: string,
  shopifyCustomerId: string,
): Promise<{ paymentMethodId: string; address: Record<string, unknown>; currency: string } | { error: string }> {
  const { getShopifyCredentials } = await import("@/lib/shopify-sync");
  const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($id:ID!){ customer(id:$id){
        paymentMethods(first:10){ nodes { id revokedAt instrument { __typename } } }
        defaultAddress { address1 address2 city zip provinceCode countryCodeV2 firstName lastName phone company } } }`,
      variables: { id: `gid://shopify/Customer/${String(shopifyCustomerId).replace("gid://shopify/Customer/", "")}` },
    }),
  });
  const j = (await res.json().catch(() => null)) as {
    data?: { customer?: {
      paymentMethods?: { nodes?: { id: string; revokedAt: string | null }[] };
      defaultAddress?: Record<string, unknown> | null;
    } };
  } | null;
  const cust = j?.data?.customer;
  if (!cust) return { error: "shopify_customer_not_found" };

  // A revoked method still appears in the list and would fail the attempt with an opaque decline.
  const pm = (cust.paymentMethods?.nodes ?? []).find((p) => !p.revokedAt);
  if (!pm) return { error: "no_vaulted_shopify_payment_method" };
  const a = cust.defaultAddress;
  if (!a?.address1) return { error: "customer_has_no_shipping_address" };

  return {
    paymentMethodId: pm.id,
    currency: "USD",
    address: {
      address1: a.address1, address2: a.address2 || "", city: a.city, zip: a.zip,
      countryCode: a.countryCodeV2, provinceCode: a.provinceCode,
      firstName: a.firstName, lastName: a.lastName,
      ...(a.phone ? { phone: a.phone } : {}),
      ...(a.company ? { company: a.company } : {}),
    },
  };
}

/** Resolve internal variant UUIDs → Shopify variant ids + prices, at charge time. */
async function resolveLines(
  workspaceId: string,
  items: QueuedChargeItem[],
): Promise<{ lines: Record<string, unknown>[]; amountCents: number } | { error: string }> {
  const admin = createAdminClient();
  const lines: Record<string, unknown>[] = [];
  let amountCents = 0;
  for (const it of items) {
    const { data: v } = await admin
      .from("product_variants")
      .select("id, shopify_variant_id, price_cents, title")
      .eq("workspace_id", workspaceId)
      .eq("id", it.variant_id)
      .maybeSingle();
    if (!v?.shopify_variant_id) return { error: `variant ${it.variant_id} has no shopify_variant_id` };
    const unit = it.price_cents ?? (v.price_cents as number | null) ?? 0;
    if (unit <= 0) return { error: `variant ${it.variant_id} has no price` };
    amountCents += unit * it.quantity;
    lines.push({
      line: {
        productVariantId: `gid://shopify/ProductVariant/${v.shopify_variant_id}`,
        quantity: it.quantity,
        currentPrice: (unit / 100).toFixed(2),
        // Shows on the order and in the customer's account. Named so it never reads as recurring.
        sellingPlanName: "One-time charge",
      },
    });
  }
  return { lines, amountCents };
}

export interface ExecuteResult {
  status: "charged" | "failed" | "skipped" | "pending";
  error?: string;
  orderName?: string | null;
  /** Set when the charge landed but the throwaway contract could NOT be cancelled. */
  contractLeftOpen?: string;
}

/**
 * Build a contract, bill it once, cancel it.
 *
 * Ordering is deliberate. The contract is created with `nextBillingDate` in the FUTURE (Shopify
 * rejects a past one) and billed via an explicit cycle selector, so nothing depends on Shopify
 * deciding anything is due — it never does that on its own anyway.
 *
 * The contract is cancelled in a `finally`-shaped step that runs on EVERY settled outcome,
 * success or decline. A contract left ACTIVE is a live billing instrument attached to a customer
 * who agreed to one charge.
 */
export async function executeOneTimeCharge(
  workspaceId: string,
  chargeId: string,
): Promise<ExecuteResult> {
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("one_time_charges")
    .select("id, customer_id, shopify_customer_id, items, currency, status, reason, attempts")
    .eq("workspace_id", workspaceId)
    .eq("id", chargeId)
    .maybeSingle();
  if (!row) return { status: "skipped", error: "charge_not_found" };
  if (row.status !== "pending") return { status: "skipped", error: `not_pending (${row.status})` };

  if (!(await claim(workspaceId, chargeId))) {
    return { status: "skipped", error: "claimed_by_another_run" };
  }

  const fail = async (error: string): Promise<ExecuteResult> => {
    await settle(workspaceId, chargeId, {
      status: "failed", error, failed_at: new Date().toISOString(),
      attempts: (row.attempts as number) + 1,
    });
    return { status: "failed", error };
  };

  let contractId: string | undefined;
  try {
    // ⭐ BRAINTREE FIRST. A vaulted Braintree card charges directly — no throwaway contract, no
    // Shopify order-source ambiguity, and the customer stays on internal rails. The Shopify path
    // is the fallback for customers we cannot reach any other way.
    const braintree = await chargeViaBraintreeIfPossible(workspaceId, row);
    if (braintree) {
      if (!braintree.success) return fail(braintree.error ?? "braintree_declined");
      await settle(workspaceId, chargeId, {
        status: "charged",
        charged_at: new Date().toISOString(),
        rail: "braintree",
        amount_cents: braintree.amount_cents ?? null,
        shopify_order_name: braintree.order_number ?? null,
        attempts: (row.attempts as number) + 1,
        ...(braintree.order_id ? { order_id: braintree.order_id } : {}),
      });
      return { status: "charged", orderName: braintree.order_number ?? null };
    }

    const ctx = await resolveShopifyContext(workspaceId, String(row.shopify_customer_id));
    if ("error" in ctx) return fail(ctx.error);

    const resolved = await resolveLines(workspaceId, row.items as QueuedChargeItem[]);
    if ("error" in resolved) return fail(resolved.error);

    // Far enough out that the create cannot race midnight; we bill by explicit selector anyway.
    const nextBillingDate = new Date(Date.now() + 86400000 * 30).toISOString();
    const created = await shopifyCreateContract(workspaceId, {
      customerId: `gid://shopify/Customer/${String(row.shopify_customer_id).replace("gid://shopify/Customer/", "")}`,
      nextBillingDate,
      currencyCode: String(row.currency || "USD"),
      contract: {
        status: "ACTIVE",
        paymentMethodId: ctx.paymentMethodId,
        // maxCycles is honest metadata only — Shopify does not enforce it (see the header).
        billingPolicy: { interval: "MONTH", intervalCount: 1, minCycles: 1, maxCycles: 1 },
        deliveryPolicy: { interval: "MONTH", intervalCount: 1 },
        deliveryPrice: "0.00",
        deliveryMethod: { shipping: { address: ctx.address, shippingOption: { title: "Economy" } } },
      },
      lines: resolved.lines,
    });
    if (!created.success || !created.contractId) return fail(created.error ?? "contract_create_failed");
    contractId = created.contractId.replace("gid://shopify/SubscriptionContract/", "");
    await settle(workspaceId, chargeId, { shopify_contract_id: contractId, payment_method_id: ctx.paymentMethodId, amount_cents: resolved.amountCents });

    // Bill cycle 1 explicitly. A fresh contract's cycle 1 starts at createdAt, so "just inside it"
    // is now — and addressing it by INDEX avoids any date/timezone edge on a contract seconds old.
    const started = await shopifyAttemptBilling(
      workspaceId,
      contractId,
      `one-time:${chargeId}`,
      { billingCycleSelector: { index: 1 } },
    );
    if (!started.success || !started.attemptId) {
      const msg = started.error ?? "attempt_not_accepted";
      // Same rule as the renewal worker: a transport fault is NOT a decline. Throw so the caller
      // retries; settling it `failed` here would abandon a charge whose card was never asked.
      if (/HTTP \d|fetch|network|ENOTFOUND|ECONNRESET|timeout|Throttled|not connected/i.test(msg)) {
        await settle(workspaceId, chargeId, { status: "pending", charging_since: null });
        throw new Error(`transient Shopify failure, retrying: ${msg}`);
      }
      return fail(msg);
    }

    const outcome = await awaitBillingAttempt(workspaceId, started.attemptId);
    if (outcome.pending) {
      // 3DS or a poll timeout — NOT settled. Leave it `charging` so nothing double-charges, and
      // let the sweeper reconcile it against Shopify rather than guessing here.
      await settle(workspaceId, chargeId, { billing_attempt_id: started.attemptId });
      return { status: "pending" };
    }
    if (!outcome.success) {
      // Declined. Deliberately NOT dispatched to dunning: this is not a subscription at risk, and
      // rotating the card / emailing about a subscription the customer does not have would be wrong.
      await settle(workspaceId, chargeId, { billing_attempt_id: started.attemptId });
      return fail(outcome.error ?? outcome.errorCode ?? "declined");
    }

    let orderUuid: string | undefined;
    const bare = outcome.orderId?.replace("gid://shopify/Order/", "");
    if (bare) {
      const { data: o } = await admin
        .from("orders").select("id").eq("workspace_id", workspaceId).eq("shopify_order_id", bare).maybeSingle();
      orderUuid = (o as { id: string } | null)?.id;
    }
    await settle(workspaceId, chargeId, {
      status: "charged",
      charged_at: new Date().toISOString(),
      rail: "shopify",
      billing_attempt_id: started.attemptId,
      shopify_order_name: outcome.orderName ?? null,
      attempts: (row.attempts as number) + 1,
      // ⚠️ Only when the order webhook has already landed. `order_id` is a uuid column and a
      // Shopify GID raises 22P02, which would kill the step AFTER the customer was charged.
      ...(orderUuid ? { order_id: orderUuid } : {}),
    });
    return { status: "charged", orderName: outcome.orderName ?? null };
  } catch (err) {
    await settle(workspaceId, chargeId, { status: "pending", charging_since: null });
    throw err;
  } finally {
    // ⭐ Cancel on EVERY settled path. This — not maxCycles — is what makes the charge one-time.
    if (contractId) {
      const c = await shopifySubscriptionAction(workspaceId, contractId, "cancel").catch(
        (e: unknown) => ({ success: false, error: errText(e) }),
      );
      if (!c.success) {
        // A live contract attached to a customer who agreed to ONE charge. Loud, and recorded on
        // the row so the sweeper can retry rather than leaving it to a log nobody reads.
        console.error(`[one-time-charge] LEFT CONTRACT OPEN ${contractId} for charge ${chargeId}: ${c.error}`);
        await settle(workspaceId, chargeId, { error: `contract_not_cancelled:${contractId}:${c.error ?? ""}` });
      }
    }
  }
}

/** The `orders.order_type` we stamp. Deliberately NOT one of checkout|recurring|replacement. */
export const ONE_TIME_ORDER_TYPE = "one_time";

/**
 * Link the landed order back to its charge, and RECLASSIFY it.
 *
 * ⭐ Without the reclassify, the whole "keeps out of subscription stats" premise fails. A
 * one-time charge is billed through `subscriptionBillingAttemptCreate`, so Shopify stamps the
 * order `source_name = 'subscription_contract_checkout_one'` — byte-identical to a real ShopCX
 * renewal. The workspace's `order_source_mapping` maps that source to **`recurring`**, so the
 * order would be counted as a renewal on the dashboard, in recurring-order analytics, and by the
 * rules engine (which exposes `order.order_type` as a condition field).
 *
 * `orders.subscription_id` is already NULL for these, which covers everything keyed on the join —
 * but nothing keyed on `order_type`. Both have to be right.
 *
 * Runs in the sweeper rather than inline because the order webhook usually has not landed when
 * the attempt settles (measured: `order_id` was still null the moment SC138755 was charged).
 */
async function backfillOrderLinks(workspaceId: string): Promise<number> {
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("one_time_charges")
    .select("id, shopify_order_name")
    .eq("workspace_id", workspaceId)
    .eq("status", "charged")
    .is("order_id", null)
    .not("shopify_order_name", "is", null)
    .limit(200);

  let linked = 0;
  for (const r of rows ?? []) {
    const { data: o } = await admin
      .from("orders")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("order_number", r.shopify_order_name as string)
      .maybeSingle();
    if (!o) continue; // webhook still in flight — next sweep picks it up
    await admin
      .from("one_time_charges")
      .update({ order_id: (o as { id: string }).id, updated_at: new Date().toISOString() })
      .eq("id", r.id as string);
    // ⚠️ READ the error. `orders.order_type` is CHECK-constrained, and a rejected update is a
    // silent no-op to a caller that ignores it — which is exactly how this shipped misclassified
    // the first time (23514 against orders_order_type_check, caught only by reading the error).
    const { error: reclassErr } = await admin
      .from("orders")
      .update({ order_type: ONE_TIME_ORDER_TYPE })
      .eq("id", (o as { id: string }).id);
    if (reclassErr) {
      console.error(
        `[one-time-charge] order ${r.shopify_order_name} NOT reclassified — it will count as a RENEWAL: ${reclassErr.message}`,
      );
      continue; // leave order_id set; retry the reclassify next sweep
    }
    linked++;
  }
  return linked;
}

/**
 * Reconcile rows the executor could not finish: a crashed run stuck in `charging`, and any
 * contract left ACTIVE after a failed cancel. Both are states where Shopify holds something we
 * believe we cleaned up, so Shopify is the authority. Also links + reclassifies landed orders.
 */
export async function sweepOneTimeCharges(workspaceId: string): Promise<{ reconciled: number; cancelled: number; linked: number }> {
  const admin = createAdminClient();
  let reconciled = 0;
  let cancelled = 0;
  const linked = await backfillOrderLinks(workspaceId);

  const { data: stuck } = await admin
    .from("one_time_charges")
    .select("id, shopify_contract_id, billing_attempt_id, charging_since, attempts")
    .eq("workspace_id", workspaceId)
    .eq("status", "charging")
    .lt("charging_since", new Date(Date.now() - 30 * 60 * 1000).toISOString())
    .limit(100);

  for (const row of stuck ?? []) {
    const cid = row.shopify_contract_id as string | null;
    if (!cid) {
      await settle(workspaceId, String(row.id), { status: "failed", error: "crashed_before_contract", failed_at: new Date().toISOString() });
      reconciled++;
      continue;
    }
    // Did it actually charge? Ask Shopify, never assume.
    const c = await getSubscriptionContract(workspaceId, cid);
    const { getBillingCycleForDate } = await import("@/lib/commerce/shopify-subscription-client");
    const created = c.contract?.createdAt;
    const cyc = created ? await getBillingCycleForDate(workspaceId, cid, new Date(new Date(created).getTime() + 1000).toISOString()) : null;
    if (cyc?.cycle?.status === "BILLED") {
      await settle(workspaceId, String(row.id), { status: "charged", charged_at: new Date().toISOString() });
    } else {
      await settle(workspaceId, String(row.id), { status: "failed", error: "unresolved_after_crash", failed_at: new Date().toISOString() });
    }
    reconciled++;
    if (c.contract && c.contract.status !== "CANCELLED") {
      const r = await shopifySubscriptionAction(workspaceId, cid, "cancel");
      if (r.success) cancelled++;
    }
  }
  return { reconciled, cancelled, linked };
}
