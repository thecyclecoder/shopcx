// Inngest returns pipeline:
//   returns/process-delivery → fires returns/issue-refund instantly
//   returns/issue-refund     → reads stored net_refund_cents, refunds
//                              or issues store credit, closes return,
//                              emails customer. Escalates if amount
//                              missing — never auto-refunds $0.
//
// Design notes:
//   - Dispose (Shopify reverseFulfillmentOrderDispose) was previously
//     gating the refund. We don't use Shopify's inventory bookkeeping
//     for returns, so it was pure dead weight that blocked refunds
//     when older returns lacked reverse fulfillment line item IDs.
//   - The 24-hour inspection wait was for that dispose step. With
//     dispose gone, the refund fires as soon as EasyPost confirms
//     delivery. Customer experience > inventory accounting.
//   - The refund amount is the value STORED on the return row at
//     create time (computed from items + label policy + resolution
//     type). The pipeline never re-derives it — if it's missing or
//     zero, that's a creation-time bug, surfaced as a dashboard
//     notification.

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { closeReturn } from "@/lib/shopify-returns";
import { emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";

// Phase 2 escalation copy centralised so the tests can pin it and the
// onFailure handler + Phase 3 sweep can share the same wording.
export const RETURN_REFUND_EXHAUSTED_TITLE =
  "Return refund exhausted retries — manual action needed";
export const RETURN_CREDIT_EXHAUSTED_TITLE =
  "Return store credit exhausted retries — manual action needed";

// ── returns/process-delivery ──
// Triggered by EasyPost webhook when tracker → delivered. Verifies
// status and instantly fires the refund event. No 24h wait. No
// dispose. We don't tell Shopify what to do with the physical items.

export const returnsProcessDelivery = inngest.createFunction(
  {
    id: "returns-process-delivery",
    retries: 2,
    concurrency: [{ limit: 5, key: "event.data.workspace_id" }],
    triggers: [{ event: "returns/process-delivery" }],
  },
  async ({ event, step }) => {
    // Control Tower: end-of-run heartbeat (try/finally — ok:false on throw). (control-tower-complete-coverage P1.)
    let __ctOk = true;
    try {
    const { workspace_id, return_id } = event.data as {
      workspace_id: string;
      return_id: string;
    };

    const admin = createAdminClient();

    const ret = await step.run("load-return", async () => {
      const { data } = await admin
        .from("returns")
        .select("id, status, refunded_at, refund_id")
        .eq("id", return_id)
        .eq("workspace_id", workspace_id)
        .single();
      return data;
    });

    if (!ret) return { skipped: true, reason: "Return not found" };
    if (ret.status !== "delivered") {
      return { skipped: true, reason: `Status is ${ret.status}, not delivered` };
    }
    if (ret.refunded_at || ret.refund_id) {
      return { skipped: true, reason: "Already refunded" };
    }

    await step.run("trigger-refund", async () => {
      await inngest.send({
        name: "returns/issue-refund",
        data: { workspace_id, return_id },
      });
    });

    return { success: true, return_id };
    } catch (e) {
      __ctOk = false;
      throw e;
    } finally {
      await emitReactiveHeartbeat("returns-process-delivery", { ok: __ctOk });
    }
  },
);

// ── returns/issue-refund ──
// Reads the stored amount, branches refund vs store credit, closes
// the Shopify return, sends customer confirmation. Trusts net_refund_cents
// as the contract; if it's missing/zero, surfaces a notification and
// stops — does NOT auto-refund full or guess at the amount.

export const returnsIssueRefund = inngest.createFunction(
  {
    id: "returns-issue-refund",
    retries: 2,
    concurrency: [{ limit: 5, key: "event.data.workspace_id" }],
    triggers: [{ event: "returns/issue-refund" }],
    // Phase 2 — on retry exhaustion, escalate as a founder-visible
    // dashboard notification instead of letting the failed refund sit
    // silently. See `RETURN_REFUND_EXHAUSTED_TITLE` above (same wording
    // Phase 3's daily sweep looks for). Also emits an ok:false
    // heartbeat so the MONITORED_LOOPS `returns-issue-refund` tile
    // rolls the exhaustion into its error rate.
    onFailure: returnsIssueRefundOnFailure,
  },
  async ({ event, step }) => {
    // Control Tower: end-of-run heartbeat (try/finally — ok:false on throw).
    // A refund-failure branch throws so Inngest `retries: 2` engages; each
    // in-flight throw also beats ok:false so the error-rate is visible
    // before onFailure fires.
    let __ctOk = true;
    try {
    const { workspace_id, return_id } = event.data as {
      workspace_id: string;
      return_id: string;
    };

    const admin = createAdminClient();

    const ret = await step.run("load-return", async () => {
      const { data } = await admin
        .from("returns")
        .select(`
          id, status, resolution_type, order_number, order_id,
          shopify_order_gid,
          net_refund_cents, refund_id, customer_id,
          customers(email, first_name)
        `)
        .eq("id", return_id)
        .eq("workspace_id", workspace_id)
        .single();
      return data;
    });

    if (!ret) return { error: "Return not found" };
    if (ret.refund_id) return { skipped: true, reason: "Already has refund_id" };

    const amountCents = ret.net_refund_cents || 0;

    // If no amount stored, escalate. Never auto-refund $0 and never
    // guess the amount from the order — the amount is context-dependent
    // (full vs partial, label deducted or not) and has to come from
    // the return-creation step that knew the context.
    if (amountCents <= 0) {
      await step.run("notify-missing-amount", async () => {
        await admin.from("dashboard_notifications").insert({
          workspace_id,
          type: "system",
          title: `Return needs manual review — no refund amount stored`,
          body: `Return ${ret.order_number} was delivered but net_refund_cents is ${amountCents}. Set the amount on the return row, then re-fire returns/issue-refund with { workspace_id, return_id: ${return_id} }.`,
          metadata: { type: "return_missing_amount", return_id, order_number: ret.order_number },
        });
      });
      return { needs_review: true, reason: "net_refund_cents missing" };
    }

    const customersRel = ret.customers as unknown as { email: string; first_name: string | null }[] | { email: string; first_name: string | null } | null;
    const customer = Array.isArray(customersRel) ? customersRel[0] : customersRel;

    const isStoreCredit = (ret.resolution_type || "").includes("store_credit");
    let valueIssued = false;
    let issuedSummary = "";

    // ── Phase 1 reconcile (money-refund path only) ────────────────
    // Read the live gateway ledger BEFORE dispatching the refund so we
    // never fire a stale stored number the gateway has since reduced
    // (SC133086 / SC129432 cap), never re-refund a return whose money
    // already moved out of band (SC130193), and never die on a null
    // order id we could have repaired from shopify_order_gid (SC131156).
    //
    // `net_refund_cents` remains the CONTRACT (set at return creation,
    // never raised) — the live ledger is only ever the CEILING. See
    // docs/brain/tables/returns.md § "contract vs ceiling".
    //
    // Store-credit issuance never touches the gateway, so this branch
    // is scoped to the money-refund path.
    let orderIdForRefund: string | null = (ret.order_id as string | null) ?? null;
    let refundCapCents = amountCents;
    let refundShortfallCents = 0;
    let outOfBandRefundedCents = 0;
    let stampedOutOfBand = false;

    if (!isStoreCredit) {
      if (!orderIdForRefund && ret.shopify_order_gid) {
        orderIdForRefund = await step.run("repair-null-order-id", async (): Promise<string | null> => {
          const match = String(ret.shopify_order_gid).match(/(\d+)\s*$/);
          if (!match) return null;
          const shopifyOrderId = match[1];
          const { data: linked } = await admin
            .from("orders")
            .select("id")
            .eq("workspace_id", workspace_id)
            .eq("shopify_order_id", shopifyOrderId)
            .maybeSingle();
          if (!linked?.id) return null;
          await admin
            .from("returns")
            .update({ order_id: linked.id, updated_at: new Date().toISOString() })
            .eq("id", return_id)
            .eq("workspace_id", workspace_id)
            .is("order_id", null);
          return linked.id as string;
        });
      }

      if (orderIdForRefund) {
        const decision = await step.run("read-refund-ledger", async () => {
          const { getOrderRefundLedger, decideRefundReconcile } = await import("@/lib/refund-ledger");
          const ledger = await getOrderRefundLedger(workspace_id, orderIdForRefund!);
          return decideRefundReconcile(ledger, amountCents);
        });
        if (decision.branch === "stamp_out_of_band") {
          stampedOutOfBand = true;
          outOfBandRefundedCents = decision.refundedCents;
        } else if (decision.branch === "cap_to_ledger") {
          refundCapCents = decision.refundCents;
          refundShortfallCents = decision.shortfallCents;
        }
        // "refund_full_contract" (ledger ok+enough, OR ledger unreadable)
        // is the no-op case. Phase 2 will make the underlying failure
        // loud when the ledger call fails; Phase 1 only refuses to fire
        // a KNOWN-BAD amount, not one we can't verify.
      }
    }

    if (stampedOutOfBand) {
      const stamp = await step.run("stamp-out-of-band-refund", async () => {
        const { data, error } = await admin
          .from("returns")
          .update({
            status: "refunded",
            refund_id: "out_of_band_shopify",
            refunded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", return_id)
          .eq("workspace_id", workspace_id)
          .is("refunded_at", null)
          .select("id");
        return { stamped: (data ?? []).length === 1, error: error?.message ?? null };
      });
      return {
        success: true,
        return_id,
        reason: "already_refunded_out_of_band",
        refunded_cents: outOfBandRefundedCents,
        stamped: stamp.stamped,
      };
    }

    if (isStoreCredit) {
      const creditResult = await step.run("issue-store-credit", async (): Promise<{ ok: boolean; balance: number; transactionId: string | null; error?: string }> => {
        const { data: cust } = await admin.from("customers")
          .select("shopify_customer_id").eq("id", ret.customer_id).maybeSingle();
        if (!cust?.shopify_customer_id) {
          return { ok: false, balance: 0, transactionId: null, error: "Customer has no Shopify ID" };
        }
        const { issueStoreCredit } = await import("@/lib/store-credit");
        return issueStoreCredit({
          workspaceId: workspace_id,
          customerId: ret.customer_id,
          shopifyCustomerId: cust.shopify_customer_id,
          amount: amountCents / 100,
          reason: `Return ${ret.order_number} delivered — store credit issued`,
          issuedBy: "system",
          issuedByName: "ShopCX (auto)",
        });
      });
      if (creditResult.ok) {
        valueIssued = true;
        issuedSummary = `Store credit $${(amountCents / 100).toFixed(2)} issued`;
        await admin.from("returns").update({
          refund_id: creditResult.transactionId,
          updated_at: new Date().toISOString(),
        }).eq("id", return_id);
      } else {
        // Phase 2 — throw so Inngest `retries: 2` engages. The per-attempt
        // dashboard row was silently spamming on every retry; the
        // exhaustion escalation lives in onFailure now (single row on
        // final failure, not one per attempt).
        throw new Error(
          `Return store credit failed for return ${return_id} (${ret.order_number}): ${creditResult.error ?? "unknown error"}`,
        );
      }
    } else {
      const refundResult = await step.run("issue-refund", async () => {
        // Phase-3 refund-dispatcher migration — this step was the
        // reference implementation of the gateway-aware branch; it now
        // delegates to the shared `refundOrder` in `src/lib/refund.ts`
        // so nothing outside that file, shopify-order-actions.ts, and
        // integrations/braintree.ts touches a refund mutation.
        // The requestKey is derived from the return_id so an Inngest
        // step retry (this function is `retries: 2` above) reuses the
        // same key and short-circuits at refundOrder's pre-dispatch
        // guard — the money can only move once even under retry.
        // `refundCapCents` == `amountCents` in the common case; the
        // Phase 1 reconcile lowers it to the live gateway ceiling on
        // the cap branch. `orderIdForRefund` is either ret.order_id or
        // the value the null-order-id repair branch persisted.
        const { refundOrder, hashActionRefundKey } = await import("@/lib/refund");
        const refundReason = `Return ${ret.order_number} delivered`;
        // orderIdForRefund is null only when ret.order_id was null AND the
        // shopify_order_gid → orders lookup could not find a match. Pass an
        // empty string so refundOrder's own `!orderId` guard returns
        // `{ success: false, error: "orderId is required" }` and the code
        // flows into today's notify-refund-failed branch (Phase 2 makes
        // that failure loud). No refund can be dispatched at that point.
        const oid = orderIdForRefund ?? "";
        const requestKey = hashActionRefundKey("return", return_id, oid, refundCapCents, refundReason);
        return refundOrder(workspace_id, oid, refundCapCents, refundReason, {
          source: "inngest",
          eventProperties: { return_id, resolution_type: ret.resolution_type, refund_shortfall_cents: refundShortfallCents || undefined },
          requestKey,
        });
      });
      if (refundResult.success) {
        valueIssued = true;
        const gateway = refundResult.method === "braintree" ? "Braintree" : "Shopify";
        issuedSummary = refundShortfallCents > 0
          ? `Refund $${(refundCapCents / 100).toFixed(2)} of $${(amountCents / 100).toFixed(2)} issued via ${gateway} (capped to live refundable balance; $${(refundShortfallCents / 100).toFixed(2)} short)`
          : `Refund $${(refundCapCents / 100).toFixed(2)} issued via ${gateway}`;
        if (refundShortfallCents > 0) {
          await step.run("record-refund-shortfall", async () => {
            await admin
              .from("returns")
              .update({
                refund_shortfall_cents: refundShortfallCents,
                updated_at: new Date().toISOString(),
              })
              .eq("id", return_id)
              .eq("workspace_id", workspace_id);
          });
        }
      } else {
        // Phase 2 — throw so Inngest `retries: 2` engages. Per-attempt
        // dashboard rows are gone; the exhaustion escalation lives in
        // onFailure (single row on final failure). Refunds are idempotent
        // (refundOrder pre-dispatch guard on order_refunds request_key)
        // so a retry can only succeed or return `success:false` again —
        // it can NEVER double-pay.
        throw new Error(
          `Return refund failed for return ${return_id} (${ret.order_number}): ${refundResult.error ?? "unknown error"}`,
        );
      }
    }

    // Close the Shopify return record (purely cosmetic on their side —
    // marks it as fully resolved).
    await step.run("close-return", async () => {
      const r = await closeReturn(workspace_id, return_id);
      if (!r.success) {
        console.error(`closeReturn failed for ${return_id}:`, r.error);
      }
    });

    // Update local status. Only mark refunded if money actually moved.
    await step.run("update-status", async () => {
      const updates: Record<string, string> = {
        status: valueIssued ? "refunded" : "delivered",
        updated_at: new Date().toISOString(),
      };
      if (valueIssued) updates.refunded_at = new Date().toISOString();
      await admin.from("returns").update(updates).eq("id", return_id);
    });

    // Confirmation email only if value moved.
    if (customer?.email && valueIssued) {
      await step.run("send-confirmation", async () => {
        const { sendReturnConfirmationEmail } = await import("@/lib/email");
        await sendReturnConfirmationEmail({
          workspaceId: workspace_id,
          toEmail: customer.email,
          customerName: customer.first_name,
          orderNumber: ret.order_number,
          resolutionType: ret.resolution_type,
        });
      });
    }

    return { success: valueIssued, return_id, summary: issuedSummary };
    } catch (e) {
      __ctOk = false;
      throw e;
    } finally {
      await emitReactiveHeartbeat("returns-issue-refund", { ok: __ctOk });
    }
  },
);

// ── Phase 2 onFailure handler ────────────────────────────────────
// Fires ONCE after `retries: 2` exhausts. Reads the return + escalates
// as a dashboard notification the operator can act on (fix the underlying
// gateway condition then re-fire `returns/issue-refund`, or stamp
// out-of-band if the money has moved). Also emits an ok:false heartbeat
// so the Control Tower tile rolls the exhaustion into its error-rate
// signal (a permanently-failing refund shows up in aggregate, not just
// as a single dashboard row).
//
// Exported for the unit test — the Inngest FailureEventArgs type ships
// the original event under `event.data.event`, so pull the return_id +
// workspace_id back out from there.
export async function returnsIssueRefundOnFailure(args: {
  event: { data: { event?: { data?: { workspace_id?: string; return_id?: string } } } };
  error: Error;
}): Promise<void> {
  const orig = args.event?.data?.event?.data ?? {};
  const workspace_id = orig.workspace_id ?? "";
  const return_id = orig.return_id ?? "";
  if (!workspace_id || !return_id) {
    // Nothing actionable to escalate without the id pair. Still beat
    // so a broken payload shape shows up in the loop's error rate.
    await emitReactiveHeartbeat("returns-issue-refund", { ok: false });
    return;
  }

  const admin = createAdminClient();
  const { data: ret } = await admin
    .from("returns")
    .select("id, order_number, net_refund_cents, resolution_type, order_id")
    .eq("id", return_id)
    .eq("workspace_id", workspace_id)
    .maybeSingle();

  const isStoreCredit = String(ret?.resolution_type ?? "").includes("store_credit");
  const title = isStoreCredit ? RETURN_CREDIT_EXHAUSTED_TITLE : RETURN_REFUND_EXHAUSTED_TITLE;
  const orderTag = ret?.order_number ?? `id ${return_id}`;
  const amount =
    typeof ret?.net_refund_cents === "number"
      ? `$${(ret.net_refund_cents / 100).toFixed(2)}`
      : "unknown";
  const body =
    `Return ${orderTag} — net_refund_cents ${amount} — failed after Inngest retries. ` +
    `Error: ${args.error.message}. ` +
    `Investigate the order's gateway ledger (getOrderRefundLedger in src/lib/refund-ledger.ts) ` +
    `and either fix the underlying gateway condition + re-fire returns/issue-refund ` +
    `{ workspace_id: ${workspace_id}, return_id: ${return_id} }, ` +
    `or stamp the return manually if the money has moved out of band.`;

  await admin.from("dashboard_notifications").insert({
    workspace_id,
    type: "system",
    title,
    body,
    metadata: {
      type: isStoreCredit ? "return_credit_exhausted" : "return_refund_exhausted",
      return_id,
      order_number: ret?.order_number,
      net_refund_cents: ret?.net_refund_cents,
      error: args.error.message,
    },
  });
  await emitReactiveHeartbeat("returns-issue-refund", { ok: false });
}
