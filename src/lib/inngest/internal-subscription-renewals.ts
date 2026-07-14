/**
 * Internal subscription renewal pipeline.
 *
 *   1. Daily cron picks every internal sub whose next_billing_date is
 *      today (or already in the past, which would mean a prior cron
 *      missed it).
 *   2. For each due sub, fire one `internal-subscription/renewal-attempt`
 *      event. Concurrency-controlled fan-out so 400 renewals don't
 *      hammer Braintree all at once.
 *   3. Per-sub handler: charge → transactions row → on success: order +
 *      Amplifier; on failure: dunning event (existing dunning system
 *      handles retries).
 *
 * Date math: subscriptions store billing_interval='day' + count for
 * internal subs (set at /api/checkout time). Advancing the next date
 * is just nextBillingDate + N days.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat, emitRenewalOutcomeHeartbeat, aggregateRenewalOutcomes } from "@/lib/control-tower/heartbeat";
import { getBraintreeGateway } from "@/lib/integrations/braintree";
import { createAmplifierOrder } from "@/lib/integrations/amplifier";
import { generateOrderNumber } from "@/lib/order-number";
import {
  checkRenewalOverchargeGuard,
  type RenewalGuardItem,
  type RenewalGuardLine,
} from "@/lib/subscription-renewal-guard";

// ─── Dunning retry-window filter ────────────────────────────────────
// Dunning is the source of truth for WHEN the next failed-payment retry is
// allowed: on decline, [[internal-dunning]] moves the sub's `next_billing_date`
// to the next payday and stamps `dunning_cycles.next_retry_at` to the same
// moment. The renewal cron then re-attempts on that day. If dunning has moved
// the retry FORWARD (payday shifted, exhausted-then-reopened, etc.) but the
// sub's own `next_billing_date` still reads "due today", THIS cron would
// otherwise dispatch a premature charge attempt before payday recovery —
// noisy Control Tower alerts + a re-decline on a card that's still empty.
//
// Filter: drop any candidate whose active dunning cycle carries a
// `next_retry_at` still in the future. Candidates with no active cycle, or a
// retry date already ≤ now, pass through untouched — the normal renewal path
// still runs.
//
// Pure — no I/O. Tested via [[../inngest/internal-subscription-renewals]]
// dunning-window test.
export function filterCandidatesByDunningRetryWindow<T extends { id: string }>(
  candidates: T[],
  activeCycles: Array<{ subscription_id: string | null; next_retry_at: string | null }>,
  now: Date,
): T[] {
  const nowMs = now.getTime();
  const blocked = new Set<string>();
  for (const c of activeCycles) {
    if (!c.subscription_id || !c.next_retry_at) continue;
    const t = new Date(c.next_retry_at).getTime();
    if (Number.isFinite(t) && t > nowMs) blocked.add(c.subscription_id);
  }
  return candidates.filter((c) => !blocked.has(c.id));
}

// ─── Daily cron (3 AM Central) ──────────────────────────────────────
// 9 AM UTC is 3 AM CST in winter, 4 AM CDT in summer. We accept the
// 1-hour DST drift because renewal timing is idempotent — even if a
// sub doesn't get picked up on day N at exactly 3 AM, the next-day
// run picks it up. Matches `auto-archive`'s pattern.
export const internalSubscriptionRenewalCron = inngest.createFunction(
  {
    id: "internal-subscription-renewal-cron",
    name: "Internal subscription renewals — daily fan-out",
    retries: 1,
    triggers: [{ cron: "0 9 * * *" }],  // 9 AM UTC = 3 AM CST / 4 AM CDT
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const due = await step.run("find-due-subs", async () => {
      // Catch anything due today (or earlier — backfills any prior
      // missed runs). End-of-day window so subs scheduled for any time
      // today are eligible.
      const now = new Date();
      const endOfToday = new Date();
      endOfToday.setUTCHours(23, 59, 59, 999);
      // Keyset-paginate — a bare select is capped at the PostgREST max-rows (1000).
      // Internal subs (~28K on a ~30-day cadence) run ~900/day, right at the cap; without
      // pagination the overflow is silently skipped (a missed renewal = lost revenue).
      const all: { id: string; workspace_id: string; shopify_contract_id: string | null }[] = [];
      let afterId: string | null = null;
      while (true) {
        let q = admin
          .from("subscriptions")
          .select("id, workspace_id, shopify_contract_id")
          .eq("is_internal", true)
          .eq("status", "active")
          .lte("next_billing_date", endOfToday.toISOString())
          .order("id", { ascending: true })
          .limit(1000);
        if (afterId) q = q.gt("id", afterId);
        const { data } = await q;
        if (!data?.length) break;
        // Dunning retry-window filter — drop candidates whose active dunning
        // cycle says the next retry is still in the future. Load ONLY the
        // active cycles for this page's ids (small subset), then delegate to
        // the pure helper for the "> now" decision. Pagination cursor is the
        // last raw id so keyset progression is unaffected by the filter.
        const pageIds = data.map((s) => s.id);
        const { data: cycles } = await admin
          .from("dunning_cycles")
          .select("subscription_id, next_retry_at")
          .in("subscription_id", pageIds)
          .in("status", ["retrying", "active"])
          .not("next_retry_at", "is", null);
        const kept = filterCandidatesByDunningRetryWindow(data, cycles ?? [], now);
        all.push(...kept);
        if (data.length < 1000) break;
        afterId = data[data.length - 1].id;
      }
      return all;
    });

    // Fan out one event per sub. Inngest's concurrency control on the
    // attempt function caps how many run at once.
    if (due.length > 0) {
      await step.sendEvent("renewal-events", due.map((s) => ({
        name: "internal-subscription/renewal-attempt",
        data: { subscription_id: s.id, workspace_id: s.workspace_id },
      })));
    }

    // Control Tower: end-of-run heartbeat (control-tower spec, Phase 1) carrying the per-cycle
    // outcome breakdown (control-tower-renewal-integrity-assertions, Phase 1). The attempts THIS
    // run just dispatched haven't executed yet (fan-out is async), so same-cycle counts aren't
    // knowable here; instead we bake in the most-recently-COMPLETED cycle's breakdown — the per-sub
    // outcome beats since the PREVIOUS cron beat (≈ the prior daily cycle, whose attempts have long
    // finished). The Control Tower's outcome-distribution assertion aggregates the LIVE current
    // cycle every ~15m for timely spike detection; this is the durable on-beat record.
    await step.run("emit-heartbeat", async () => {
      const { data: prevBeat } = await admin
        .from("loop_heartbeats")
        .select("ran_at")
        .eq("loop_id", "internal-subscription-renewal-cron")
        .order("ran_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const sinceIso = (prevBeat?.ran_at as string | undefined) ?? new Date(Date.now() - 26 * 60 * 60_000).toISOString();
      const last_cycle_outcomes = await aggregateRenewalOutcomes(admin, sinceIso);
      await emitCronHeartbeat("internal-subscription-renewal-cron", {
        ok: true,
        produced: { dispatched: due.length, last_cycle_outcomes, last_cycle_since: sinceIso },
      });
    });

    return { dispatched: due.length };
  },
);

// ─── Per-sub renewal handler ────────────────────────────────────────
// Concurrency 10 globally. Each invocation handles one sub end-to-end:
// charge → transaction row → order + Amplifier OR dunning.
export const internalSubscriptionRenewalAttempt = inngest.createFunction(
  {
    id: "internal-subscription-renewal-attempt",
    name: "Internal subscription renewal — single sub",
    retries: 3,
    concurrency: [{ limit: 10 }],
    triggers: [{ event: "internal-subscription/renewal-attempt" }],
  },
  async ({ event, step }) => {
    const { subscription_id, workspace_id } = event.data as {
      subscription_id: string;
      workspace_id: string;
    };

    const admin = createAdminClient();

    // ── 0. Comp branch ──────────────────────────────────────────
    // A comp sub ships FREE on schedule: no payment method, no Braintree charge,
    // no Avalara/shipping — base $0 by design (item price_override_cents=0). It is
    // gated FAIL-CLOSED on the allowlist: a comp sub whose customer has no valid
    // `comp_role` does NOT ship — it records a failed `comp` transaction + event
    // and stops (no $0 leak). Branch before load-context, which hard-requires a PM.
    const comp = await step.run("load-comp-context", async () => {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("id, workspace_id, customer_id, items, comp, comp_note, is_internal, status, billing_interval, billing_interval_count, next_billing_date, shopify_contract_id, shipping_address, shipping_method_code")
        .eq("id", subscription_id)
        .single();
      if (!sub?.comp) return { isComp: false } as const;
      if (!sub.is_internal || sub.status !== "active" || !sub.customer_id) {
        return { isComp: true, blocked: `inactive_${sub.status}` } as const;
      }

      const { data: customer } = await admin
        .from("customers")
        .select("id, email, first_name, last_name, phone, shopify_customer_id, default_address, comp_role")
        .eq("id", sub.customer_id)
        .single();
      if (!customer) return { isComp: true, blocked: "customer_not_found" } as const;

      const { data: lastOrder } = await admin
        .from("orders")
        .select("shipping_address, billing_address")
        .eq("customer_id", sub.customer_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const resolvedShipping =
        (sub.shipping_address as Record<string, unknown> | null) ||
        (lastOrder?.shipping_address as Record<string, unknown> | null) ||
        (customer.default_address as Record<string, unknown> | null) ||
        null;

      return {
        isComp: true,
        sub,
        customer,
        comp_role: (customer.comp_role as string | null) ?? null,
        shipping_address: resolvedShipping,
        billing_address: (lastOrder?.billing_address as Record<string, unknown> | null) || resolvedShipping,
      } as const;
    });

    if (comp.isComp) {
      if ("blocked" in comp && comp.blocked) {
        await step.run("emit-outcome-comp-blocked", () => emitRenewalOutcomeHeartbeat("comp_blocked"));
        return { skipped: true, reason: comp.blocked };
      }
      // narrow: full comp context
      const c = comp as Extract<typeof comp, { sub: unknown }>;

      // ── Allowlist gate (FAIL-CLOSED) ──────────────────────────
      const VALID_COMP_ROLES = ["employee", "influencer", "investor", "owner"];
      const allowlisted = !!c.comp_role && VALID_COMP_ROLES.includes(c.comp_role);
      if (!allowlisted) {
        // Surface — failed `comp` transaction + timeline event. Do NOT ship, do
        // NOT advance. Catches a $0 sub that shouldn't be free (misconfig, stale
        // flag, abuse) instead of leaking product.
        await step.run("comp-gate-failed-transaction", async () => {
          const { error } = await admin.from("transactions").insert({
            workspace_id,
            customer_id: c.sub.customer_id,
            subscription_id,
            type: "comp",
            status: "failed",
            amount_cents: 0,
            currency: "USD",
            error_message: `comp renewal blocked — customer not on comp allowlist (comp_role=${c.comp_role ?? "null"})`,
            metadata: { needs_attention: true, reason: "comp_not_allowlisted", comp_role: c.comp_role },
          });
          // Fail loud: the fail-closed gate's whole contract is that a blocked
          // comp sub LEAVES a needs_attention ledger row. A swallowed insert
          // error defeats that silently — error the step so it's visible/retried.
          if (error) throw new Error(`comp_gate_failed_transaction_insert_failed: ${error.message}`);
        });
        await step.run("comp-gate-failed-event", async () => {
          const { logCustomerEvent } = await import("@/lib/customer-events");
          await logCustomerEvent({
            workspaceId: workspace_id,
            customerId: c.sub.customer_id as string | null,
            eventType: "subscription.comp_renewal_failed",
            source: "internal_subscription_renewal",
            summary: "Comp renewal blocked — customer is not on the comp allowlist (no valid comp_role). No free shipment sent.",
            properties: { subscription_id, comp_role: c.comp_role, needs_attention: true },
          });
        });
        await step.run("emit-outcome-comp-not-allowlisted", () => emitRenewalOutcomeHeartbeat("comp_blocked"));
        return { ok: false, failed: true, reason: "comp_not_allowlisted" };
      }

      // ── Resolve items (all $0 by design) ──────────────────────
      const { resolveSubscriptionPricing } = await import("@/lib/pricing");
      const pricing = await resolveSubscriptionPricing(workspace_id, c.sub);
      const compItems = pricing.lines
        .filter((l) => l.kind === "product")
        .map((l) => ({
          variant_id: l.variant_id,
          sku: l.sku || undefined,
          title: l.title,
          variant_title: l.variant_title || undefined,
          quantity: l.quantity,
          price_cents: 0, // comp = free by design
        }));

      const compOrderNumber = await step.run("comp-reserve-order-number", async () => {
        return generateOrderNumber(workspace_id);
      });

      // ── $0 renewal order — a clear marker that does NOT trip dunning ───
      const compOrder = await step.run("comp-create-order", async () => {
        const { data: order, error } = await admin
          .from("orders")
          .insert({
            workspace_id,
            customer_id: c.sub.customer_id,
            shopify_customer_id: c.customer.shopify_customer_id || null,
            shopify_order_id: null,
            order_number: compOrderNumber,
            email: c.customer.email,
            total_cents: 0,
            currency: "USD",
            financial_status: "paid", // $0 paid — a comp marker, never a failed payment
            fulfillment_status: null,
            line_items: compItems,
            source_name: "internal_subscription_comp_renewal",
            shipping_address: c.shipping_address,
            billing_address: c.billing_address || c.shipping_address,
            subscription_id,
            payment_details: {
              comp: true,
              comp_role: c.comp_role,
              subtotal_cents: 0,
              discount_cents: 0,
              shipping_cents: 0,
              protection_cents: 0,
              tax_cents: 0,
              gateway: "comp",
            },
          })
          .select("id, order_number")
          .single();
        if (error || !order) throw new Error(`comp_order_insert_failed: ${error?.message}`);
        return { id: order.id as string, order_number: order.order_number as string };
      });

      // ── Ledger row: type='comp', $0, no Braintree id ──────────
      await step.run("comp-transaction", async () => {
        const { error } = await admin.from("transactions").insert({
          workspace_id,
          customer_id: c.sub.customer_id,
          subscription_id,
          order_id: compOrder.id,
          type: "comp",
          status: "succeeded",
          amount_cents: 0,
          currency: "USD",
          settled_at: new Date().toISOString(),
          metadata: { comp: true, comp_role: c.comp_role, comp_note: c.sub.comp_note ?? null },
        });
        // Fail loud: a comp renewal that shipped free must leave its ledger
        // record. A swallowed insert error drops the audit trail silently —
        // error the step so it's visible/retried.
        if (error) throw new Error(`comp_transaction_insert_failed: ${error.message}`);
      });

      // ── Advance next_billing_date (drop spent one-time items) ──
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const compDroppedOneTime = ((c.sub.items as any[]) || []).some((i) => i?.one_time_next_renewal === true);
      await step.run("comp-advance-next-billing-date", async () => {
        const interval = (c.sub.billing_interval || "day").toLowerCase();
        const count = c.sub.billing_interval_count || 1;
        const current = c.sub.next_billing_date ? new Date(c.sub.next_billing_date) : new Date();
        const next = new Date(current);
        if (interval === "day") next.setUTCDate(next.getUTCDate() + count);
        else if (interval === "week") next.setUTCDate(next.getUTCDate() + count * 7);
        else if (interval === "month") next.setUTCMonth(next.getUTCMonth() + count);
        else if (interval === "year") next.setUTCFullYear(next.getUTCFullYear() + count);
        else next.setUTCDate(next.getUTCDate() + count * 28);
        const update: Record<string, unknown> = {
          next_billing_date: next.toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (compDroppedOneTime) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          update.items = ((c.sub.items as any[]) || []).filter((i) => !i?.one_time_next_renewal);
        }
        await admin.from("subscriptions").update(update).eq("id", subscription_id);
      });

      // ── Hand off to Amplifier (free fulfillment) ──────────────
      await step.run("comp-amplifier-order", async () => {
        type Item2 = { variant_id?: string; sku?: string; title?: string; variant_title?: string; quantity?: number; price_cents?: number };
        const lineItemsForAmplifier = compItems.map((l: Item2) => ({
          sku: (l.sku as string) || undefined,
          title: l.title,
          description: l.variant_title ? `${l.title} — ${l.variant_title}` : l.title,
          quantity: l.quantity,
          unit_price_cents: 0,
          reference_id: l.variant_id ? String(l.variant_id) : undefined,
        }));

        let packingSlipMessage: string | undefined;
        try {
          const { buildPackingSlipMessage } = await import("@/lib/packing-slip-message");
          const distinctProducts = new Set(compItems.map((l: Item2) => String(l.variant_id || l.sku || l.title))).size;
          packingSlipMessage = await buildPackingSlipMessage({
            workspaceId: workspace_id,
            customerId: c.sub.customer_id as string,
            orderId: compOrder.id,
            firstName: c.customer.first_name || "",
            productCount: distinctProducts,
          });
        } catch (e) {
          console.warn(`[comp-renewal] packing slip message failed for ${compOrder.order_number}:`, e instanceof Error ? e.message : e);
        }

        const amplifierRes = await createAmplifierOrder({
          workspaceId: workspace_id,
          orderNumber: compOrder.order_number,
          orderDate: new Date().toISOString(),
          shippingAddress: c.shipping_address as Record<string, string> | null,
          billingAddress: c.billing_address as Record<string, string> | null,
          email: c.customer.email,
          phone: c.customer.phone || null,
          lineItems: lineItemsForAmplifier,
          totalCents: 0,
          subtotalCents: 0,
          shippingCents: 0,
          taxCents: 0,
          packingSlipMessage,
        });
        if (amplifierRes.success && amplifierRes.amplifier_order_id) {
          await admin
            .from("orders")
            .update({
              amplifier_order_id: amplifierRes.amplifier_order_id,
              amplifier_received_at: new Date().toISOString(),
            })
            .eq("id", compOrder.id);
        } else {
          console.warn(`[comp-renewal] Amplifier order create failed for ${compOrder.order_number}:`, amplifierRes.error, amplifierRes.details);
        }
      });

      // ── Timeline event ────────────────────────────────────────
      await step.run("comp-shipped-event", async () => {
        const { logCustomerEvent } = await import("@/lib/customer-events");
        await logCustomerEvent({
          workspaceId: workspace_id,
          customerId: c.sub.customer_id as string | null,
          eventType: "subscription.comp_shipped",
          source: "internal_subscription_renewal",
          summary: `Comp subscription shipped free (role: ${c.comp_role}).`,
          properties: { subscription_id, order_id: compOrder.id, order_number: compOrder.order_number, comp_role: c.comp_role },
        });
      });

      await step.run("emit-outcome-comp-shipped", () => emitRenewalOutcomeHeartbeat("comp_shipped"));
      return { ok: true, comp: true, order_id: compOrder.id, order_number: compOrder.order_number };
    }

    // ── 1. Load sub + customer + default payment method ──────────
    const ctx = await step.run("load-context", async () => {
      const { data: sub } = await admin
        .from("subscriptions")
        .select("id, workspace_id, customer_id, items, billing_interval, billing_interval_count, next_billing_date, status, applied_discounts, shopify_contract_id, is_internal, delivery_price_cents, shipping_protection_added, shipping_protection_amount_cents, shipping_method_code, shipping_address, payment_method_id")
        .eq("id", subscription_id)
        .single();
      if (!sub?.is_internal) return { skip: true, reason: "not_internal" } as const;
      if (sub.status !== "active") return { skip: true, reason: `status_${sub.status}` } as const;
      if (!sub.customer_id) return { skip: true, reason: "no_customer" } as const;

      // Charge the sub's PINNED card if set + still valid, else the customer's
      // default. (The pin is set in the portal; falls back automatically if the
      // pinned card was removed.)
      let pm: { id: string; braintree_customer_id: string; braintree_payment_method_token: string } | null = null;
      if (sub.payment_method_id) {
        const { data } = await admin
          .from("customer_payment_methods")
          .select("id, braintree_customer_id, braintree_payment_method_token")
          .eq("workspace_id", workspace_id)
          .eq("id", sub.payment_method_id)
          .eq("status", "active")
          .maybeSingle();
        pm = data;
      }
      if (!pm) {
        // Default card spans the LINK GROUP (one default per person), so it may
        // live on a linked sibling, not sub.customer_id.
        const { linkGroupIds } = await import("@/lib/customer-links");
        const groupIds = await linkGroupIds(admin, workspace_id, sub.customer_id);
        const { data } = await admin
          .from("customer_payment_methods")
          .select("id, braintree_customer_id, braintree_payment_method_token")
          .eq("workspace_id", workspace_id)
          .in("customer_id", groupIds)
          .eq("status", "active")
          .eq("is_default", true)
          .limit(1)
          .maybeSingle();
        pm = data;
      }
      if (!pm) return { skip: true, reason: "no_payment_method" } as const;

      const { data: customer } = await admin
        .from("customers")
        .select("id, email, first_name, last_name, phone, shopify_customer_id, default_address")
        .eq("id", sub.customer_id)
        .single();
      if (!customer) return { skip: true, reason: "customer_not_found" } as const;

      // Shipping address. subscriptions.shipping_address is the SOURCE OF TRUTH —
      // the portal address handler + checkout write it, so a customer's address
      // change takes effect on the next renewal. Fall back to the most recent
      // order, then the customer's default, so an older sub still ships.
      const { data: lastOrder } = await admin
        .from("orders")
        .select("shipping_address, billing_address")
        .eq("customer_id", sub.customer_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const resolvedShipping =
        (sub.shipping_address as Record<string, unknown> | null) ||
        (lastOrder?.shipping_address as Record<string, unknown> | null) ||
        (customer.default_address as Record<string, unknown> | null) ||
        null;

      return {
        skip: false,
        sub,
        pm,
        customer,
        shipping_address: resolvedShipping,
        billing_address: (lastOrder?.billing_address as Record<string, unknown> | null) || resolvedShipping,
      } as const;
    });

    if (ctx.skip) {
      // no_payment_method is the load-bearing skip the outcome-distribution assertion watches for
      // a spike; the rest (not_internal / status_* / no_customer / customer_not_found) are benign
      // between-fan-out-and-attempt state changes → skipped_other.
      await step.run("emit-outcome-skip", () =>
        emitRenewalOutcomeHeartbeat(ctx.reason === "no_payment_method" ? "skipped_no_payment_method" : "skipped_other"),
      );
      return { skipped: true, reason: ctx.reason };
    }

    // ── 2. Compute charge amount ────────────────────────────────
    // Prices are DERIVED from the catalog + pricing rules (quantity break × S&S,
    // grandfathered overrides) — never read from a baked value on the row. The
    // engine returns per-line charged prices; we snapshot them as the order's
    // line items (an order is a historical record, so it DOES bake the price).
    //
    // Phase 3 of offer-creator: strip offer-sourced $0 items whose current
    // offer scope is `checkout_only` BEFORE pricing runs, so a monthly renewal
    // ships only the paid product. Items with scope `checkout_and_renewals`
    // pass through and are priced as $0 gift lines. A deleted / deactivated
    // offer is treated as `checkout_only` (safety default — don't ship an
    // extra that no longer has an active offer backing it).
    const { stripCheckoutOnlyOfferItems } = await import("@/lib/offers");
    const strippedItems = await stripCheckoutOnlyOfferItems(
      workspace_id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Array.isArray(ctx.sub.items) ? (ctx.sub.items as any[]) : []) as Array<{
        variant_id?: unknown;
        offer_source_variant_id?: unknown;
        is_gift?: unknown;
      }>,
    );
    const subForPricing = { ...ctx.sub, items: strippedItems };

    const { resolveSubscriptionPricing } = await import("@/lib/pricing");
    const pricing = await resolveSubscriptionPricing(workspace_id, subForPricing);
    const items = pricing.lines
      .filter((l) => l.kind === "product")
      .map((l) => ({
        variant_id: l.variant_id,
        sku: l.sku || undefined,
        title: l.title,
        variant_title: l.variant_title || undefined,
        quantity: l.quantity,
        price_cents: l.unit_cents,
      }));
    const subtotalCents = pricing.product_subtotal_cents;

    // ── Phase 2 fail-safe: overcharge guard ─────────────────────
    // Never bill above the sub's own configured line total. A grandfathered
    // customer's configured ceiling is `price_cents` (post-discount lock) or
    // `price_override_cents` (pre-discount base) per item; items with neither
    // are uncapped (live-catalog opt-in). If the engine's computed unit for any
    // product line exceeds its ceiling — a divergence between what the engine
    // said and what the sub is configured for — HOLD the renewal: skip the
    // charge, log a customer_event for review, emit an outcome heartbeat. The
    // sub's next_billing_date is NOT advanced so a fix + re-run picks it back
    // up. Belt & suspenders to the Phase 1 engine change: if a future repricing
    // bug reintroduces catalog decomposition, this guard catches it BEFORE the
    // customer is charged. See docs/brain/specs/subscription-renewal-honors-
    // configured-grandfathered-price-never-bills-standard.md.
    const guard = checkRenewalOverchargeGuard(
      (subForPricing.items as unknown as RenewalGuardItem[]) || [],
      pricing.lines as unknown as RenewalGuardLine[],
    );
    if (!guard.ok) {
      await step.run("emit-outcome-overcharge-guard-hold", () =>
        emitRenewalOutcomeHeartbeat("skipped_other"),
      );
      await step.run("log-overcharge-guard-hold", async () => {
        const { logCustomerEvent } = await import("@/lib/customer-events");
        await logCustomerEvent({
          workspaceId: workspace_id,
          customerId: (ctx.sub.customer_id as string | null) ?? null,
          eventType: "subscription.renewal_held_overcharge_guard",
          source: "internal_subscription_renewal",
          summary:
            `Renewal held — computed product subtotal $${(guard.computed_product_cents / 100).toFixed(2)} ` +
            `exceeds configured cap $${(guard.configured_cap_cents / 100).toFixed(2)} on ${guard.offending_lines.length} line(s). ` +
            `Not submitted to Braintree; review the sub's configured line prices.`,
          properties: {
            subscription_id,
            reason: guard.reason,
            computed_product_cents: guard.computed_product_cents,
            configured_cap_cents: guard.configured_cap_cents,
            offending_lines: guard.offending_lines,
          },
        });
      });
      return { skipped: true, reason: "overcharge_guard_held" };
    }

    // Free shipping is a pricing-rule decision; falls back to the sub's locked rate.
    const shippingCents = pricing.shipping_cents;
    const protectionCents = ctx.sub.shipping_protection_added
      ? Number(ctx.sub.shipping_protection_amount_cents || 0)
      : 0;

    // Entire-order coupon discounts. The sub stores coupon CODES; we live-read
    // each (Shopify / our coupons table), skip ones this customer has already
    // exhausted (one-time / cycle limit), apply the rest, and report which codes
    // to keep vs drop. Redemptions are recorded only AFTER a successful charge
    // (record-coupon-redemptions step below).
    const { resolveRenewalDiscount } = await import("@/lib/coupons");
    const { discountCents, keepCodes, toRedeem } = await step.run("resolve-coupons", async () =>
      resolveRenewalDiscount(
        workspace_id,
        (ctx.sub.applied_discounts as Array<Record<string, unknown>> | null) ?? null,
        subtotalCents,
        (ctx.sub.customer_id as string | null) ?? null,
      ),
    );

    // Post-coupon taxable base: scale the line prices by the coupon ratio for
    // the Avalara quote ONLY — the order still records full prices + discount_cents.
    const taxItems = discountCents > 0 && subtotalCents > 0
      ? (items as Array<Record<string, unknown>>).map((i) => ({
          ...i,
          price_cents: Math.round((Number(i.price_cents) || 0) * (subtotalCents - discountCents) / subtotalCents),
        }))
      : items;

    // Reserve the order number NOW so we can use it as the Avalara
    // document code. The orders row gets inserted with this same
    // value below.
    const orderNumber = await step.run("reserve-order-number", async () => {
      return generateOrderNumber(workspace_id);
    });

    // Authoritative tax via Avalara (commit=true, SalesInvoice).
    // Returns null when Avalara isn't enabled or inputs are
    // insufficient — in that case we fall back to $0 tax + log.
    const taxResult = await step.run("avalara-commit", async () => {
      const { commitSubscriptionRenewalTax } = await import("@/lib/avalara-subscription");
      return commitSubscriptionRenewalTax(workspace_id, {
        subscriptionId: subscription_id,
        orderNumber,
        items: taxItems,
        shippingAddress: ctx.shipping_address || ctx.sub.shipping_address,
        shippingCents,
        shippingMethodLabel: (ctx.sub.shipping_method_code as string | null) || "Shipping",
        protectionCents,
        customerEmail: ctx.customer.email || null,
      });
    });
    const taxCents = taxResult?.tax_cents ?? 0;
    const avalaraTransactionCode = taxResult?.transaction_code || null;

    const totalCents = Math.max(0, subtotalCents - discountCents) + shippingCents + protectionCents + taxCents;
    if (totalCents <= 0) {
      await step.run("emit-outcome-zero-total", () => emitRenewalOutcomeHeartbeat("skipped_zero_total"));
      // Advance next_billing_date so a $0 renewal (e.g. 100%-off coupon) still
      // rolls the calendar forward — otherwise the sub stays overdue and the
      // Control Tower renewal-integrity tile flips red every day. Mirrors the
      // comp branch's advance step; drops any spent one-time items.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const zeroDroppedOneTime = ((ctx.sub.items as any[]) || []).some((i) => i?.one_time_next_renewal === true);
      await step.run("zero-total-advance-next-billing-date", async () => {
        const interval = (ctx.sub.billing_interval || "day").toLowerCase();
        const count = ctx.sub.billing_interval_count || 1;
        const current = ctx.sub.next_billing_date ? new Date(ctx.sub.next_billing_date) : new Date();
        const next = new Date(current);
        if (interval === "day") next.setUTCDate(next.getUTCDate() + count);
        else if (interval === "week") next.setUTCDate(next.getUTCDate() + count * 7);
        else if (interval === "month") next.setUTCMonth(next.getUTCMonth() + count);
        else if (interval === "year") next.setUTCFullYear(next.getUTCFullYear() + count);
        else next.setUTCDate(next.getUTCDate() + count * 28);
        const update: Record<string, unknown> = {
          next_billing_date: next.toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (zeroDroppedOneTime) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          update.items = ((ctx.sub.items as any[]) || []).filter((i) => !i?.one_time_next_renewal);
        }
        await admin.from("subscriptions").update(update).eq("id", subscription_id);
      });
      return { skipped: true, reason: "zero_total" };
    }

    // ── 3. Insert pending transactions row ──────────────────────
    const txnRowId = await step.run("insert-pending-transaction", async () => {
      const { data: row } = await admin
        .from("transactions")
        .insert({
          workspace_id,
          customer_id: ctx.sub.customer_id,
          subscription_id,
          payment_method_id: ctx.pm.id,
          type: "renewal",
          status: "pending",
          amount_cents: totalCents,
          currency: "USD",
          braintree_payment_method_token: ctx.pm.braintree_payment_method_token,
          braintree_customer_id: ctx.pm.braintree_customer_id,
        })
        .select("id")
        .single();
      return (row?.id as string) || "";
    });

    // ── 4. Charge ───────────────────────────────────────────────
    const charge = await step.run("braintree-sale", async () => {
      const gateway = await getBraintreeGateway(workspace_id);
      const result = await gateway.transaction.sale({
        amount: (totalCents / 100).toFixed(2),
        paymentMethodToken: ctx.pm.braintree_payment_method_token,
        customerId: ctx.pm.braintree_customer_id,
        options: { submitForSettlement: true },
      });
      return {
        success: !!result.success,
        message: result.message,
        transactionId: result.transaction?.id || null,
        processorResponseCode: result.transaction?.processorResponseCode || null,
        processorResponseText: result.transaction?.processorResponseText || null,
      };
    });

    // ── 5. Update transactions row ──────────────────────────────
    if (txnRowId) {
      await admin.from("transactions").update({
        status: charge.success ? "succeeded" : "failed",
        braintree_transaction_id: charge.transactionId,
        processor_response_code: charge.processorResponseCode,
        processor_response_text: charge.processorResponseText,
        error_message: charge.success ? null : charge.message,
        updated_at: new Date().toISOString(),
      }).eq("id", txnRowId);
    }

    if (!charge.success) {
      // Void the Avalara invoice we committed before the charge —
      // we filed tax for a renewal that didn't actually happen.
      if (avalaraTransactionCode) {
        await step.run("avalara-void-on-failed-charge", async () => {
          try {
            const { voidTransaction } = await import("@/lib/avalara");
            await voidTransaction(workspace_id, avalaraTransactionCode);
          } catch (err) {
            console.warn(`[renewal] Avalara void after Braintree fail threw for ${orderNumber}:`, err);
          }
        });
      }
      // Failure → internal dunning. Include shopify_contract_id (the internal-* id,
      // which dunning keys cycles on) + the Braintree decline code as error_code so
      // the dunning router can create a proper cycle. Also log a customer_events
      // failure NOW so the timeline + AI see it regardless of dunning's outcome.
      await step.run("log-payment-failed-event", async () => {
        const { logCustomerEvent } = await import("@/lib/customer-events");
        await logCustomerEvent({
          workspaceId: workspace_id,
          customerId: ctx.sub.customer_id as string | null,
          eventType: "subscription.payment_failed",
          source: "internal_subscription_renewal",
          summary: `Renewal payment failed${charge.processorResponseText ? ` — ${charge.processorResponseText}` : ""}`,
          properties: { subscription_id, amount_cents: totalCents, braintree_transaction_id: charge.transactionId, processor_response_code: charge.processorResponseCode },
        });
      });
      await step.sendEvent("dunning-event", {
        name: "dunning/payment-failed",
        data: {
          workspace_id,
          subscription_id,
          shopify_contract_id: ctx.sub.shopify_contract_id, // internal-* id
          customer_id: ctx.sub.customer_id,
          amount_cents: totalCents,
          braintree_transaction_id: charge.transactionId,
          error_code: charge.processorResponseCode,
          error_message: charge.processorResponseText,
          processor_response_code: charge.processorResponseCode,
          processor_response_text: charge.processorResponseText,
          source: "internal_subscription_renewal",
        },
      });
      await step.run("emit-outcome-declined", () => emitRenewalOutcomeHeartbeat("declined_to_dunning"));
      return { ok: false, failed: true, message: charge.message };
    }

    // ── 6. Create order + advance next_billing_date ─────────────
    const newOrder = await step.run("create-order", async () => {
      const { data: order, error } = await admin
        .from("orders")
        .insert({
          workspace_id,
          customer_id: ctx.sub.customer_id,
          shopify_customer_id: ctx.customer.shopify_customer_id || null,
          shopify_order_id: null,
          order_number: orderNumber,
          email: ctx.customer.email,
          total_cents: totalCents,
          currency: "USD",
          financial_status: "paid",
          fulfillment_status: null,
          line_items: items,
          source_name: "internal_subscription_renewal",
          shipping_address: ctx.shipping_address,
          billing_address: ctx.billing_address || ctx.shipping_address,
          braintree_transaction_id: charge.transactionId,
          braintree_payment_method_token: ctx.pm.braintree_payment_method_token,
          braintree_customer_id: ctx.pm.braintree_customer_id,
          subscription_id,
          payment_details: {
            subtotal_cents: subtotalCents,
            discount_cents: discountCents,
            shipping_cents: shippingCents,
            protection_cents: protectionCents,
            tax_cents: taxCents,
            gateway: "braintree",
            processor_response_code: charge.processorResponseCode,
            processor_response_text: charge.processorResponseText,
          },
          avalara_transaction_code: avalaraTransactionCode,
          avalara_total_tax_cents: avalaraTransactionCode ? taxCents : null,
          avalara_committed_at: avalaraTransactionCode ? new Date().toISOString() : null,
        })
        .select("id, order_number")
        .single();
      if (error || !order) throw new Error(`order_insert_failed: ${error?.message}`);
      // Backfill the transaction row with the order id.
      if (txnRowId) await admin.from("transactions").update({ order_id: order.id }).eq("id", txnRowId);
      return { id: order.id as string, order_number: order.order_number as string };
    });

    // Drop any one_time_next_renewal items now that they've shipped
    // on this renewal — they're spent. Recurring items stay.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const droppedAnyOneTime = ((ctx.sub.items as any[]) || []).some((i) => i?.one_time_next_renewal === true);
    // Advance next_billing_date by exactly `count` × `interval`.
    await step.run("advance-next-billing-date", async () => {
      const interval = (ctx.sub.billing_interval || "day").toLowerCase();
      const count = ctx.sub.billing_interval_count || 1;
      const current = ctx.sub.next_billing_date ? new Date(ctx.sub.next_billing_date) : new Date();
      const next = new Date(current);
      if (interval === "day") next.setUTCDate(next.getUTCDate() + count);
      else if (interval === "week") next.setUTCDate(next.getUTCDate() + count * 7);
      else if (interval === "month") next.setUTCMonth(next.getUTCMonth() + count);
      else if (interval === "year") next.setUTCFullYear(next.getUTCFullYear() + count);
      else next.setUTCDate(next.getUTCDate() + count * 28);
      // Filter out one-time items — they shipped on this renewal and
      // shouldn't recur.
      const update: Record<string, unknown> = {
        next_billing_date: next.toISOString(),
        // Clear the stale failed flag — internal subs never fire the Appstle
        // billing-success webhook, so without this the portal change-date /
        // change-frequency guards stay locked forever after the first failure
        // (escalated ticket efe0d2ad — Annmarie).
        last_payment_status: "succeeded",
        // Keep only the coupon codes that still have cycles left — codes that
        // hit their one-time / cycle limit this charge are dropped off the sub.
        // Stored as bare { code } references; the value is re-read live next time.
        applied_discounts: keepCodes.map((c) => ({ code: c })),
        updated_at: new Date().toISOString(),
      };
      if (droppedAnyOneTime) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update.items = ((ctx.sub.items as any[]) || []).filter((i) => !i?.one_time_next_renewal);
      }
      await admin
        .from("subscriptions")
        .update(update)
        .eq("id", subscription_id);
    });

    // Record coupon redemptions — only now, after a successful charge, so a
    // failed charge never burns a one-time code. Separate step for idempotency.
    if (toRedeem.length) {
      await step.run("record-coupon-redemptions", async () => {
        const { recordCouponRedemption } = await import("@/lib/coupons");
        for (const rc of toRedeem) {
          await recordCouponRedemption(workspace_id, rc, (ctx.sub.customer_id as string | null) ?? null, {
            subscriptionId: subscription_id,
            orderId: newOrder.id,
          });
        }
      });
    }

    // ── 7. Hand off to Amplifier for fulfillment ────────────────
    // Non-fatal: payment is already done; an Amplifier failure just
    // means manual fulfillment. amplifier_order_id gets backfilled to
    // the order on success so the rest of the dashboard works.
    await step.run("amplifier-order", async () => {
      type Item2 = { variant_id?: string; sku?: string; title?: string; variant_title?: string; quantity?: number; price_cents?: number };
      const lineItemsForAmplifier = items.map((l: Item2) => ({
        sku: (l.sku as string) || undefined,
        title: l.title,
        description: l.variant_title ? `${l.title} — ${l.variant_title}` : l.title,
        quantity: l.quantity,
        unit_price_cents: l.price_cents,
        reference_id: l.variant_id ? String(l.variant_id) : undefined,
      }));

      // Haiku-personalized founder note on the packing slip — same as the
      // storefront checkout. Non-fatal: a generation failure just falls back to
      // the static template inside buildPackingSlipMessage.
      let packingSlipMessage: string | undefined;
      try {
        const { buildPackingSlipMessage } = await import("@/lib/packing-slip-message");
        const distinctProducts = new Set(items.map((l: Item2) => String(l.variant_id || l.sku || l.title))).size;
        packingSlipMessage = await buildPackingSlipMessage({
          workspaceId: workspace_id,
          customerId: ctx.sub.customer_id as string,
          orderId: newOrder.id,
          firstName: ctx.customer.first_name || "",
          productCount: distinctProducts,
        });
      } catch (e) {
        console.warn(`[renewal] packing slip message failed for ${newOrder.order_number}:`, e instanceof Error ? e.message : e);
      }

      const amplifierRes = await createAmplifierOrder({
        workspaceId: workspace_id,
        orderNumber: newOrder.order_number,
        orderDate: new Date().toISOString(),
        shippingAddress: ctx.shipping_address as Record<string, string> | null,
        billingAddress: ctx.billing_address as Record<string, string> | null,
        email: ctx.customer.email,
        phone: ctx.customer.phone || null,
        lineItems: lineItemsForAmplifier,
        totalCents,
        subtotalCents,
        shippingCents,
        taxCents,
        packingSlipMessage,
      });
      if (amplifierRes.success && amplifierRes.amplifier_order_id) {
        await admin
          .from("orders")
          .update({
            amplifier_order_id: amplifierRes.amplifier_order_id,
            amplifier_received_at: new Date().toISOString(),
          })
          .eq("id", newOrder.id);
      } else {
        console.warn(`[renewal] Amplifier order create failed for ${newOrder.order_number}:`, amplifierRes.error, amplifierRes.details);
      }
    });

    // ── 8. Close any open dunning cycle ─────────────────────────
    // Internal subs have no Appstle billing-success webhook to close the cycle,
    // so a recovered renewal must close it here (marks recovered + timeline event).
    await step.run("close-dunning-cycle", async () => {
      const { closeInternalDunningOnSuccess } = await import("@/lib/inngest/internal-dunning");
      await closeInternalDunningOnSuccess(
        workspace_id,
        subscription_id,
        ctx.sub.shopify_contract_id as string,
        ctx.sub.customer_id as string | null,
      );
    });

    await step.run("emit-outcome-charged", () => emitRenewalOutcomeHeartbeat("charged"));
    return { ok: true, order_id: newOrder.id, order_number: newOrder.order_number };
  },
);
