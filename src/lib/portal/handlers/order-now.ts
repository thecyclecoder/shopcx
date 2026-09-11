import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
import { appstleGetUpcomingOrders, appstleAttemptBilling } from "@/lib/appstle";
import { createAdminClient } from "@/lib/supabase/admin";
import { guardAppstleOrderNow } from "@/lib/portal/order-now-guard";

export const orderNow: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const resolved = await resolveSub(createAdminClient(), auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  const contractId = resolved?.shopify_contract_id || "";
  if (!resolved || !contractId) return jsonErr({ error: "missing_contractId" }, 400);

  // Internal subs: fire the SAME renewal pipeline a scheduled charge uses
  // (charge → order → Avalara → Amplifier → advance next billing date). Async via
  // Inngest, so this returns immediately and the order shows up shortly.
  if (resolved.is_internal) {
    if (resolved.status !== "active") {
      return jsonErr({ error: "not_active", message: "This subscription isn't active." }, 409);
    }
    const { inngest } = await import("@/lib/inngest/client");
    await inngest.send({
      name: "internal-subscription/renewal-attempt",
      data: { subscription_id: resolved.id, workspace_id: auth.workspaceId },
    });
    const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
    if (customer) {
      await logPortalAction({
        workspaceId: auth.workspaceId, customerId: customer.id,
        eventType: "portal.order_now",
        summary: "Customer triggered an immediate renewal via portal (internal sub)",
        properties: { subscription_id: resolved.id },
        createNote: true,
      });
    }
    return jsonOk({ ok: true, route, contractId, patch: {} });
  }

  // Appstle subs: attempt the upcoming Appstle billing. First gate on status —
  // a cancelled Appstle contract will surface a stale/misleading error from
  // `attempt-billing` (ticket 183d28b9 — Ellyn hit "All 1 products in this
  // subscription are currently out of stock" on a cancelled contract that had
  // been migrated to an internal sub). Mirrors the internal branch's status
  // gate above; see [[../order-now-guard]].
  const guard = guardAppstleOrderNow({ is_internal: resolved.is_internal, status: resolved.status });
  if (guard.action === "block") {
    return jsonErr({ error: guard.reason, message: guard.message }, 409);
  }

  // ⭐ ShopCX-billed subs take a different shape entirely. The Appstle flow is
  // getUpcomingOrders -> attemptBilling(ATTEMPT id); a Shopify contract has no Appstle attempts, so
  // there is nothing to look up — we charge the contract directly, addressing the cycle that
  // contains its billing date. Routing this through the SDK is impossible: by the time control
  // reaches subscriptionAttemptBilling the contract id has already been traded for an attempt id.
  const { resolveBillingSource } = await import("@/lib/internal-subscription");
  if ((await resolveBillingSource(auth.workspaceId, String(contractId))) === "shopcx") {
    const { shopifyAttemptBilling, awaitBillingAttempt } = await import("@/lib/commerce/shopify-subscription-client");
    const { cycleKeyFromNextBillingDate } = await import("@/lib/subscription-cycle-charge-claim");
    const due = (resolved as { next_billing_date?: string | null }).next_billing_date ?? null;
    const cycleKey = cycleKeyFromNextBillingDate(due);
    // ⚠️ NOT the renewal worker's key. Reusing it makes Shopify REPLAY that cycle's cached
    // attempt: if the cron already succeeded the customer is told a new order was placed when none
    // was, and if it declined they can never self-serve after fixing their card — the stale
    // decline replays forever. A distinct key means this is a real, fresh attempt; the BILLED
    // pre-check below is what stops a genuine double charge.
    const cycleCheck = await (await import("@/lib/commerce/shopify-subscription-client"))
      .getBillingCycleForDate(auth.workspaceId, String(contractId), due ?? new Date().toISOString());
    if (cycleCheck.success && cycleCheck.cycle?.status === "BILLED") {
      return jsonErr({ error: "already_billed", message: "This order has already been placed." }, 409);
    }
    const started = await shopifyAttemptBilling(
      auth.workspaceId, String(contractId), `${contractId}:${cycleKey}:portal`,
      due ? { billingCycleSelector: { date: due } } : {},
    );
    if (!started.success || !started.attemptId) {
      return jsonErr({ error: "billing_failed", message: started.error ?? "Could not start billing." }, 502);
    }
    const outcome = await awaitBillingAttempt(auth.workspaceId, started.attemptId);
    if (outcome.pending) {
      return jsonOk({ ok: true, pending: true, message: "Your order is being processed." });
    }
    if (!outcome.success) {
      return jsonErr({ error: "billing_failed", message: outcome.error ?? "Payment was declined." }, 502);
    }
    // ⭐ ADVANCE THE DATE. Charging without advancing freezes the subscription permanently: the
    // cycle flips to BILLED, next_billing_date still points at it, and every subsequent nightly run
    // resolves that cycle as already-billed and skips WITHOUT advancing. Shopify fires nothing on
    // its own, so the sub silently stops earning and the skip is indistinguishable from a healthy
    // "nothing due" beat.
    {
      const { getUpcomingBillingCycles } = await import("@/lib/commerce/shopify-subscription-client");
      const admin = createAdminClient();
      const cycles = await getUpcomingBillingCycles(auth.workspaceId, String(contractId), { first: 6 });
      const nextUnbilled = (cycles.cycles ?? []).find(
        (c) => c.status === "UNBILLED" && !c.skipped && (!due || new Date(c.expectedDate).getTime() > new Date(due).getTime()),
      );
      if (nextUnbilled) {
        await admin.from("subscriptions")
          .update({ next_billing_date: nextUnbilled.expectedDate, last_payment_status: "succeeded", updated_at: new Date().toISOString() })
          .eq("workspace_id", auth.workspaceId).eq("shopify_contract_id", String(contractId));
      } else {
        console.error(`[portal order-now] charged ${contractId} but found no cycle after ${due} — date NOT advanced, needs attention`);
      }
    }

    const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
    if (customer) {
      await logPortalAction({
        workspaceId: auth.workspaceId, customerId: customer.id,
        eventType: "portal.order_now",
        summary: "Customer triggered immediate billing via portal (ShopCX-billed contract)",
        properties: { shopify_contract_id: String(contractId), order: outcome.orderName ?? null, cycle_key: cycleKey },
        createNote: true,
      });
    }
    return jsonOk({ ok: true, order: outcome.orderName ?? null });
  }

  const ordersRes = await appstleGetUpcomingOrders(auth.workspaceId, String(contractId));
  if (!ordersRes.success || !ordersRes.orders?.length) {
    return jsonErr({ error: "no_upcoming_orders", message: "No upcoming orders found to bill." }, 400);
  }

  const billingAttemptId = ordersRes.orders[0].id;
  const result = await appstleAttemptBilling(auth.workspaceId, billingAttemptId);
  if (!result.success) {
    // Concurrent-billing race: Appstle is ALREADY charging this contract (its
    // own scheduler beat us to it), so the customer's "Order now" intent is
    // satisfied — the order will land. Treat as success, log the collision so
    // analytics still see it, and skip the 502 path so the portal route doesn't
    // spawn a portal-action-failed ticket for a benign race.
    // See [[portal-order-now-billing-collision]] / Control Tower signature
    // vercel:7b36a7f314c061ed.
    if (/billing operation is already in progress/i.test(result.error || "")) {
      const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
      if (customer) {
        await logPortalAction({
          workspaceId: auth.workspaceId, customerId: customer.id,
          eventType: "portal.order_now",
          summary: "Customer triggered immediate billing via portal (collided with in-flight Appstle charge — order already being processed)",
          properties: { shopify_contract_id: String(contractId), billingAttemptId, collision: true },
          createNote: true,
        });
      }
      return jsonOk({
        ok: true,
        route,
        contractId,
        alreadyBilling: true,
        message: "Your renewal is already being processed.",
        patch: {},
      });
    }
    return handleAppstleError(new Error(result.error || "Billing failed"));
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.order_now",
      summary: "Customer triggered immediate billing via portal",
      properties: { shopify_contract_id: String(contractId), billingAttemptId },
      createNote: true,
    });
  }

  return jsonOk({ ok: true, route, contractId, patch: {} });
};
