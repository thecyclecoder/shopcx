/**
 * Phase 2 of crisis-resolve-ships-promised-restock-replacements.
 *
 * When a crisis resolves, every restock PROMISE recorded against it — an
 * `awaiting_restock` [[replacements]] row created by the
 * `promise_restock_replacement` direct action for a customer with NO
 * subscription — must ship. This module owns that fan-out.
 *
 * Record-first + single-row-per-promise: each promise is shipped through the
 * canonical [[replacement-order]] `createReplacementOrder`, REUSING the promise
 * row via `existingReplacementId` so the row flips `awaiting_restock` →
 * `pending` → `created`/`failed` in place rather than minting a second row.
 *
 * Idempotent under a double-click / concurrent Resolve: a compare-and-set
 * (`update … where status='awaiting_restock'`) CLAIMS the row before any
 * Shopify call. If zero rows transition, another resolve already owns it and we
 * skip — so a promise can never ship twice.
 *
 * A restock failure does NOT un-resolve the crisis. The row is marked `failed`,
 * the ticket (if any) is reopened, and a high-severity `fulfillment_alert`
 * dashboard notification is raised so a human ships it by hand.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { createReplacementOrder } from "@/lib/replacement-order";
import { resolveGroupShopifyCustomerId } from "@/lib/action-executor";
import { resolveCustomerShippingAddress } from "@/lib/customer-shipping-address";

type Admin = ReturnType<typeof createAdminClient>;

export interface RestockPromiseRow {
  id: string;
  customer_id: string | null;
  ticket_id: string | null;
  original_order_number: string | null;
  items: Array<{ variantId?: string; quantity?: number; title?: string }> | null;
}

export interface RestockShipResult {
  created: Array<{ replacement_id: string; order_name: string | null; items: string }>;
  failed: Array<{ replacement_id: string; error: string }>;
}

/**
 * Dependency seam — defaults to the real effectors, overridable in tests so
 * the selection + compare-and-set can be exercised without live Shopify.
 */
export interface ShipRestockDeps {
  createReplacement: typeof createReplacementOrder;
  resolveShopifyCustomerId: typeof resolveGroupShopifyCustomerId;
  resolveShippingAddress: typeof resolveCustomerShippingAddress;
}

const DEFAULT_DEPS: ShipRestockDeps = {
  createReplacement: createReplacementOrder,
  resolveShopifyCustomerId: resolveGroupShopifyCustomerId,
  resolveShippingAddress: resolveCustomerShippingAddress,
};

/** Normalize a promise row's stored items into the SDK's `{ variantId, quantity, title }` shape. */
export function normalizePromiseItems(
  items: RestockPromiseRow["items"],
): Array<{ variantId: string; quantity: number; title: string }> {
  return (items || [])
    .map((it) => ({
      variantId: String(it.variantId || ""),
      quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
      title: it.title || "item",
    }))
    .filter((it) => it.variantId);
}

export async function shipRestockPromises(
  admin: Admin,
  workspaceId: string,
  crisisId: string,
  deps: ShipRestockDeps = DEFAULT_DEPS,
): Promise<RestockShipResult> {
  const result: RestockShipResult = { created: [], failed: [] };

  // SELECTION — only awaiting_restock promises for THIS crisis + workspace.
  const { data: promises } = await admin
    .from("replacements")
    .select("id, customer_id, ticket_id, original_order_number, items")
    .eq("workspace_id", workspaceId)
    .eq("crisis_id", crisisId)
    .eq("status", "awaiting_restock");

  if (!promises || promises.length === 0) return result;

  for (const promise of promises as RestockPromiseRow[]) {
    const items = normalizePromiseItems(promise.items);
    const itemsSummary = items.map((i) => `${i.quantity}x ${i.title}`).join(" + ") || "item";

    const failPromise = async (reason: string) => {
      await admin
        .from("replacements")
        .update({ status: "failed", reason_detail: reason, updated_at: new Date().toISOString() })
        .eq("id", promise.id)
        .eq("workspace_id", workspaceId);
      if (promise.ticket_id) {
        // Reopen the ticket so a human picks it back up, and leave a trail.
        await admin
          .from("tickets")
          .update({ status: "open" })
          .eq("id", promise.ticket_id)
          .eq("workspace_id", workspaceId);
        await admin.from("ticket_messages").insert({
          ticket_id: promise.ticket_id,
          direction: "outbound",
          visibility: "internal",
          author_type: "system",
          body: `Crisis resolved but the restock replacement FAILED (${itemsSummary}): ${reason}. Ship it manually.`,
        });
      }
      // High-severity alert — there is no `severity` column on
      // dashboard_notifications, so severity lives in metadata and the
      // CHECK-constrained `type` is `fulfillment_alert` (a promised order
      // never shipped). `body`, not `message`, is the text column.
      await admin.from("dashboard_notifications").insert({
        workspace_id: workspaceId,
        type: "fulfillment_alert",
        title: "Restock replacement failed to ship on crisis resolve",
        body: `A promised restock replacement (${itemsSummary}) for a customer with no subscription could not be shipped when crisis ${crisisId} resolved: ${reason}. Ship it manually.`,
        metadata: {
          severity: "high",
          crisis_id: crisisId,
          replacement_id: promise.id,
          customer_id: promise.customer_id,
          ticket_id: promise.ticket_id,
          spec: "crisis-resolve-ships-promised-restock-replacements",
        },
      });
      result.failed.push({ replacement_id: promise.id, error: reason });
    };

    if (!promise.customer_id) { await failPromise("replacement row has no customer_id"); continue; }
    if (items.length === 0) { await failPromise("replacement row has no shippable items"); continue; }

    // COMPARE-AND-SET — claim the row off awaiting_restock BEFORE creating, so
    // a double-click on Resolve (or a concurrent resolve) can't ship twice. If
    // zero rows transition, someone else already owns it → skip silently.
    const { data: claimed } = await admin
      .from("replacements")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("id", promise.id)
      .eq("workspace_id", workspaceId)
      .eq("status", "awaiting_restock")
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    const shopifyCustomerId = await deps.resolveShopifyCustomerId(admin, workspaceId, promise.customer_id);
    if (!shopifyCustomerId) { await failPromise("no Shopify customer id across the link group"); continue; }

    const resolvedAddr = await deps.resolveShippingAddress(admin, workspaceId, promise.customer_id, {
      orderNumber: promise.original_order_number || null,
    });
    if (!resolvedAddr) { await failPromise("no shipping address on file"); continue; }
    const addr = resolvedAddr.address;

    const r = await deps.createReplacement({
      workspaceId,
      customerId: promise.customer_id,
      shopifyCustomerId,
      existingReplacementId: promise.id,
      items,
      shippingAddress: {
        firstName: addr.firstName,
        lastName: addr.lastName,
        address1: addr.address1,
        address2: addr.address2,
        city: addr.city,
        province: addr.province,
        provinceCode: addr.provinceCode,
        zip: addr.zip,
        countryCode: addr.countryCode || "US",
      },
      reason: "crisis_restock_promise",
      originalOrderNumber: promise.original_order_number || null,
      ticketId: promise.ticket_id || null,
      shopifyNote: "Restock replacement — promised during stockout, shipped on crisis resolve",
      initiatedBy: "script",
    });

    if (r.success) {
      result.created.push({ replacement_id: promise.id, order_name: r.shopifyOrderName, items: itemsSummary });
      if (promise.ticket_id) {
        // Customer gets the normal Shopify order confirmation; this is the
        // internal trail the spec names.
        await admin.from("ticket_messages").insert({
          ticket_id: promise.ticket_id,
          direction: "outbound",
          visibility: "internal",
          author_type: "system",
          body: `Crisis resolved: restock replacement ${r.shopifyOrderName || "created"} created (${itemsSummary}).`,
        });
      }
    } else {
      await failPromise(r.error || "replacement creation failed");
    }
  }

  return result;
}
