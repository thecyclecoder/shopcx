/**
 * Self-healing return refunds — Phase 3 daily reconcile sweep.
 *
 * Rescues returns that Phases 1+2 wouldn't catch on their own: a webhook
 * that never arrived, a gateway blip, a human that flipped a return
 * delivered through a path that fired no event. The promise the pipeline
 * commits to the customer ("your refund is automatic once the return
 * scans back") depends on there NEVER being a delivered+unrefunded row
 * that no code is watching — this cron is that watcher.
 *
 * ── Two scopes ────────────────────────────────────────────────────
 * 1) DELIVERED but not refunded:
 *      status='delivered' AND refunded_at IS NULL AND easypost_shipment_id IS NOT NULL
 *    The `easypost_shipment_id IS NOT NULL` filter is what excludes the
 *    imported/Shopify-native returns we do NOT own the refund for
 *    (docs/brain/lifecycles/return-pipeline.md § "Imported vs created-by-us").
 *    Per hit, read the live gateway ledger with `getOrderRefundLedger`
 *    and route via `decideDeliveredSweep`:
 *      - stamp_out_of_band → stamp `refund_id='out_of_band_shopify'`,
 *        `refunded_at=now()` with a compare-and-set on
 *        `.is('refunded_at', null)` — count as HEALED (money already
 *        moved out of band; the SC130193 case).
 *      - redrive_refund → fire `returns/issue-refund` — the Phase 1
 *        reconcile inside that handler decides between cap-and-refund
 *        vs refund-full-contract. Safe to re-fire because
 *        `refundOrder`'s pre-dispatch `order_refunds.request_key` guard
 *        means the money can only move once.
 *      - escalate (no order at all) → dashboard notification with the
 *        concrete diagnosis + net_refund_cents — NEVER a bare
 *        "needs review".
 *
 * 2) UPSTREAM stranded (label_created / in_transit past a threshold):
 *      status IN ('label_created','in_transit') AND easypost_shipment_id IS NOT NULL AND aged ≥ 14 days
 *    A delivery-webhook-missed case. `scripts/returns-spot-check.ts`
 *    proved EasyPost holds the truth here; this cron generalises that
 *    spot-check to every workspace (the script hardcodes ONE — that's
 *    what the spec calls out to fix). Uses `lookupTracking` (the shared
 *    EasyPost helper) and routes via `decideUpstreamSweep`:
 *      - promote_delivered → set `status='delivered'` + `delivered_at`
 *        + fire `returns/process-delivery` (which fires issue-refund).
 *      - escalate (failure / return_to_sender / very old) →
 *        dashboard notification with the tracker detail.
 *
 * ── Node completeness trio ────────────────────────────────────────
 * - Owner + kill-switch ancestry: inherited from the `retention` seat
 *   via the MONITORED_LOOPS entry (`returns-reconcile-sweep`) added in
 *   `src/lib/control-tower/registry.ts`.
 * - End-of-run heartbeat: `emitCronHeartbeat("returns-reconcile-sweep",
 *   { ok, produced })` in a try/finally so a thrown run still beats
 *   ok:false — the error-rate signal the Control Tower tile reads.
 *
 * A daily cron under the CLAUDE.md monitor-cadence invariant needs a
 * 30h liveness window (≥ cadence × 1.2). Configured accordingly.
 *
 * Logs `{ swept, healed, redriven, escalated }` so a silent zero-work
 * run is distinguishable from a broken one.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import {
  decideRefundReconcile,
  getOrderRefundLedger,
  type OrderRefundLedger,
} from "@/lib/refund-ledger";

// Escalation copy — mirrors Phase 2's exhaustion titles so the operator
// can group all return-refund exceptions in one dashboard filter.
export const RETURN_SWEEP_NO_ORDER_TITLE =
  "Return has no order link — sweep cannot reconcile";
export const RETURN_SWEEP_UPSTREAM_STALE_TITLE =
  "Return stranded in transit — sweep escalated";
export const RETURN_SWEEP_UPSTREAM_FAILURE_TITLE =
  "Return delivery failed — sweep escalated";

// Any label_created / in_transit return older than this and still
// upstream is a webhook-missed case worth probing EasyPost for. Kept
// generous so we don't spend an EasyPost lookup on a fresh label the
// customer just printed.
const UPSTREAM_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// A return that STILL says in_transit past this age has almost
// certainly been lost by the carrier — escalate, don't wait forever.
const UPSTREAM_MAX_AGE_DAYS = 30;

// ── Pure deciders ─────────────────────────────────────────────────

export type DeliveredSweepAction =
  | { kind: "stamp_oob"; refundedCents: number; reason: string }
  | { kind: "redrive_refund"; reason: string }
  | { kind: "escalate_no_order"; reason: string };

/**
 * Decide the sweep's action for ONE delivered-but-unrefunded return.
 * Pure — the caller wires in the ledger + return-row fields.
 *
 * `hasOrderId` is `false` when `returns.order_id IS NULL` AND the
 * Phase-1 repair-from-shopify_order_gid path could not find a match.
 * Only in that case do we escalate synchronously with the concrete
 * "no order" diagnosis; every other case (ledger unreadable, ledger
 * reports full contract, ledger reports cap) is safe to re-drive via
 * `returns/issue-refund` where Phase 1 does the branching a second
 * time (idempotent under `request_key`).
 */
export function decideDeliveredSweep(input: {
  hasOrderId: boolean;
  netRefundCents: number;
  ledger: OrderRefundLedger;
}): DeliveredSweepAction {
  if (!input.hasOrderId) {
    return {
      kind: "escalate_no_order",
      reason: "return has no order_id and shopify_order_gid could not repair it",
    };
  }
  if (!input.ledger.ok) {
    return {
      kind: "redrive_refund",
      reason: `ledger unreadable (${input.ledger.reason}) — re-drive via returns/issue-refund; Phase 2 onFailure escalates if it stays broken`,
    };
  }
  const decision = decideRefundReconcile(input.ledger, input.netRefundCents);
  if (decision.branch === "stamp_out_of_band") {
    return {
      kind: "stamp_oob",
      refundedCents: decision.refundedCents,
      reason: "gateway shows the money already moved outside ShopCX",
    };
  }
  return {
    kind: "redrive_refund",
    reason: `ledger says ${decision.branch}`,
  };
}

export type UpstreamSweepAction =
  | { kind: "promote_delivered"; reason: string }
  | { kind: "escalate_failure"; trackerStatus: string; reason: string }
  | { kind: "escalate_stale"; reason: string }
  | { kind: "no_action"; reason: string };

/**
 * Decide the sweep's action for ONE upstream-stranded return
 * (label_created / in_transit past `UPSTREAM_MIN_AGE_MS`). Pure — the
 * caller wires in the EasyPost tracker status + the row's age.
 */
export function decideUpstreamSweep(input: {
  trackerStatus: string | null;
  ageDays: number;
}): UpstreamSweepAction {
  const s = (input.trackerStatus || "").toLowerCase();
  if (s === "delivered" || s === "available_for_pickup") {
    return {
      kind: "promote_delivered",
      reason: "EasyPost tracker says delivered but our row missed the webhook",
    };
  }
  if (s === "failure" || s === "error" || s === "return_to_sender") {
    return {
      kind: "escalate_failure",
      trackerStatus: s,
      reason: `EasyPost tracker says ${s}`,
    };
  }
  if (input.ageDays >= UPSTREAM_MAX_AGE_DAYS) {
    return {
      kind: "escalate_stale",
      reason: `still ${s || "in transit"} after ${input.ageDays} days`,
    };
  }
  return {
    kind: "no_action",
    reason: `still ${s || "in transit"} at ${input.ageDays}d — under the ${UPSTREAM_MAX_AGE_DAYS}d escalation threshold`,
  };
}

// ── The cron ─────────────────────────────────────────────────────

interface DeliveredReturn {
  id: string;
  workspace_id: string;
  order_id: string | null;
  shopify_order_gid: string | null;
  order_number: string;
  net_refund_cents: number;
  delivered_at: string | null;
  created_at: string;
}

interface UpstreamReturn {
  id: string;
  workspace_id: string;
  order_number: string;
  tracking_number: string | null;
  carrier: string | null;
  status: string;
  created_at: string;
}

interface SweepCounts {
  swept: number;
  healed: number;
  redriven: number;
  escalated: number;
}

export const returnsReconcileSweep = inngest.createFunction(
  {
    id: "returns-reconcile-sweep",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 6 * * *" }], // 6:00 UTC daily (≈ 11pm PT / 2am ET)
  },
  async ({ step }) => {
    let __ctOk = true;
    let result: {
      delivered: SweepCounts;
      upstream: SweepCounts;
    } = {
      delivered: { swept: 0, healed: 0, redriven: 0, escalated: 0 },
      upstream: { swept: 0, healed: 0, redriven: 0, escalated: 0 },
    };
    try {
      const admin = createAdminClient();

      // ── Scope 1: delivered but not refunded ─────────────────────
      const delivered = await step.run("load-delivered-unrefunded", async () => {
        const { data } = await admin
          .from("returns")
          .select(
            "id, workspace_id, order_id, shopify_order_gid, order_number, net_refund_cents, delivered_at, created_at",
          )
          .eq("status", "delivered")
          .is("refunded_at", null)
          .not("easypost_shipment_id", "is", null)
          .order("created_at", { ascending: true })
          .limit(200);
        return (data ?? []) as DeliveredReturn[];
      });

      for (const ret of delivered) {
        result.delivered.swept++;
        await step.run(`delivered-${ret.id}`, async () => {
          await sweepOneDelivered(admin, ret, result.delivered);
        });
      }

      // ── Scope 2: upstream stranded (label_created / in_transit) ──
      const upstream = await step.run("load-upstream-stranded", async () => {
        const cutoff = new Date(Date.now() - UPSTREAM_MIN_AGE_MS).toISOString();
        const { data } = await admin
          .from("returns")
          .select("id, workspace_id, order_number, tracking_number, carrier, status, created_at")
          .in("status", ["label_created", "in_transit"])
          .not("easypost_shipment_id", "is", null)
          .lte("created_at", cutoff)
          .order("created_at", { ascending: true })
          .limit(100);
        return (data ?? []) as UpstreamReturn[];
      });

      for (const ret of upstream) {
        result.upstream.swept++;
        await step.run(`upstream-${ret.id}`, async () => {
          await sweepOneUpstream(admin, ret, result.upstream);
        });
      }
    } catch (e) {
      __ctOk = false;
      throw e;
    } finally {
      await emitCronHeartbeat("returns-reconcile-sweep", { ok: __ctOk, produced: result });
    }

    return result;
  },
);

async function sweepOneDelivered(
  admin: ReturnType<typeof createAdminClient>,
  ret: DeliveredReturn,
  counts: SweepCounts,
): Promise<void> {
  // Phase 1 repair path (also lives inside returnsIssueRefund): a null
  // order_id can often be repaired from shopify_order_gid. We attempt
  // it synchronously here so the "no order" escalation is only for
  // rows that TRULY have no gateway link.
  let orderIdForRefund: string | null = ret.order_id;
  if (!orderIdForRefund && ret.shopify_order_gid) {
    orderIdForRefund = await repairOrderIdFromGid(admin, ret);
  }

  const ledger: OrderRefundLedger = orderIdForRefund
    ? await getOrderRefundLedger(ret.workspace_id, orderIdForRefund)
    : { ok: false, reason: "order_not_found" };

  const action = decideDeliveredSweep({
    hasOrderId: !!orderIdForRefund,
    netRefundCents: ret.net_refund_cents,
    ledger,
  });

  if (action.kind === "stamp_oob") {
    // Compare-and-set on refunded_at IS NULL — an async race where the
    // main pipeline stamped between our read and our write must not
    // overwrite it, and the workspace filter keeps this from ever
    // reaching across tenants (per the guard-before-mutation rule).
    const { data } = await admin
      .from("returns")
      .update({
        status: "refunded",
        refund_id: "out_of_band_shopify",
        refunded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", ret.id)
      .eq("workspace_id", ret.workspace_id)
      .is("refunded_at", null)
      .select("id");
    if ((data ?? []).length === 1) counts.healed++;
    return;
  }

  if (action.kind === "escalate_no_order") {
    await escalate(admin, {
      workspace_id: ret.workspace_id,
      title: RETURN_SWEEP_NO_ORDER_TITLE,
      body:
        `Return ${ret.order_number} was received back but has no order link (order_id IS NULL and shopify_order_gid ` +
        `${ret.shopify_order_gid ? "did not resolve" : "is null"}). ` +
        `net_refund_cents = $${formatCents(ret.net_refund_cents)}. ` +
        `Manually link the return to its order, then re-fire returns/issue-refund { workspace_id: ${ret.workspace_id}, return_id: ${ret.id} }.`,
      metadata: {
        type: "return_sweep_no_order",
        return_id: ret.id,
        order_number: ret.order_number,
        net_refund_cents: ret.net_refund_cents,
        reason: action.reason,
      },
    });
    counts.escalated++;
    return;
  }

  // redrive_refund — Phase 1 reconcile happens inside the handler.
  // Safe to re-fire under `refundOrder`'s request_key guard.
  await inngest.send({
    name: "returns/issue-refund",
    data: { workspace_id: ret.workspace_id, return_id: ret.id },
  });
  counts.redriven++;
}

async function sweepOneUpstream(
  admin: ReturnType<typeof createAdminClient>,
  ret: UpstreamReturn,
  counts: SweepCounts,
): Promise<void> {
  const ageDays = Math.floor(
    (Date.now() - new Date(ret.created_at).getTime()) / 86_400_000,
  );

  // Skip if we can't probe EasyPost — nothing to reconcile against.
  if (!ret.tracking_number) {
    if (ageDays >= UPSTREAM_MAX_AGE_DAYS) {
      await escalate(admin, {
        workspace_id: ret.workspace_id,
        title: RETURN_SWEEP_UPSTREAM_STALE_TITLE,
        body: `Return ${ret.order_number} is still ${ret.status} after ${ageDays} days with no tracking_number on the row. Investigate the return + reshoot the label if needed.`,
        metadata: {
          type: "return_sweep_upstream_no_tracking",
          return_id: ret.id,
          order_number: ret.order_number,
          age_days: ageDays,
        },
      });
      counts.escalated++;
    }
    return;
  }

  let trackerStatus: string | null = null;
  try {
    const { lookupTracking } = await import("@/lib/easypost");
    const tracker = await lookupTracking(
      ret.workspace_id,
      ret.tracking_number,
      ret.carrier ?? undefined,
    );
    trackerStatus = tracker.status;
  } catch (err) {
    console.error(
      `[returns-reconcile-sweep] lookupTracking failed for return ${ret.id} (tracking ${ret.tracking_number}):`,
      err,
    );
    return;
  }

  const action = decideUpstreamSweep({ trackerStatus, ageDays });

  if (action.kind === "no_action") return;

  if (action.kind === "promote_delivered") {
    // Update the row + fire process-delivery only if the row didn't
    // already flip under us (compare-and-set on the pre-delivered
    // statuses we queried on).
    const { data } = await admin
      .from("returns")
      .update({
        status: "delivered",
        delivered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", ret.id)
      .eq("workspace_id", ret.workspace_id)
      .in("status", ["label_created", "in_transit"])
      .select("id");
    if ((data ?? []).length === 1) {
      await inngest.send({
        name: "returns/process-delivery",
        data: { workspace_id: ret.workspace_id, return_id: ret.id },
      });
      counts.redriven++;
    }
    return;
  }

  if (action.kind === "escalate_failure") {
    await escalate(admin, {
      workspace_id: ret.workspace_id,
      title: RETURN_SWEEP_UPSTREAM_FAILURE_TITLE,
      body:
        `Return ${ret.order_number} — EasyPost tracker says ${action.trackerStatus} ` +
        `(carrier ${ret.carrier ?? "unknown"}, tracking ${ret.tracking_number}). ` +
        `Reshoot the label or contact the customer.`,
      metadata: {
        type: "return_sweep_upstream_failure",
        return_id: ret.id,
        order_number: ret.order_number,
        tracker_status: action.trackerStatus,
        tracking_number: ret.tracking_number,
        carrier: ret.carrier,
      },
    });
    counts.escalated++;
    return;
  }

  // escalate_stale
  await escalate(admin, {
    workspace_id: ret.workspace_id,
    title: RETURN_SWEEP_UPSTREAM_STALE_TITLE,
    body:
      `Return ${ret.order_number} is still ${trackerStatus ?? ret.status} after ${ageDays} days ` +
      `(carrier ${ret.carrier ?? "unknown"}, tracking ${ret.tracking_number}). Investigate the return.`,
    metadata: {
      type: "return_sweep_upstream_stale",
      return_id: ret.id,
      order_number: ret.order_number,
      age_days: ageDays,
      tracker_status: trackerStatus,
    },
  });
  counts.escalated++;
}

async function repairOrderIdFromGid(
  admin: ReturnType<typeof createAdminClient>,
  ret: DeliveredReturn,
): Promise<string | null> {
  const match = String(ret.shopify_order_gid).match(/(\d+)\s*$/);
  if (!match) return null;
  const shopifyOrderId = match[1];
  const { data: linked } = await admin
    .from("orders")
    .select("id")
    .eq("workspace_id", ret.workspace_id)
    .eq("shopify_order_id", shopifyOrderId)
    .maybeSingle();
  if (!linked?.id) return null;
  await admin
    .from("returns")
    .update({ order_id: linked.id, updated_at: new Date().toISOString() })
    .eq("id", ret.id)
    .eq("workspace_id", ret.workspace_id)
    .is("order_id", null);
  return linked.id as string;
}

async function escalate(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    workspace_id: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await admin.from("dashboard_notifications").insert({
    workspace_id: input.workspace_id,
    type: "system",
    title: input.title,
    body: input.body,
    metadata: input.metadata,
  });
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
