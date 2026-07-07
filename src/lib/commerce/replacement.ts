/**
 * commerce/replacement.ts — Display + mutation ops for replacements.
 *
 * DISPLAY: A replacement is created from a source order and can adjust the
 * linked subscription's next billing date — that side effect belongs on the
 * Mutation op, not on any surface. See
 * [[../../docs/brain/libraries/replacement-order]].
 *
 * MUTATION:
 *  - `issueReplacement` — thin SDK wrapper over [[../replacement-order]]
 *    `createReplacementOrder`. The SDK-side surface every future callsite
 *    consumes.
 *  - `issueDollarReplacement` — the $-bearing variant (Phase 3 of the
 *    `commerce-sdk-actions-…` spec). Combines `issueReplacement` with either
 *    `commerce/refund.issueRefund` (refund half) OR
 *    `commerce/subscription.subscriptionOrderNow` (upcharge half) inside a
 *    shared txn boundary: if the money half fails, the just-created
 *    replacement is rolled back (compensating delete on the replacements
 *    row) so no orphan record survives. On refund success, mirrors an
 *    `order_refunds` row (best-effort — the M1 spec ships the mirror table).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReplacementView } from "./types";
import type { IssueRefundResult } from "./refund";

export type { ReplacementView } from "./types";

const REPLACEMENT_COLUMNS =
  "id, workspace_id, customer_id, original_order_id, original_order_number, replacement_order_id, subscription_id, reason, reason_detail, status, customer_error, items, address_validated, subscription_adjusted, new_next_billing_date, created_at";

interface RawReplacementRow {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  original_order_id: string | null;
  original_order_number: string | null;
  replacement_order_id: string | null;
  subscription_id: string | null;
  reason: string | null;
  reason_detail: string | null;
  status: string | null;
  customer_error: boolean | null;
  items: unknown;
  address_validated: boolean | null;
  subscription_adjusted: boolean | null;
  new_next_billing_date: string | null;
  created_at: string;
}

function coerceStatus(s: string | null): ReplacementView["status"] {
  const allowed: ReplacementView["status"][] = ["pending", "shipped", "delivered", "cancelled"];
  if (s && (allowed as string[]).includes(s)) return s as ReplacementView["status"];
  return "pending";
}

function buildItems(items: unknown): ReplacementView["items"] {
  if (!Array.isArray(items)) return [];
  return (items as Array<Record<string, unknown>>).map((it) => ({
    variant_id: it.variant_id != null ? String(it.variant_id) : null,
    title: typeof it.title === "string" ? it.title : "",
    quantity: Number(it.quantity ?? 1),
  }));
}

function buildReplacementView(row: RawReplacementRow): ReplacementView {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    customer_id: row.customer_id,
    original_order_id: row.original_order_id,
    original_order_number: row.original_order_number,
    replacement_order_id: row.replacement_order_id,
    subscription_id: row.subscription_id,
    reason: row.reason ?? "",
    reason_detail: row.reason_detail,
    status: coerceStatus(row.status),
    customer_error: Boolean(row.customer_error),
    items: buildItems(row.items),
    address_validated: Boolean(row.address_validated),
    subscription_adjusted: Boolean(row.subscription_adjusted),
    new_next_billing_date: row.new_next_billing_date,
    created_at: row.created_at,
  };
}

export interface ReplacementListFilters {
  customer_id?: string;
  status?: ReplacementView["status"];
  page_size?: number;
  max_rows?: number;
}

/**
 * Fetch one replacement by internal UUID. Throws if the replacement is
 * missing or not in the given workspace.
 */
export async function getReplacement(
  workspaceId: string,
  replacementId: string,
): Promise<ReplacementView> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("replacements")
    .select(REPLACEMENT_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", replacementId)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new Error(
      `getReplacement: not found — workspace=${workspaceId} replacement=${replacementId}`,
    );
  return buildReplacementView(data as RawReplacementRow);
}

/**
 * All replacements belonging to one customer. Walks past the 1000-row cap via
 * cursor pagination on `(created_at DESC, id DESC)`. Direct `customer_id`
 * match — link-follow is a caller-side concern.
 */
export async function listReplacementsByCustomer(
  workspaceId: string,
  customerId: string,
): Promise<ReplacementView[]> {
  return listReplacements(workspaceId, { customer_id: customerId });
}

/**
 * List replacements for a workspace with cursor-pagination past the 1000-row
 * cap.
 */
export async function listReplacements(
  workspaceId: string,
  filters: ReplacementListFilters = {},
): Promise<ReplacementView[]> {
  const admin = createAdminClient();
  const pageSize = Math.max(1, Math.min(1000, filters.page_size ?? 500));
  const maxRows = filters.max_rows ?? Number.POSITIVE_INFINITY;

  const out: ReplacementView[] = [];
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  while (out.length < maxRows) {
    let q = admin.from("replacements").select(REPLACEMENT_COLUMNS).eq("workspace_id", workspaceId);
    if (filters.customer_id) q = q.eq("customer_id", filters.customer_id);
    if (filters.status) q = q.eq("status", filters.status);
    if (cursorCreatedAt && cursorId) {
      q = q.or(
        `created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${cursorId})`,
      );
    }
    q = q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(pageSize);

    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as RawReplacementRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (out.length >= maxRows) break;
      out.push(buildReplacementView(row));
    }
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
  }

  return out;
}

// ── Mutation ops ─────────────────────────────────────────────────────

export interface IssueReplacementArgs {
  customerId: string;
  shopifyCustomerId: string;
  items: Array<{ variantId: string; quantity: number; title?: string }>;
  shippingAddress: {
    firstName?: string;
    lastName?: string;
    address1: string;
    address2?: string;
    city: string;
    province?: string;
    provinceCode?: string;
    zip: string;
    countryCode?: string;
  };
  reason: string;
  originalOrderNumber?: string | null;
  ticketId?: string | null;
  subscriptionId?: string | null;
  customerError?: boolean;
  shopifyNote?: string;
  initiatedBy?: "ai" | "agent" | "script" | "playbook";
  initiatedByName?: string;
}

export interface IssueReplacementResult {
  success: boolean;
  replacementId: string;
  shopifyOrderName: string | null;
  error?: string;
}

/**
 * SDK-side wrapper for creating a replacement order. Delegates to
 * [[../replacement-order]] `createReplacementOrder`, which is the shared
 * implementation (record-first insert, Shopify draft+complete, status
 * stamp — same contract). Callers point at the SDK wrapper so future
 * concerns (per-workspace policy checks, mirror writes) drop in here
 * without touching every callsite.
 */
export async function issueReplacement(
  workspaceId: string,
  args: IssueReplacementArgs,
): Promise<IssueReplacementResult> {
  if (!workspaceId) return { success: false, replacementId: "", shopifyOrderName: null, error: "workspaceId is required" };
  if (!args.customerId) return { success: false, replacementId: "", shopifyOrderName: null, error: "customerId is required" };
  const { createReplacementOrder } = await import("@/lib/replacement-order");
  return createReplacementOrder({ workspaceId, ...args });
}

// ── $-bearing replacement variant (Phase 3) ─────────────────────────

export interface DollarReplacementRefundArgs {
  orderId: string;
  amountCents: number;
  reason: string;
  source?: string;
  eventProperties?: Record<string, unknown>;
  /** Stable action-identity key threaded down to `refundOrder` so an
   *  Inngest step retry / self-heal re-drive of the same
   *  `dollar_replacement` action short-circuits at the pre-dispatch
   *  guard instead of double-refunding. Handlers derive this from
   *  their ticket_id via `hashActionRefundKey` — see
   *  [[../refund]] Phase 2. */
  requestKey?: string;
}

export interface DollarReplacementUpchargeArgs {
  contractId: string;
}

export interface DollarReplacementArgs extends IssueReplacementArgs {
  /** The refund half — money moves BACK to the customer. Mutually
   *  exclusive with `upcharge`. */
  refund?: DollarReplacementRefundArgs;
  /** The upcharge half — the customer pays for the replacement via a
   *  fresh subscription bill_now. Mutually exclusive with `refund`. */
  upcharge?: DollarReplacementUpchargeArgs;
}

export interface DollarReplacementResult {
  success: boolean;
  replacementId?: string;
  shopifyOrderName?: string | null;
  refundResult?: IssueRefundResult;
  upchargeResult?: { success: boolean; error?: string; summary?: string };
  orderRefundsMirrored?: boolean;
  error?: string;
  rolledBack?: boolean;
}

/**
 * Injectable delegates so the atomicity harness (node:test) can drive
 * `issueDollarReplacement` deterministically without standing up Supabase +
 * Shopify + Braintree. Real callers omit the `_deps` param and get the
 * production wiring; the test overrides each with a spy/stub.
 */
export interface DollarReplacementDeps {
  issueReplacement: (
    workspaceId: string,
    args: IssueReplacementArgs,
  ) => Promise<IssueReplacementResult>;
  issueRefund: (
    workspaceId: string,
    args: {
      orderId: string;
      amountCents: number;
      reason: string;
      source?: string;
      customerId?: string | null;
      eventProperties?: Record<string, unknown>;
      requestKey?: string;
    },
  ) => Promise<IssueRefundResult>;
  subscriptionOrderNow: (
    workspaceId: string,
    contractId: string,
  ) => Promise<{ success: boolean; error?: string; summary?: string }>;
  rollbackReplacement: (workspaceId: string, replacementId: string) => Promise<{ deleted: boolean }>;
  writeOrderRefundMirror: (
    workspaceId: string,
    mirror: {
      order_id: string;
      replacement_id: string;
      amount_cents: number;
      method: string | null;
      refund_id: string | null;
      reason: string;
    },
  ) => Promise<{ inserted: boolean }>;
}

/** Real-wiring default deps. Test suites override each via the `_deps`
 *  optional param. */
async function defaultDollarReplacementDeps(): Promise<DollarReplacementDeps> {
  const [{ issueRefund }, subMod] = await Promise.all([
    import("./refund"),
    import("./subscription"),
  ]);
  return {
    issueReplacement,
    issueRefund,
    subscriptionOrderNow: subMod.subscriptionOrderNow,
    rollbackReplacement: async (workspaceId, replacementId) => {
      // Compensating rollback. Guard predicates:
      //  - workspace_id scope (never reach across tenants)
      //  - id specificity (exactly one row)
      //  - status NOT IN ('shipped','delivered') so a race where the
      //    replacement already shipped between create + refund can't
      //    destroy a fulfilled row.
      //  - .select('id') to assert exactly one row transitioned; zero
      //    → treat as no-op (already rolled back / already shipped),
      //    do not error out.
      const admin = createAdminClient();
      const { data, error } = await admin
        .from("replacements")
        .delete()
        .eq("workspace_id", workspaceId)
        .eq("id", replacementId)
        .not("status", "in", "(shipped,delivered)")
        .select("id");
      if (error) {
        console.error("[issueDollarReplacement] rollback delete failed:", error.message);
        return { deleted: false };
      }
      return { deleted: (data ?? []).length === 1 };
    },
    writeOrderRefundMirror: async (workspaceId, mirror) => {
      // Best-effort mirror write. The M1 spec ships the order_refunds
      // table; until it does, this insert may fail with "relation
      // does not exist" — log + move on. The refund itself already
      // succeeded (money moved) so a mirror miss is not a rollback
      // trigger.
      try {
        const admin = createAdminClient();
        const { error } = await admin.from("order_refunds").insert({
          workspace_id: workspaceId,
          order_id: mirror.order_id,
          replacement_id: mirror.replacement_id,
          amount_cents: mirror.amount_cents,
          method: mirror.method,
          refund_id: mirror.refund_id,
          reason: mirror.reason,
        });
        if (error) {
          console.warn("[issueDollarReplacement] order_refunds mirror write failed:", error.message);
          return { inserted: false };
        }
        return { inserted: true };
      } catch (e) {
        console.warn("[issueDollarReplacement] order_refunds mirror write threw:", e);
        return { inserted: false };
      }
    },
  };
}

/**
 * Create a replacement AND move money in the same operation, atomically.
 *
 * Two variants:
 *  - `refund` — customer gets both a replacement shipment AND cash back.
 *    Used when we shipped something the customer needs BUT some money
 *    should refund (e.g. shipping protection they paid for that
 *    didn't help, or a partial refund on the item that had defects).
 *    Writes an `order_refunds` mirror row on the refund order for
 *    audit — the shared choke point for future refund reconciliation.
 *  - `upcharge` — customer gets a replacement they PAY for, billed as a
 *    fresh subscription order via `subscriptionOrderNow`. Used when
 *    the customer is due a replacement but there's a legitimate charge
 *    (upgrade, add-on).
 *
 * Atomicity (compensating rollback):
 *   1. Create the replacement first (record-first: replacements row +
 *      Shopify draft-complete).
 *   2. Do the money half.
 *   3. If the money half fails, roll back the replacements row via
 *      `rollbackReplacement` — a workspace-scoped, id-specific delete
 *      guarded so a fulfilled row (`status IN ('shipped','delivered')`)
 *      is never destroyed.
 *
 * The Shopify order is created inline with step 1 and cannot itself be
 * "rolled back" — the rollback removes the DB record so we don't carry
 * an orphan replacement. Callers relying on the invariant "no
 * replacements row without matching money movement" get it from this
 * function.
 */
export async function issueDollarReplacement(
  workspaceId: string,
  args: DollarReplacementArgs,
  _deps?: Partial<DollarReplacementDeps>,
): Promise<DollarReplacementResult> {
  if (!workspaceId) return { success: false, error: "workspaceId is required" };
  if (args.refund && args.upcharge) {
    return { success: false, error: "issueDollarReplacement: pass `refund` OR `upcharge`, not both" };
  }
  if (!args.refund && !args.upcharge) {
    return { success: false, error: "issueDollarReplacement: one of `refund` / `upcharge` is required (bare replacements go through issueReplacement)" };
  }

  const deps: DollarReplacementDeps = { ...(await defaultDollarReplacementDeps()), ..._deps };

  // ── 1. Replacement half (record-first) ─────────────────────────
  const rep = await deps.issueReplacement(workspaceId, {
    customerId: args.customerId,
    shopifyCustomerId: args.shopifyCustomerId,
    items: args.items,
    shippingAddress: args.shippingAddress,
    reason: args.reason,
    originalOrderNumber: args.originalOrderNumber,
    ticketId: args.ticketId,
    subscriptionId: args.subscriptionId,
    customerError: args.customerError,
    shopifyNote: args.shopifyNote,
    initiatedBy: args.initiatedBy,
    initiatedByName: args.initiatedByName,
  });
  if (!rep.success || !rep.replacementId) {
    return {
      success: false,
      error: `Replacement failed: ${rep.error ?? "unknown"}`,
      replacementId: rep.replacementId || undefined,
    };
  }

  // ── 2. Money half ──────────────────────────────────────────────
  if (args.refund) {
    const refund = await deps.issueRefund(workspaceId, {
      orderId: args.refund.orderId,
      amountCents: args.refund.amountCents,
      reason: args.refund.reason,
      source: args.refund.source ?? "dollar_replacement",
      customerId: args.customerId,
      eventProperties: {
        ...(args.refund.eventProperties ?? {}),
        replacement_id: rep.replacementId,
      },
      requestKey: args.refund.requestKey,
    });
    if (!refund.success) {
      // Compensating rollback — delete the just-created replacements
      // row so we don't ship a replacement without the refund.
      const roll = await deps.rollbackReplacement(workspaceId, rep.replacementId);
      return {
        success: false,
        error: `Refund failed after replacement created: ${refund.error ?? "unknown"}`,
        replacementId: rep.replacementId,
        refundResult: refund,
        rolledBack: roll.deleted,
      };
    }
    const mirror = await deps.writeOrderRefundMirror(workspaceId, {
      order_id: args.refund.orderId,
      replacement_id: rep.replacementId,
      amount_cents: args.refund.amountCents,
      method: refund.method ?? null,
      refund_id: refund.refund_id ?? null,
      reason: args.refund.reason,
    });
    return {
      success: true,
      replacementId: rep.replacementId,
      shopifyOrderName: rep.shopifyOrderName,
      refundResult: refund,
      orderRefundsMirrored: mirror.inserted,
    };
  }

  // upcharge branch (args.upcharge guaranteed by the guard above)
  const up = await deps.subscriptionOrderNow(workspaceId, args.upcharge!.contractId);
  if (!up.success) {
    const roll = await deps.rollbackReplacement(workspaceId, rep.replacementId);
    return {
      success: false,
      error: `Upcharge failed after replacement created: ${up.error ?? "unknown"}`,
      replacementId: rep.replacementId,
      upchargeResult: up,
      rolledBack: roll.deleted,
    };
  }
  return {
    success: true,
    replacementId: rep.replacementId,
    shopifyOrderName: rep.shopifyOrderName,
    upchargeResult: up,
  };
}
