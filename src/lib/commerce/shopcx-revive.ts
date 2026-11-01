/**
 * Revive / change a never-migrated Appstle subscription ON SHOPCX, built from OUR OWN mirror.
 *
 * Dylan is uninstalling Appstle. What stays on `billing_source='appstle'` after the active-sub
 * migration is ~370 paused subs, thousands of cancelled ones and ~90 payment-troubled actives.
 * When any of them is revived or changed, the action must happen on a ShopCX-owned Shopify
 * contract and must NEVER call Appstle. Two pieces:
 *
 *  - `buildShopcxFromMirror(ws, subscriptionId, intent)` — plans the contract from the
 *    `subscriptions` row (items + prices, cadence, next date, delivery price, shipping method,
 *    discounts, address) with the SAME pricing core `executeMigration` uses (`planMigration`:
 *    MSRP lines, S&S + mix-and-match quantity break from the active `pricing_rules` row, a
 *    per-line grandfather so nobody pays more), creates it through the SAME create builder
 *    (`buildMigratedContractInput` → `shopifyCreateContract`), and flips the row to
 *    `billing_source='shopcx'`. Zero Appstle calls. No bulk backfill: a row is rebuilt only when a
 *    customer (or an agent / cron acting for them) actually touches it.
 *  - `ensureShopcxEngine(ws, contractId, intent)` — the chokepoint every SDK op calls first. A
 *    no-op unless the `appstle_retired` switch is on ([[../appstle-retired]]); then an Appstle sub's
 *    cancel/pause is written to our row only, and any other intent builds the ShopCX contract and
 *    hands the op back to run on the shopcx branch.
 *
 * Card: `payment_method_id` is NULL on Appstle rows, so the card comes from the customer's own
 * Shopify payment methods (`getCustomerPaymentMethods`, the lookup dunning uses). Address: the
 * row's `shipping_address`, falling back to `customers.default_address`. No usable card or address
 * is a TYPED refusal (`needs_payment_method` / `needs_address`) for the caller to route to the
 * add-card / confirm-address step — never a silent failure, never a throw.
 *
 * Idempotent: a compare-and-set claim on `subscriptions.shopcx_revive_claimed_at` plus the created
 * contract id recorded on `shopcx_revive_contract_id` BEFORE the flip, mirroring executeMigration's
 * attempt marker — two concurrent revives never create two contracts, and a retry after a crash
 * adopts the contract the first attempt made.
 *
 * See docs/brain/libraries/commerce__shopcx-revive.md.
 */
import type { PaymentMethod } from "@/lib/dunning";
import { rollForwardToFutureBillingDate } from "@/lib/dunning";
import { normalizeAddress, type RawShippingAddress } from "@/lib/customer-shipping-address";
import {
  planMigration,
  buildMigratedContractInput,
  REQUIRED_ADDRESS_FIELDS,
  type MigrationPlan,
  type PricingContext,
} from "@/lib/commerce/shopify-subscription-migrate";
import { isAppstleRetired } from "@/lib/appstle-retired";
import { errText } from "@/lib/error-text";

// ── Types ───────────────────────────────────────────────────────────────────────────────────

/** What the caller is about to do. cancel/pause never build a contract. */
export type EngineIntent = "cancel" | "pause" | "resume" | "change";

export type ReviveFailureReason =
  | "needs_payment_method"
  | "needs_address"
  | "not_found"
  | "not_appstle"
  | "subscription_cancelled"
  | "local_only_intent"
  | "no_lines"
  | "no_pricing_rule"
  | "plan_blocked"
  | "lookup_failed"
  | "in_progress"
  | "needs_review"
  | "create_failed"
  | "record_failed"
  | "flip_failed";

export type ReviveResult =
  | {
      ok: true;
      /** Bare numeric Shopify contract id now on the row. */
      contractId: string;
      /** true when no new contract was created (row already shopcx, or a prior attempt's contract adopted). */
      reused: boolean;
      /** true when THIS call moved the row off Appstle (created or adopted the contract and flipped). */
      flipped: boolean;
      status: "active" | "paused";
      nextBillingDate: string | null;
      plan?: MigrationPlan;
      /** Customer codes on the Appstle row that were NOT carried (revives drop every code). */
      codesDropped?: string[];
    }
  | { ok: false; reason: ReviveFailureReason; error: string; missing?: string[] };

export interface ReviveOptions {
  /** A date the customer chose (portal reactivate). Rolled forward if it is not in the future. */
  nextBillingDate?: string;
  /** An address the customer just gave (portal address change) — wins over the row + default. */
  address?: RawShippingAddress;
  /** A card the caller wants on the contract (switch-payment-method). Used when it is usable. */
  paymentMethodId?: string;
}

/** The `subscriptions` columns the revive reads. */
export interface MirrorRow {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  shopify_contract_id: string;
  shopify_customer_id: string | null;
  status: string;
  billing_source: string | null;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  items: unknown;
  delivery_price_cents: number | null;
  shipping_method_code: string | null;
  applied_discounts: unknown;
  shipping_address: unknown;
  pause_resume_at: string | null;
  shopcx_revive_claimed_at: string | null;
  shopcx_revive_contract_id: string | null;
}

export const MIRROR_ROW_COLUMNS =
  "id, workspace_id, customer_id, shopify_contract_id, shopify_customer_id, status, billing_source, billing_interval, billing_interval_count, next_billing_date, items, delivery_price_cents, shipping_method_code, applied_discounts, shipping_address, pause_resume_at, shopcx_revive_claimed_at, shopcx_revive_contract_id";

/** A claim older than this is presumed dead (process crashed) and may be re-examined. */
export const REVIVE_CLAIM_STALE_MS = 10 * 60_000;

// ── Pure planning ───────────────────────────────────────────────────────────────────────────

interface MirrorItem {
  sku?: string | null;
  variant_id?: string | number | null;
  quantity?: number | null;
  price_cents?: number | null;
}

/**
 * Mirror `items` → the snapshot-line shape `planMigration` takes.
 *
 * On an Appstle row `price_cents` is the line's `currentPrice` — the customer's own per-unit rate
 * (Appstle bakes S&S and any grandfathering into it) and EXCLUDES customer codes, which live in
 * `applied_discounts`. So it is both the current and the effective unit price, with no code
 * allocation to strip — the planner grandfathers against exactly what they pay today.
 */
export function mirrorItemsToSnapshotLines(items: unknown) {
  const arr = Array.isArray(items) ? (items as MirrorItem[]) : [];
  return arr.map((i) => {
    const cents = i.price_cents == null ? null : Math.round(Number(i.price_cents));
    return {
      sku: i.sku ?? null,
      variant_id: i.variant_id == null ? null : String(i.variant_id),
      quantity: Math.max(1, Number(i.quantity ?? 1) || 1),
      current_price_cents: cents,
      effective_unit_cents: cents,
      code_allocation_unit_cents: 0,
    };
  });
}

/** Contract status for an intent, or a refusal. A change NEVER resurrects a cancelled sub. */
export function targetStatusForIntent(
  rowStatus: string,
  intent: EngineIntent,
): { status: "ACTIVE" | "PAUSED" } | { refuse: ReviveFailureReason; error: string } {
  if (intent === "cancel" || intent === "pause") {
    return { refuse: "local_only_intent", error: `${intent} on an Appstle sub is written locally only — nothing to build` };
  }
  if (intent === "resume") return { status: "ACTIVE" };
  if (rowStatus === "paused") return { status: "PAUSED" };
  if (rowStatus === "cancelled") {
    return { refuse: "subscription_cancelled", error: "subscription is cancelled — only an explicit revive (resume) may rebuild it" };
  }
  return { status: "ACTIVE" };
}

/**
 * The next billing date the contract is created with. Shopify rejects a past date, so a lapsed
 * date ROLLS FORWARD by the customer's own cadence (their billing day survives). A cancelled row
 * carries no date at all (cancel-truth nulls it); a revive then starts tomorrow, matching the
 * portal reactivate default.
 */
export function resolveReviveNextBillingDate(
  rowNext: string | null,
  interval: string | null,
  count: number | null,
  now: Date,
  override?: string,
): string {
  const src = override ?? rowNext;
  const t = src ? new Date(src).getTime() : NaN;
  if (!Number.isFinite(t)) return new Date(now.getTime() + 86_400_000).toISOString();
  if (t > now.getTime()) return new Date(t).toISOString();
  return rollForwardToFutureBillingDate(new Date(t), interval || "month", count || 1, now).toISOString();
}

/**
 * Pick a card the new contract can bill. `getCustomerPaymentMethods` already drops revoked ones;
 * an expired card is skipped here (valid through the END of its expiry month). A caller-preferred
 * card wins when usable. 0/0 expiry (Shop Pay agreements can omit it) counts as usable.
 */
export function pickUsableCard(methods: PaymentMethod[], now: Date, preferredId?: string): PaymentMethod | null {
  const usable = (m: PaymentMethod) => {
    if (!m.expiryYear || !m.expiryMonth) return true;
    const endOfMonth = Date.UTC(m.expiryYear, m.expiryMonth, 1); // first instant of the following month
    return endOfMonth > now.getTime();
  };
  if (preferredId) {
    const pref = methods.find((m) => m.id === preferredId && usable(m));
    if (pref) return pref;
  }
  return methods.find(usable) ?? null;
}

/**
 * The shipping address: an address the caller just supplied, else the row's own, else the
 * customer's default — the first COMPLETE one. Returned in Shopify `MailingAddressInput` shape.
 */
export function resolveReviveAddress(sources: {
  override?: RawShippingAddress;
  row?: RawShippingAddress;
  customerDefault?: RawShippingAddress;
  /**
   * The customer record's own name. ⚠️ Appstle stored the subscription address WITHOUT a name
   * (23,412 of 26,247 never-migrated rows), so without this fallback nearly every old cancelled
   * sub refused to revive with `needs_address (missing lastName)` and the portal had no way out.
   */
  customerName?: { firstName?: string | null; lastName?: string | null };
}): { address: Record<string, string> | null; source: "override" | "subscription" | "default_address" | null; missing: string[] } {
  let firstMissing: string[] = [...REQUIRED_ADDRESS_FIELDS];
  for (const [source, raw] of [
    ["override", sources.override],
    ["subscription", sources.row],
    ["default_address", sources.customerDefault],
  ] as const) {
    const n = normalizeAddress(raw);
    if (!n) continue;
    const mailing: Record<string, string> = {
      address1: n.address1,
      address2: n.address2,
      city: n.city,
      countryCode: n.countryCode,
      firstName: n.firstName || (sources.customerName?.firstName ?? "").trim(),
      lastName: n.lastName || (sources.customerName?.lastName ?? "").trim(),
      phone: n.phone,
      provinceCode: n.provinceCode,
      zip: n.zip,
    };
    for (const k of Object.keys(mailing)) if (!mailing[k]) delete mailing[k];
    const missing = REQUIRED_ADDRESS_FIELDS.filter((k) => !mailing[k]);
    if (!missing.length) return { address: mailing, source, missing: [] };
    if (firstMissing.length === REQUIRED_ADDRESS_FIELDS.length) firstMissing = missing;
  }
  return { address: null, source: null, missing: firstMissing };
}

interface MirrorDiscount {
  title?: string | null;
  type?: string | null;
  targetType?: string | null;
  value?: number | null;
  valueType?: string | null;
}

/**
 * Customer codes on the mirror's `applied_discounts` that a revive DROPS (Dylan 2026-10-26:
 * "Drop all codes"). The mirror has no usage count, so a carried code would recur forever,
 * including one-time LOYALTY redemptions. A revived sub prices from our rules (S&S + Buy 2/3,
 * recomputed by the planner) and keeps its delivery price; CS can re-add a code by hand.
 *
 * Structural discounts and "Buy N Discount" percentage codes are not listed: the planner
 * recomputes those. Every other code is returned BY NAME so the caller can surface it.
 */
export function droppedMirrorCodes(appliedDiscounts: unknown): string[] {
  const arr = Array.isArray(appliedDiscounts) ? (appliedDiscounts as MirrorDiscount[]) : [];
  const dropped: string[] = [];
  for (const d of arr) {
    const title = String(d.title ?? "code");
    if (String(d.type ?? "") !== "CODE_DISCOUNT") continue; // structural — recomputed by the planner
    const pct = String(d.valueType ?? "").toUpperCase() === "PERCENTAGE";
    if (pct && /^buy\s*\d/i.test(title)) continue; // a quantity break — recomputed
    dropped.push(title);
  }
  return dropped;
}

function humanizeShippingCode(code: string): string {
  return code.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The whole mirror → contract-input mapping, PURE. Everything `buildShopcxFromMirror` decides
 * before it touches Shopify happens here, so it can be tested without a fake GraphQL.
 */
export function planShopcxFromMirror(input: {
  row: MirrorRow;
  intent: EngineIntent;
  ctx: PricingContext;
  card: PaymentMethod | null;
  customerGid: string | null;
  address: ReturnType<typeof resolveReviveAddress>;
  now: Date;
  nextBillingDateOverride?: string;
}):
  | {
      ok: true;
      status: "ACTIVE" | "PAUSED";
      nextBillingDate: string;
      plan: MigrationPlan;
      createInput: ReturnType<typeof buildMigratedContractInput>;
      codesDropped: string[];
    }
  | { ok: false; reason: ReviveFailureReason; error: string; missing?: string[] } {
  const { row } = input;
  const target = targetStatusForIntent(row.status, input.intent);
  if ("refuse" in target) return { ok: false, reason: target.refuse, error: target.error };
  if (!input.address.address) {
    return { ok: false, reason: "needs_address", error: `no complete shipping address (missing ${input.address.missing.join(", ")})`, missing: input.address.missing };
  }
  if (!input.customerGid || !input.card) {
    return {
      ok: false,
      reason: "needs_payment_method",
      error: input.customerGid ? "the customer has no usable (unrevoked, unexpired) Shopify payment method" : "no Shopify customer id on the row or the customer",
    };
  }

  const plan = planMigration(
    {
      appstle_contract_id: row.shopify_contract_id,
      subscription_id: row.id,
      // The TARGET status — a revive of a cancelled sub is exactly what the planner's
      // CANCELLED block exists to stop when the source is a live Appstle read; here it is intended.
      status: target.status,
      payment_method_id: input.card.id,
      payment_method_revoked: false,
      lines: mirrorItemsToSnapshotLines(row.items),
      raw: { deliveryMethod: { address: input.address.address } },
    },
    input.ctx,
  );
  if (plan.blocked) {
    if (plan.blocked === "no_lines_after_rules") return { ok: false, reason: "no_lines", error: `nothing billable on the row (${plan.dropped.map((d) => `${d.sku ?? "?"}:${d.reason}`).join(", ") || "no items"})` };
    return { ok: false, reason: "plan_blocked", error: plan.blocked };
  }

  const nextBillingDate = resolveReviveNextBillingDate(
    row.next_billing_date, row.billing_interval, row.billing_interval_count, input.now, input.nextBillingDateOverride,
  );
  const code = row.shipping_method_code ? String(row.shipping_method_code) : "";
  const createInput = buildMigratedContractInput({
    customerGid: input.customerGid,
    status: target.status,
    paymentMethodId: input.card.id,
    interval: String(row.billing_interval || "month"),
    intervalCount: Number(row.billing_interval_count || 1),
    nextBillingDate,
    // ⭐ KEEP the existing delivery price (Dylan's shipping rule) — never zeroed.
    deliveryPriceCents: row.delivery_price_cents ?? 0,
    address: input.address.address,
    shippingOption: code ? { code, title: humanizeShippingCode(code) } : null,
    plan,
  });
  return { ok: true, status: target.status, nextBillingDate, plan, createInput, codesDropped: droppedMirrorCodes(row.applied_discounts) };
}

// ── I/O seams ───────────────────────────────────────────────────────────────────────────────

export interface ReviveCustomer {
  shopify_customer_id: string | null;
  default_address: unknown;
  first_name?: string | null;
  last_name?: string | null;
}

export interface ReviveDeps {
  now(): Date;
  loadRow(workspaceId: string, subscriptionId: string): Promise<MirrorRow | null>;
  loadCustomer(workspaceId: string, customerId: string): Promise<ReviveCustomer | null>;
  listPaymentMethods(workspaceId: string, shopifyCustomerId: string): Promise<PaymentMethod[]>;
  loadPricingContext(workspaceId: string): Promise<PricingContext | null>;
  /** Compare-and-set: stamp `shopcx_revive_claimed_at = nowIso` only if it still equals `prev` and the row is still appstle. */
  claim(subscriptionId: string, prev: string | null, nowIso: string): Promise<boolean>;
  recordContract(subscriptionId: string, contractId: string): Promise<{ error?: string }>;
  findOrphans(workspaceId: string, customerGid: string, sinceIso: string): Promise<{ id: string }[]>;
  createContract(workspaceId: string, input: ReturnType<typeof buildMigratedContractInput>): Promise<{ success: boolean; error?: string; contractId?: string }>;
  syncSchedule(workspaceId: string, contractId: string, firstDate: string): Promise<void>;
  /** Flip the row (only while still appstle). Returns how many rows matched. */
  flip(subscriptionId: string, update: Record<string, unknown>): Promise<{ matched: number; error?: string }>;
  mirrorPricing(workspaceId: string, contractId: string): Promise<void>;
}

const bare = (id: string) => String(id).replace("gid://shopify/SubscriptionContract/", "");
const customerGidOf = (id: string | null | undefined) =>
  id ? (String(id).startsWith("gid://") ? String(id) : `gid://shopify/Customer/${id}`) : null;

export function defaultReviveDeps(): ReviveDeps {
  const admin = async () => (await import("@/lib/supabase/admin")).createAdminClient();
  return {
    now: () => new Date(),
    async loadRow(workspaceId, subscriptionId) {
      const { data, error } = await (await admin())
        .from("subscriptions").select(MIRROR_ROW_COLUMNS)
        .eq("workspace_id", workspaceId).eq("id", subscriptionId).maybeSingle();
      if (error) throw new Error(`subscriptions read failed: ${error.message}`);
      return (data as unknown as MirrorRow | null) ?? null;
    },
    async loadCustomer(workspaceId, customerId) {
      const { data } = await (await admin())
        .from("customers").select("shopify_customer_id, default_address, first_name, last_name")
        .eq("workspace_id", workspaceId).eq("id", customerId).maybeSingle();
      return (data as ReviveCustomer | null) ?? null;
    },
    async listPaymentMethods(workspaceId, shopifyCustomerId) {
      const { getCustomerPaymentMethods } = await import("@/lib/dunning");
      return getCustomerPaymentMethods(workspaceId, shopifyCustomerId);
    },
    async loadPricingContext(workspaceId) {
      const { activePricingRuleId } = await import("@/lib/commerce/shopcx-line-ops");
      const ruleId = await activePricingRuleId(workspaceId);
      if (!ruleId) return null;
      const { loadPricingContext } = await import("@/lib/commerce/shopify-subscription-migrate");
      return loadPricingContext(workspaceId, ruleId);
    },
    async claim(subscriptionId, prev, nowIso) {
      let q = (await admin())
        .from("subscriptions")
        .update({ shopcx_revive_claimed_at: nowIso })
        .eq("id", subscriptionId)
        .eq("billing_source", "appstle")
        .is("shopcx_revive_contract_id", null);
      q = prev ? q.eq("shopcx_revive_claimed_at", prev) : q.is("shopcx_revive_claimed_at", null);
      const { data, error } = await q.select("id");
      if (error) throw new Error(`revive claim failed: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    async recordContract(subscriptionId, contractId) {
      const { error } = await (await admin())
        .from("subscriptions").update({ shopcx_revive_contract_id: contractId }).eq("id", subscriptionId);
      return error ? { error: error.message } : {};
    },
    async findOrphans(workspaceId, customerGid, sinceIso) {
      const { findCustomerContractsCreatedSince } = await import("@/lib/commerce/shopify-subscription-migrate");
      return findCustomerContractsCreatedSince(workspaceId, customerGid, sinceIso);
    },
    async createContract(workspaceId, input) {
      const { shopifyCreateContract } = await import("@/lib/commerce/shopify-subscription-client");
      return shopifyCreateContract(workspaceId, input);
    },
    async syncSchedule(workspaceId, contractId, firstDate) {
      // Non-fatal by design, exactly as in executeMigration: the customer is billed by explicit
      // cycle selector, so an unsynced schedule is a display problem, not a billing one.
      try {
        const { shopifySyncBillingSchedule } = await import("@/lib/commerce/shopify-subscription-client");
        await shopifySyncBillingSchedule(workspaceId, contractId, { firstDate });
      } catch (e) {
        console.error(`[shopcx-revive] ${contractId}: schedule sync threw (non-fatal):`, e instanceof Error ? e.message : e);
      }
    },
    async flip(subscriptionId, update) {
      const { data, error } = await (await admin())
        .from("subscriptions").update(update)
        .eq("id", subscriptionId).eq("billing_source", "appstle")
        .select("id");
      return { matched: data?.length ?? 0, error: error?.message };
    },
    async mirrorPricing(workspaceId, contractId) {
      try {
        const { mirrorContractPricing } = await import("@/lib/commerce/shopcx-contract-ingest");
        const m = await mirrorContractPricing(workspaceId, contractId);
        if (!m.ok) console.error(`[shopcx-revive] ${contractId}: pricing mirror failed (non-fatal): ${m.error}`);
      } catch (e) {
        console.error(`[shopcx-revive] ${contractId}: pricing mirror threw (non-fatal):`, e instanceof Error ? e.message : e);
      }
    },
  };
}

// ── buildShopcxFromMirror ───────────────────────────────────────────────────────────────────

/**
 * Build (or reuse) the ShopCX contract for an Appstle-billed `subscriptions` row, from the row
 * itself. Makes ZERO Appstle calls. Never throws for a business outcome — every refusal is typed.
 */
export async function buildShopcxFromMirror(
  workspaceId: string,
  subscriptionId: string,
  intent: EngineIntent,
  opts: ReviveOptions = {},
  deps: ReviveDeps = defaultReviveDeps(),
): Promise<ReviveResult> {
  const now = deps.now();
  let row: MirrorRow | null;
  try {
    row = await deps.loadRow(workspaceId, subscriptionId);
  } catch (e) {
    return { ok: false, reason: "lookup_failed", error: errText(e) };
  }
  if (!row) return { ok: false, reason: "not_found", error: `subscription ${subscriptionId} not found` };

  // Already rebuilt (by us or a concurrent revive) — reuse, never create a second contract.
  if (row.billing_source === "shopcx") {
    return {
      ok: true, contractId: row.shopify_contract_id, reused: true, flipped: false,
      status: row.status === "paused" ? "paused" : "active", nextBillingDate: row.next_billing_date,
    };
  }
  if (row.billing_source !== "appstle" && row.billing_source != null) {
    return { ok: false, reason: "not_appstle", error: `billing_source is ${row.billing_source}` };
  }

  const target = targetStatusForIntent(row.status, intent);
  if ("refuse" in target) return { ok: false, reason: target.refuse, error: target.error };

  // ── A previous attempt already created the contract: adopt it and finish the flip. ──
  if (row.shopcx_revive_contract_id) {
    return flipRow(deps, row, bare(row.shopcx_revive_contract_id), target.status,
      resolveReviveNextBillingDate(row.next_billing_date, row.billing_interval, row.billing_interval_count, now, opts.nextBillingDate),
      true);
  }

  // ── Gather (read-only) ──
  const customer = row.customer_id ? await deps.loadCustomer(workspaceId, row.customer_id).catch(() => null) : null;
  const customerGid = customerGidOf(row.shopify_customer_id ?? customer?.shopify_customer_id ?? null);
  const address = resolveReviveAddress({
    override: opts.address,
    row: row.shipping_address as RawShippingAddress,
    customerDefault: customer?.default_address as RawShippingAddress,
    customerName: { firstName: customer?.first_name, lastName: customer?.last_name },
  });
  if (!address.address) {
    return { ok: false, reason: "needs_address", error: `no complete shipping address (missing ${address.missing.join(", ")})`, missing: address.missing };
  }
  let card: PaymentMethod | null = null;
  if (customerGid) {
    try {
      const methods = await deps.listPaymentMethods(workspaceId, customerGid.replace("gid://shopify/Customer/", ""));
      card = pickUsableCard(methods, now, opts.paymentMethodId);
    } catch (e) {
      return { ok: false, reason: "lookup_failed", error: `payment method lookup failed: ${errText(e)}` };
    }
  }
  let ctx: PricingContext | null;
  try {
    ctx = await deps.loadPricingContext(workspaceId);
  } catch (e) {
    return { ok: false, reason: "lookup_failed", error: `pricing context failed: ${errText(e)}` };
  }
  if (!ctx) return { ok: false, reason: "no_pricing_rule", error: "no active pricing rule" };

  const planned = planShopcxFromMirror({
    row, intent, ctx, card, customerGid, address, now, nextBillingDateOverride: opts.nextBillingDate,
  });
  if (!planned.ok) return planned;

  // ── Claim (compare-and-set) so two concurrent revives never create two contracts ──
  const nowIso = now.toISOString();
  if (row.shopcx_revive_claimed_at) {
    const age = now.getTime() - new Date(row.shopcx_revive_claimed_at).getTime();
    if (age < REVIVE_CLAIM_STALE_MS) {
      return { ok: false, reason: "in_progress", error: `a revive of this subscription started ${Math.round(age / 1000)}s ago` };
    }
    // Stale claim, no recorded contract: the create's outcome is unknown. LOOK before creating —
    // a contract Shopify committed whose response we lost must be adopted, not duplicated.
    let orphans: { id: string }[];
    try {
      orphans = await deps.findOrphans(workspaceId, customerGid as string, row.shopcx_revive_claimed_at);
    } catch (e) {
      return { ok: false, reason: "lookup_failed", error: `orphan lookup failed: ${errText(e)}` };
    }
    if (orphans.length > 1) {
      return { ok: false, reason: "needs_review", error: `${orphans.length} contracts were created for this customer since the last revive attempt — a human must pick one` };
    }
    if (orphans.length === 1) {
      const adopted = bare(orphans[0].id);
      const rec = await deps.recordContract(row.id, adopted);
      if (rec.error) return { ok: false, reason: "record_failed", error: `adopted ${adopted} but could not record it: ${rec.error}` };
      return flipRow(deps, row, adopted, planned.status, planned.nextBillingDate, true);
    }
  }
  let claimed: boolean;
  try {
    claimed = await deps.claim(row.id, row.shopcx_revive_claimed_at, nowIso);
  } catch (e) {
    return { ok: false, reason: "lookup_failed", error: errText(e) };
  }
  if (!claimed) {
    // Lost the race. If the winner already flipped, reuse its contract.
    const again = await deps.loadRow(workspaceId, subscriptionId).catch(() => null);
    if (again?.billing_source === "shopcx") {
      return {
        ok: true, contractId: again.shopify_contract_id, reused: true, flipped: false,
        status: again.status === "paused" ? "paused" : "active", nextBillingDate: again.next_billing_date,
      };
    }
    return { ok: false, reason: "in_progress", error: "another revive of this subscription holds the claim" };
  }

  // ── Create ──
  const created = await deps.createContract(workspaceId, planned.createInput);
  if (!created.success || !created.contractId) {
    return { ok: false, reason: "create_failed", error: created.error ?? "create returned no contract" };
  }
  const newId = bare(created.contractId);
  // Record IMMEDIATELY — the marker is the only thing between a retry and a second live contract.
  const rec = await deps.recordContract(row.id, newId);
  if (rec.error) {
    return { ok: false, reason: "record_failed", error: `created ${newId} but could not record it: ${rec.error} — DO NOT retry blind` };
  }
  await deps.syncSchedule(workspaceId, newId, planned.nextBillingDate);
  const flipped = await flipRow(deps, row, newId, planned.status, planned.nextBillingDate, false);
  if (!flipped.ok) return flipped;
  return {
    ...flipped,
    plan: planned.plan,
    codesDropped: planned.codesDropped,
  };
}

async function flipRow(
  deps: ReviveDeps,
  row: MirrorRow,
  newContractId: string,
  status: "ACTIVE" | "PAUSED",
  nextBillingDate: string,
  reused: boolean,
): Promise<ReviveResult> {
  const local = status === "PAUSED" ? "paused" : "active";
  const update: Record<string, unknown> = {
    shopify_contract_id: newContractId,
    billing_source: "shopcx",
    // An old (Appstle) id keeps resolving to this row — resolveLiveContractId / findSubByContractRef.
    migrated_from_contract_id: row.shopify_contract_id,
    status: local,
    next_billing_date: nextBillingDate,
    updated_at: new Date().toISOString(),
  };
  // A revived (active) sub has no pending auto-resume; a paused one keeps its resume date.
  if (local === "active") update.pause_resume_at = null;
  const r = await deps.flip(row.id, update);
  if (r.error) return { ok: false, reason: "flip_failed", error: `contract ${newContractId} exists but the row flip failed: ${r.error}` };
  if (!r.matched) {
    return { ok: false, reason: "flip_failed", error: `contract ${newContractId} exists but the row was no longer appstle-billed — re-run to adopt` };
  }
  await deps.mirrorPricing(row.workspace_id, newContractId);
  return { ok: true, contractId: newContractId, reused, flipped: true, status: local, nextBillingDate };
}

// ── ensureShopcxEngine — the chokepoint ─────────────────────────────────────────────────────

export type EnsureResult =
  | {
      ok: true;
      /** The contract id the caller must use from here on (rebound when a contract was built). */
      contractId: string;
      /** The engine to dispatch on. null when the switch is off (the caller resolves as before). */
      engine: "internal" | "shopcx" | "appstle" | null;
      /** THIS call moved the row off Appstle onto a ShopCX contract (created, or a prior attempt's adopted). */
      built: boolean;
      /** cancel/pause on a retired-Appstle sub: our row was updated; the caller must NOT call a vendor. */
      handledLocally: boolean;
    }
  | { ok: false; reason: ReviveFailureReason; error: string; missing?: string[] };

export interface EnsureDeps {
  isRetired(): Promise<boolean>;
  resolveLive(workspaceId: string, contractId: string): Promise<string>;
  resolveEngine(workspaceId: string, contractId: string): Promise<"internal" | "shopcx" | "appstle">;
  findSubscriptionId(workspaceId: string, contractId: string): Promise<string | null>;
  applyLocalStatus(
    workspaceId: string,
    contractId: string,
    action: "pause" | "cancel",
    opts?: { cancelReason?: string; cancelledBy?: string },
  ): Promise<void>;
  build(workspaceId: string, subscriptionId: string, intent: EngineIntent, opts: ReviveOptions): Promise<ReviveResult>;
}

export function defaultEnsureDeps(): EnsureDeps {
  return {
    isRetired: isAppstleRetired,
    async resolveLive(workspaceId, contractId) {
      const { resolveLiveContractId } = await import("@/lib/internal-subscription");
      return resolveLiveContractId(workspaceId, contractId);
    },
    async resolveEngine(workspaceId, contractId) {
      const { resolveBillingSource } = await import("@/lib/internal-subscription");
      return resolveBillingSource(workspaceId, contractId);
    },
    async findSubscriptionId(workspaceId, contractId) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const { data } = await createAdminClient()
        .from("subscriptions").select("id")
        .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).maybeSingle();
      return (data as { id: string } | null)?.id ?? null;
    },
    async applyLocalStatus(workspaceId, contractId, action, opts) {
      const { applySubscriptionStatusTruth } = await import("@/lib/commerce/subscription-status-truth");
      await applySubscriptionStatusTruth(workspaceId, contractId, action, opts);
    },
    build: (ws, subId, intent, opts) => buildShopcxFromMirror(ws, subId, intent, opts),
  };
}

/**
 * The chokepoint. Call at the top of every subscription op, before dispatching on the engine.
 *
 *  - switch OFF → `{ ok, contractId (unchanged), engine: null }` — the caller behaves EXACTLY as
 *    before. Production does not change until Dylan sets `appstle_retired`.
 *  - switch ON, engine not appstle → the live contract id + its engine; nothing else happens.
 *  - switch ON, appstle, cancel/pause → our row only (`applySubscriptionStatusTruth`: status,
 *    cancel-truth, ends dunning, customer rollup). `handledLocally: true` — no vendor call.
 *  - switch ON, appstle, anything else → `buildShopcxFromMirror`; on success the caller continues
 *    on the shopcx branch with the NEW contract id.
 */
export async function ensureShopcxEngine(
  workspaceId: string,
  contractId: string,
  intent: EngineIntent,
  opts: ReviveOptions & { cancelReason?: string; cancelledBy?: string } = {},
  deps: EnsureDeps = defaultEnsureDeps(),
): Promise<EnsureResult> {
  if (!(await deps.isRetired())) {
    return { ok: true, contractId, engine: null, built: false, handledLocally: false };
  }
  const live = await deps.resolveLive(workspaceId, contractId);
  const engine = await deps.resolveEngine(workspaceId, live);
  if (engine !== "appstle") return { ok: true, contractId: live, engine, built: false, handledLocally: false };

  if (intent === "cancel" || intent === "pause") {
    await deps.applyLocalStatus(workspaceId, live, intent, { cancelReason: opts.cancelReason, cancelledBy: opts.cancelledBy });
    return { ok: true, contractId: live, engine: "appstle", built: false, handledLocally: true };
  }

  const subId = await deps.findSubscriptionId(workspaceId, live);
  if (!subId) return { ok: false, reason: "not_found", error: `no subscription row for contract ${live}` };
  const r = await deps.build(workspaceId, subId, intent, {
    nextBillingDate: opts.nextBillingDate, address: opts.address, paymentMethodId: opts.paymentMethodId,
  });
  if (!r.ok) return r;
  return { ok: true, contractId: r.contractId, engine: "shopcx", built: r.flipped, handledLocally: false };
}

/** One-line error text for an op that must return `{ success:false, error }`. */
export function ensureFailureText(r: { reason: ReviveFailureReason; error: string }): string {
  return `${r.reason}: ${r.error}`;
}
