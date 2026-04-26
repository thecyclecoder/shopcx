// Core dunning logic: card rotation, payment method dedup, payday scheduling

import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

// ── Types ──

export interface PaymentMethod {
  id: string;            // gid://shopify/CustomerPaymentMethod/...
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  brand: string | null;
  name: string | null;
  dedupeKey: string;     // last4 + expiryMonth + expiryYear
}

export interface DunningSettings {
  dunning_enabled: boolean;
  dunning_max_card_rotations: number;
  dunning_payday_retry_enabled: boolean;
  dunning_cycle_1_action: string;
  dunning_cycle_2_action: string;
}

// ── Shopify GraphQL: Customer Payment Methods ──

export async function getCustomerPaymentMethods(
  workspaceId: string,
  shopifyCustomerId: string,
): Promise<PaymentMethod[]> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const query = `{
    customer(id: "gid://shopify/Customer/${shopifyCustomerId}") {
      paymentMethods(first: 10) {
        edges {
          node {
            id
            instrument {
              ... on CustomerCreditCard {
                lastDigits
                expiryMonth
                expiryYear
                brand
                name
              }
              ... on CustomerShopPayAgreement {
                lastDigits
                expiryMonth
                expiryYear
                name
              }
            }
            revokedAt
          }
        }
      }
    }
  }`;

  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL error: ${res.status} ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL: ${json.errors[0].message}`);
  }

  const edges = json.data?.customer?.paymentMethods?.edges || [];
  const methods: PaymentMethod[] = [];

  for (const edge of edges) {
    const node = edge.node;
    // Skip revoked payment methods
    if (node.revokedAt) continue;

    const instrument = node.instrument;
    if (!instrument?.lastDigits) continue;

    methods.push({
      id: node.id,
      last4: instrument.lastDigits,
      expiryMonth: instrument.expiryMonth || 0,
      expiryYear: instrument.expiryYear || 0,
      brand: instrument.brand || null,
      name: instrument.name || null,
      dedupeKey: `${instrument.lastDigits}-${instrument.expiryMonth}-${instrument.expiryYear}`,
    });
  }

  return methods;
}

// ── Deduplication ──

export function deduplicatePaymentMethods(methods: PaymentMethod[]): PaymentMethod[] {
  const seen = new Set<string>();
  const unique: PaymentMethod[] = [];

  for (const m of methods) {
    if (!seen.has(m.dedupeKey)) {
      seen.add(m.dedupeKey);
      unique.push(m);
    }
  }

  return unique;
}

// ── Get untried cards ──

export function getUntriedCards(
  methods: PaymentMethod[],
  triedCards: string[],
): PaymentMethod[] {
  return methods.filter(m => !triedCards.includes(m.dedupeKey));
}

// ── Payday Scheduling ──

export function getNextPaydayDates(fromDate: Date, count: number): Date[] {
  const dates: Date[] = [];
  const d = new Date(fromDate);

  // Look ahead up to 45 days to find enough payday dates
  for (let i = 0; i < 45 && dates.length < count; i++) {
    d.setDate(d.getDate() + 1);
    if (isPayday(d)) {
      dates.push(new Date(d));
    }
  }

  return dates;
}

function isPayday(date: Date): boolean {
  const dayOfMonth = date.getDate();
  const dayOfWeek = date.getDay(); // 0=Sun, 5=Fri
  const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

  // 1st of month
  if (dayOfMonth === 1) return true;
  // 15th of month
  if (dayOfMonth === 15) return true;
  // Friday
  if (dayOfWeek === 5) return true;
  // Last business day of month
  if (dayOfMonth === lastDayOfMonth && dayOfWeek >= 1 && dayOfWeek <= 5) return true;
  if (dayOfMonth === lastDayOfMonth - 1 && dayOfWeek === 5) return true; // Friday before weekend last day
  if (dayOfMonth === lastDayOfMonth - 2 && dayOfWeek === 5) return true; // Friday if last day is Sunday

  return false;
}

export function getRetryTime(paydayDate: Date, timezoneOffset: number = -6): Date {
  // Retry at 7 AM in the target timezone (default US Central = UTC-6)
  // 7 AM Central = 7 - (-6) = 13 UTC
  const retry = new Date(paydayDate);
  retry.setUTCHours(7 - timezoneOffset, 0, 0, 0);
  return retry;
}

// ── Dunning Settings ──

export async function getDunningSettings(workspaceId: string): Promise<DunningSettings | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("dunning_enabled, dunning_max_card_rotations, dunning_payday_retry_enabled, dunning_cycle_1_action, dunning_cycle_2_action")
    .eq("id", workspaceId)
    .single();

  if (!data) return null;
  return data as DunningSettings;
}

// ── Dunning Cycle Management ──

export async function getActiveDunningCycle(
  workspaceId: string,
  shopifyContractId: string,
): Promise<{ id: string; cycle_number: number; status: string; cards_tried: string[]; terminal_cards: string[]; billing_attempt_id: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dunning_cycles")
    .select("id, cycle_number, status, cards_tried, terminal_cards, billing_attempt_id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", shopifyContractId)
    .in("status", ["active", "rotating", "retrying", "skipped", "paused"])
    .order("cycle_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}

export async function getActiveDunningCyclesForCustomer(
  workspaceId: string,
  customerId: string,
): Promise<{ id: string; shopify_contract_id: string; subscription_id: string | null; cycle_number: number; status: string; billing_attempt_id: string | null }[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dunning_cycles")
    .select("id, shopify_contract_id, subscription_id, cycle_number, status, billing_attempt_id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .in("status", ["active", "rotating", "retrying", "skipped", "paused"]);

  return data || [];
}

export async function createDunningCycle(
  workspaceId: string,
  shopifyContractId: string,
  subscriptionId: string | null,
  customerId: string | null,
  billingAttemptId: string | null,
): Promise<{ id: string; cycle_number: number }> {
  const admin = createAdminClient();

  // Determine cycle number by checking previous cycles for this contract
  const { data: prev } = await admin
    .from("dunning_cycles")
    .select("cycle_number")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", shopifyContractId)
    .in("status", ["recovered", "exhausted"])
    .order("cycle_number", { ascending: false })
    .limit(1)
    .single();

  const cycleNumber = prev ? prev.cycle_number + 1 : 1;

  const { data, error } = await admin
    .from("dunning_cycles")
    .insert({
      workspace_id: workspaceId,
      shopify_contract_id: shopifyContractId,
      subscription_id: subscriptionId,
      customer_id: customerId,
      cycle_number: cycleNumber,
      status: "rotating",
      billing_attempt_id: billingAttemptId,
    })
    .select("id, cycle_number")
    .single();

  if (error) throw new Error(`Failed to create dunning cycle: ${error.message}`);
  return data!;
}

export async function updateDunningCycle(
  cycleId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("dunning_cycles")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", cycleId);
}

export async function logPaymentFailure(params: {
  workspaceId: string;
  customerId: string | null;
  subscriptionId: string | null;
  shopifyContractId: string;
  billingAttemptId?: string | null;
  paymentMethodLast4?: string | null;
  paymentMethodId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  attemptNumber: number;
  attemptType: "initial" | "card_rotation" | "payday_retry" | "new_card_retry";
  succeeded: boolean;
}): Promise<void> {
  const admin = createAdminClient();
  await admin.from("payment_failures").insert({
    workspace_id: params.workspaceId,
    customer_id: params.customerId,
    subscription_id: params.subscriptionId,
    shopify_contract_id: params.shopifyContractId,
    billing_attempt_id: params.billingAttemptId || null,
    payment_method_last4: params.paymentMethodLast4 || null,
    payment_method_id: params.paymentMethodId || null,
    error_code: params.errorCode || null,
    error_message: params.errorMessage || null,
    attempt_number: params.attemptNumber,
    attempt_type: params.attemptType,
    succeeded: params.succeeded,
  });
}

export async function getLastSuccessfulCard(
  workspaceId: string,
  customerId: string,
): Promise<{ payment_method_id: string; payment_method_last4: string } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("payment_failures")
    .select("payment_method_id, payment_method_last4")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .eq("succeeded", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  return data && data.payment_method_id ? data as { payment_method_id: string; payment_method_last4: string } : null;
}

// ── Error Code Classification ──

export async function isTerminalErrorCode(
  workspaceId: string,
  errorCode: string | null,
): Promise<boolean> {
  if (!errorCode) return false;
  const admin = createAdminClient();
  const { data } = await admin
    .from("dunning_error_codes")
    .select("is_terminal")
    .eq("workspace_id", workspaceId)
    .eq("error_code", errorCode)
    .single();
  return data?.is_terminal === true;
}

export async function trackErrorCode(
  workspaceId: string,
  errorCode: string | null,
  errorMessage: string | null,
): Promise<void> {
  if (!errorCode) return;
  const admin = createAdminClient();
  // Upsert: increment count if exists, create if new
  const { data: existing } = await admin
    .from("dunning_error_codes")
    .select("id, occurrence_count")
    .eq("workspace_id", workspaceId)
    .eq("error_code", errorCode)
    .maybeSingle();

  if (existing) {
    await admin.from("dunning_error_codes").update({
      occurrence_count: existing.occurrence_count + 1,
      last_seen_at: new Date().toISOString(),
      // Update error_message to latest seen (some codes have multiple messages)
      ...(errorMessage ? { error_message: errorMessage } : {}),
    }).eq("id", existing.id);
  } else {
    // New error code — default is_terminal to false, admin reviews in settings
    await admin.from("dunning_error_codes").insert({
      workspace_id: workspaceId,
      error_code: errorCode,
      error_message: errorMessage,
      is_terminal: false,
      occurrence_count: 1,
    });
  }
}

// ── Internal Note Helpers ──

export function dunningInternalNote(message: string): string {
  return `[System] ${message}`;
}

/**
 * Post an internal note on the customer's most recent open/pending ticket.
 */
export async function postDunningNoteOnTicket(
  workspaceId: string,
  customerId: string | null,
  note: string,
): Promise<void> {
  if (!customerId) return;
  const admin = createAdminClient();
  const { data: ticket } = await admin
    .from("tickets")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .in("status", ["open", "pending"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!ticket) return;
  await admin.from("ticket_messages").insert({
    ticket_id: ticket.id,
    direction: "internal",
    visibility: "internal",
    author_type: "system",
    body: note,
  });
}

/**
 * Tag all open/pending tickets for a customer with a given tag.
 */
export async function tagOpenTickets(
  workspaceId: string,
  customerId: string | null,
  tag: string,
): Promise<void> {
  if (!customerId) return;
  const admin = createAdminClient();
  const { data: tickets } = await admin
    .from("tickets")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .in("status", ["open", "pending"]);
  if (!tickets?.length) return;
  const { addTicketTag } = await import("@/lib/ticket-tags");
  for (const t of tickets) await addTicketTag(t.id, tag);
}

/**
 * Cancel a subscription and send a payment-update email when a billing failure
 * carries a terminal error code AND the customer has no other payment methods
 * to rotate to. Skips the dunning cycle entirely — there's nothing to recover.
 *
 * Used by:
 *   - the billing-failure webhook handler (early path, before any cycle is created)
 *   - the dunning Inngest function (defensive fallback if it gets called anyway)
 */
export async function cancelForTerminalNoBackup(params: {
  workspaceId: string;
  contractId: string;
  customerId: string | null;
  errorCode: string;
  errorMessage: string | null;
  paymentMethodCount: number;
}): Promise<void> {
  const { workspaceId, contractId, customerId, errorCode, errorMessage, paymentMethodCount } = params;
  const admin = createAdminClient();
  const { appstleSubscriptionAction } = await import("@/lib/appstle");

  try {
    await appstleSubscriptionAction(
      workspaceId, contractId, "cancel", "dunning",
      `Cancelled by ShopCX — terminal billing error: ${errorCode} (${errorMessage || "no details"}), no other payment methods available`,
    );
  } catch (e) {
    console.error("[Dunning terminal-cancel] appstle cancel failed:", e);
  }

  // Send our own payment-update email — Appstle's default isn't great.
  if (customerId) {
    const { data: cust } = await admin.from("customers").select("email, first_name").eq("id", customerId).single();
    const { data: ws } = await admin.from("workspaces").select("name, portal_config").eq("id", workspaceId).single();
    const portalGeneral = (ws?.portal_config as Record<string, unknown> | undefined)?.general as Record<string, unknown> | undefined;
    const updateUrl = (portalGeneral?.payment_update_url as string) || "";
    if (cust?.email && ws?.name && updateUrl) {
      try {
        const { sendDunningPausedEmail } = await import("@/lib/email");
        await sendDunningPausedEmail({
          workspaceId, toEmail: cust.email,
          customerName: cust.first_name,
          workspaceName: ws.name,
          updateUrl,
        });
      } catch (e) {
        console.error("[Dunning terminal-cancel] notification email failed:", e);
      }
    }
  }

  await postDunningNoteOnTicket(workspaceId, customerId, dunningInternalNote(
    `Terminal billing error: ${errorCode}. Customer has only ${paymentMethodCount} payment method(s). Subscription cancelled — will auto-reactivate if customer adds a new payment method. (No dunning cycle created.)`
  ));
  await tagOpenTickets(workspaceId, customerId, "dunning:terminal");
}
