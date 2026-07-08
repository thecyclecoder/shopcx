/**
 * required-outcomes-validator — Phase 1 of
 * docs/brain/specs/secure-sol-required-outcomes-dispatch.md.
 *
 * Runs BEFORE honorRequiredOutcomes dispatch. Given the ticket's workspace + customer scope and
 * the raw required_outcomes items Sol's box session emitted, decide whether the honor step is
 * even allowed to try to fire them. Blocks and fails-closed on:
 *   - unknown / disallowed action kinds
 *   - missing target ids for kinds that need them
 *   - target subscription/order/product not in the ticket's workspace
 *   - target subscription/order not owned by the ticket's customer
 *
 * A prompt-injected `required_outcomes` item pointing at another customer's contract_id — the
 * exact vulnerability the eliminate-false-promises spec left open — is rejected here before the
 * shared `directActionHandlers` dispatch is ever reached. The caller (Sol's builder-worker box
 * session) treats any blocked verdict as: mark the job needs_attention / log_tail and skip the
 * customer-facing send. The Direction stays durable; a human re-drafts via Improve.
 *
 * Design: pure logic + one supabase read per target. The allowlist lives in code so a static
 * grep answers "what can Sol dispatch?" — no config table sleight-of-hand.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The explicit allowlist of required-outcome kinds Sol's box session is allowed to enqueue for
 * honor-step dispatch. Any kind NOT in this set is rejected upfront (unknown_kind) so a
 * prompt-injected `required_outcomes[].kind` naming an arbitrary handler (or a novel handler we
 * haven't reviewed for customer-scoping safety) can't reach `directActionHandlers`.
 *
 * Grouped by shape so a future addition is easy to review:
 *   - subscription-scoped: need contract_id, verify the sub belongs to (workspace, customer).
 *   - order-scoped: need shopify_order_id / order_number, verify the order belongs to (workspace, customer).
 *   - customer-scoped (no target ids): unsubscribes act on the ticket's own customer.
 *   - Judy-canonical add_bag_to_next_order: intentionally listed even though no handler exists —
 *     honor still fails loudly, keeping the Phase-4 escalation naming intact.
 */
export const ALLOWED_OUTCOME_KINDS: ReadonlySet<string> = new Set<string>([
  // subscription-scoped
  "resume",
  "reactivate",
  "cancel",
  "pause",
  "pause_timed",
  "crisis_pause",
  "apply_coupon",
  "apply_loyalty_coupon",
  "remove_coupon",
  "change_next_date",
  "change_frequency",
  "bill_now",
  "order_now",
  "swap_variant",
  "add_item",
  "remove_item",
  "change_quantity",
  "change_item_quantity",
  "update_line_item_price",
  "add_bag_to_next_order",
  // order-scoped
  "partial_refund",
  "redeem_points_as_refund",
  "create_return",
  "create_replacement",
  // customer-scoped (no external target id)
  "unsubscribe_email_marketing",
  "unsubscribe_sms_marketing",
  "unsubscribe_all_marketing",
]);

/** Per-kind spec of which target ids are required (and therefore MUST re-resolve within scope). */
type TargetShape = {
  needs_contract?: boolean;
  needs_order?: boolean;
  needs_product?: boolean;
};

const KIND_TARGET_SHAPE: Record<string, TargetShape> = {
  resume: { needs_contract: true },
  reactivate: { needs_contract: true },
  cancel: { needs_contract: true },
  pause: { needs_contract: true },
  pause_timed: { needs_contract: true },
  crisis_pause: { needs_contract: true },
  apply_coupon: { needs_contract: true },
  apply_loyalty_coupon: { needs_contract: true },
  remove_coupon: { needs_contract: true },
  change_next_date: { needs_contract: true },
  change_frequency: { needs_contract: true },
  bill_now: { needs_contract: true },
  order_now: { needs_contract: true },
  swap_variant: { needs_contract: true },
  add_item: { needs_contract: true },
  remove_item: { needs_contract: true },
  change_quantity: { needs_contract: true },
  change_item_quantity: { needs_contract: true },
  update_line_item_price: { needs_contract: true },
  add_bag_to_next_order: { needs_contract: true },
  partial_refund: { needs_order: true },
  redeem_points_as_refund: { needs_order: true },
  create_return: { needs_order: true },
  create_replacement: { needs_order: true },
  unsubscribe_email_marketing: {},
  unsubscribe_sms_marketing: {},
  unsubscribe_all_marketing: {},
};

export type OutcomeBlockReason =
  | "unknown_kind"
  | "missing_target_ids"
  | "subscription_not_found"
  | "subscription_customer_mismatch"
  | "order_not_found"
  | "order_customer_mismatch"
  | "product_not_found";

export interface BlockedOutcomeItem {
  index: number;
  kind: string;
  description: string;
  reason: OutcomeBlockReason;
  detail: string;
}

export interface ValidatorItem {
  kind: string;
  description: string;
  target_ids?: Record<string, unknown> | null;
}

export interface ValidatorContext {
  admin: SupabaseClient;
  workspace_id: string;
  ticket_id: string;
  customer_id: string;
  items: ValidatorItem[];
}

export type ValidatorVerdict =
  | { ok: true }
  | { ok: false; blocked: BlockedOutcomeItem[]; reason: string };

function readString(target: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = target?.[key];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Pure predicate over one item — decides which target-id fields must exist for this kind. Split
 * out so tests can drive the shape-check without a Supabase.
 */
export function requiredTargetIdsFor(kind: string): TargetShape {
  return KIND_TARGET_SHAPE[kind] ?? {};
}

/**
 * The Phase-1 validator. Walks the raw items, rejects each one that is not explicitly allowed AND
 * not owned by the ticket's (workspace_id, customer_id) tuple. Any blocked item flips the whole
 * verdict to `ok:false` — the caller MUST block the send.
 *
 * Reads are per-target (each item may hit 0..1 subscriptions/orders/products row). The reads
 * intentionally include `workspace_id` scoping AND the ownership `customer_id` filter, so a
 * mismatched item returns no row and lands as *_not_found / *_customer_mismatch.
 *
 * Kinds that don't take an external target (unsubscribe_*) still pass through the allowlist gate;
 * they act on the ticket's own customer via the shared ActionContext downstream.
 */
export async function validateRequiredOutcomes(ctx: ValidatorContext): Promise<ValidatorVerdict> {
  const blocked: BlockedOutcomeItem[] = [];

  for (let index = 0; index < ctx.items.length; index += 1) {
    const item = ctx.items[index];
    const kind = item.kind;
    const description = item.description;

    if (!ALLOWED_OUTCOME_KINDS.has(kind)) {
      blocked.push({
        index,
        kind,
        description,
        reason: "unknown_kind",
        detail: `kind '${kind}' is not on the required-outcomes allowlist`,
      });
      continue;
    }

    const shape = requiredTargetIdsFor(kind);
    const targets = item.target_ids ?? null;
    const contractId = readString(targets, "contract_id");
    const shopifyOrderId = readString(targets, "shopify_order_id");
    const orderNumber = readString(targets, "order_number");
    const shopifyProductId = readString(targets, "shopify_product_id");
    const productId = readString(targets, "product_id");

    if (shape.needs_contract && !contractId) {
      blocked.push({
        index,
        kind,
        description,
        reason: "missing_target_ids",
        detail: `${kind} requires target_ids.contract_id`,
      });
      continue;
    }
    if (shape.needs_order && !shopifyOrderId && !orderNumber) {
      blocked.push({
        index,
        kind,
        description,
        reason: "missing_target_ids",
        detail: `${kind} requires target_ids.shopify_order_id or target_ids.order_number`,
      });
      continue;
    }

    // ── Ownership re-reads. Every read is scoped by workspace_id AND (where applicable)
    // customer_id, so a target belonging to a different tenant or a different customer returns
    // zero rows and lands as not_found / customer_mismatch. .maybeSingle() so a legitimate
    // absence lands cleanly (no PGRST throw).
    if (shape.needs_contract && contractId) {
      const { data: sub } = await ctx.admin
        .from("subscriptions")
        .select("customer_id, workspace_id")
        .eq("workspace_id", ctx.workspace_id)
        .eq("shopify_contract_id", contractId)
        .maybeSingle();
      if (!sub) {
        blocked.push({
          index,
          kind,
          description,
          reason: "subscription_not_found",
          detail: `contract_id ${contractId} not found in workspace ${ctx.workspace_id}`,
        });
        continue;
      }
      if (String(sub.customer_id) !== ctx.customer_id) {
        blocked.push({
          index,
          kind,
          description,
          reason: "subscription_customer_mismatch",
          detail: `contract_id ${contractId} belongs to a different customer than the ticket`,
        });
        continue;
      }
    }

    if (shape.needs_order && (shopifyOrderId || orderNumber)) {
      let orderQ = ctx.admin
        .from("orders")
        .select("customer_id, workspace_id")
        .eq("workspace_id", ctx.workspace_id);
      if (shopifyOrderId) orderQ = orderQ.eq("shopify_order_id", shopifyOrderId);
      else if (orderNumber) orderQ = orderQ.eq("order_number", orderNumber);
      const { data: order } = await orderQ.maybeSingle();
      if (!order) {
        blocked.push({
          index,
          kind,
          description,
          reason: "order_not_found",
          detail: `order (${shopifyOrderId ?? orderNumber}) not found in workspace ${ctx.workspace_id}`,
        });
        continue;
      }
      if (String(order.customer_id) !== ctx.customer_id) {
        blocked.push({
          index,
          kind,
          description,
          reason: "order_customer_mismatch",
          detail: `order (${shopifyOrderId ?? orderNumber}) belongs to a different customer than the ticket`,
        });
        continue;
      }
    }

    if (shape.needs_product && (shopifyProductId || productId)) {
      let prodQ = ctx.admin
        .from("products")
        .select("workspace_id")
        .eq("workspace_id", ctx.workspace_id);
      if (shopifyProductId) prodQ = prodQ.eq("shopify_product_id", shopifyProductId);
      else if (productId) prodQ = prodQ.eq("id", productId);
      const { data: prod } = await prodQ.maybeSingle();
      if (!prod) {
        blocked.push({
          index,
          kind,
          description,
          reason: "product_not_found",
          detail: `product (${shopifyProductId ?? productId}) not found in workspace ${ctx.workspace_id}`,
        });
        continue;
      }
    }
  }

  if (blocked.length === 0) return { ok: true };
  const reasonParts = blocked.map((b) => `[${b.reason}] "${b.description}": ${b.detail}`);
  return {
    ok: false,
    blocked,
    reason: `required_outcomes validator blocked ${blocked.length} item(s): ${reasonParts.join(" | ")}`,
  };
}
