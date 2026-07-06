"use client";

/**
 * Subscription detail screen — every retention action lives here.
 *
 * Reads the contract from /api/portal?route=subscriptions (the list
 * endpoint already returns full contract shapes via
 * transformSubscription, including the new internal_id). Catalog for
 * add/swap comes from /api/portal?route=bootstrap.
 *
 * Action cards in this commit:
 *   - ItemsActionsCard with per-line disclosure (Change flavor /
 *     Swap product / Change quantity / Remove) and a top-level
 *     "Add item" CTA.
 *
 * Action cards landing in later commits:
 *   - PauseCard / ResumeCard / ReactivateCard
 *   - OrderActionsCard (order now / change date)
 *   - FrequencyCard
 *   - AddressCard
 *   - CouponCard
 *   - PaymentMethodCard
 *   - CancelCard
 *   - ShippingProtectionCard / RewardsCard / ReviewsCard
 */

import { useCallback, useEffect, useState } from "react";
import { ActionOverlay, type ActionPhase } from "../_components/ActionOverlay";
import { friendlyCadence } from "@/lib/portal/helpers/cadence";
import { deliveryStatusTag, financialTag, type OrderStatusInput, type OrderStatusTag } from "./order-status";

// ─────────────────────────────── types ──────────────────────────────

export interface ContractLine {
  id: string;
  title?: string;
  variantTitle?: string | null;
  quantity?: number;
  sku?: string | null;
  variantId?: string;
  productId?: string;
  variantImage?: { transformedSrc?: string } | null;
  currentPrice?: { amount?: string; currencyCode?: string };
  /** Strikethrough "full" price per unit (internal subs: catalog/grandfathered
   *  base before quantity break + S&S). Only set when it exceeds currentPrice. */
  basePrice?: { amount?: string; currencyCode?: string } | null;
  is_gift?: boolean;
}

export interface AppliedDiscount {
  id?: string;
  code?: string;
  title?: string;
  value?: number | string;
  valueType?: "PERCENTAGE" | "FIXED_AMOUNT";
  type?: "MANUAL" | "CODE_DISCOUNT" | "AUTOMATIC_DISCOUNT" | "code" | "percentage" | "fixed_amount";
}

export interface DeliveryAddress {
  firstName?: string;
  lastName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  provinceCode?: string;
  zip?: string;
}

export interface Contract {
  id: string;                  // shopify_contract_id (legacy)
  internal_id?: string;        // our UUID
  shopify_contract_id?: string;
  status: string;
  nextBillingDate?: string | null;
  billingPolicy?: { interval?: string; intervalCount?: number };
  billingInterval?: string;
  billingIntervalCount?: number;
  lines?: ContractLine[];
  appliedDiscounts?: AppliedDiscount[];
  appliedDiscount?: AppliedDiscount | null;
  shippingAddress?: Record<string, string> | null;
  deliveryMethod?: { address?: DeliveryAddress } | null;
  paymentMethod?: { brand?: string; last4?: string; expiry?: string } | null;
  paymentManageUrl?: string | null;
  is_internal?: boolean | null;
  shipping_protection_added?: boolean;
  shipping_protection_amount_cents?: number;
  tax?: { tax_cents: number; total_cents: number; quoted_at?: string | null } | null;
  portalState?: {
    bucket?: string;
    needsAttention?: boolean;
    recoveryStatus?: string | null;
    mutationsLocked?: boolean;
    mutationsLockReason?: string | null;
    deliveryState?: string | null;
  };
  crisisBanner?: { type?: string; message?: string } | null;
  pricing?: {
    msrp_cents: number;
    subtotal_cents: number;
    discount_cents: number;
    shipping_cents: number;
    protection_cents: number;
    total_cents: number;
    free_shipping: boolean;
    pills: Array<{ kind: string; label: string }>;
  } | null;
}

interface CatalogVariant {
  id: string;
  title?: string;
  inventory_quantity?: number | null;
  price_cents?: number;
  compare_at_price_cents?: number;
  price?: string;
  compare_at_price?: string;
  image?: { src?: string };
}

interface CatalogProduct {
  internalId?: string;
  productId?: string;
  title?: string;
  image?: { src?: string; alt?: string };
  rating?: { value?: number; count?: number };
  variants?: CatalogVariant[];
}

export type ActionApi = {
  startAction: () => void;
  completeAction: (description?: string) => void;
  failAction: (description?: string) => void;
};

/** One row of the last-5-orders widget. Fields cover both the render
 *  (order_number, created_at, total_cents) and the honest-status
 *  classifier keys ([[./order-status.ts]] OrderStatusInput). */
interface RecentOrder extends OrderStatusInput {
  id: string;
  order_number: string;
  total_cents: number;
}

interface Props {
  subscriptionId: string;
  workspace: { primaryColor: string };
}

// ─────────────────────────── main screen ────────────────────────────

export function SubscriptionDetailScreen({ subscriptionId, workspace }: Props) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [taxCents, setTaxCents] = useState<number | null>(null);
  const [shipProtVariantIds, setShipProtVariantIds] = useState<string[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPhase, setActionPhase] = useState<ActionPhase>("idle");
  const [actionDescription, setActionDescription] = useState<string | undefined>(undefined);
  // When true, the screen renders <CancelFlow/> instead of the detail
  // cards. Cancel runs inside the same portal shell so the customer
  // never leaves the page — escape-hatch is the "Never mind" button
  // which sets this back to false.
  const [cancelMode, setCancelMode] = useState(false);

  // Branded full-screen overlay — never a corner toast. See
  // feedback_portal_action_overlay memory.
  const action: ActionApi = {
    startAction: () => { setActionDescription(undefined); setActionPhase("loading"); },
    completeAction: (description) => { setActionDescription(description); setActionPhase("success"); },
    failAction: (description) => { setActionDescription(description); setActionPhase("error"); },
  };

  const loadContract = useCallback(async () => {
    // Load the full detail (resolved shipping address, pricing, coupons, payment
    // method, and the fresh tax quote) by UUID — the detail handler is the single
    // source, so the screen no longer pieces data together from the list.
    const res = await fetch(`/api/portal?route=subscriptionDetail&id=${encodeURIComponent(subscriptionId)}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error("Could not load subscription");
    const data = await res.json();
    const found = data.contract;
    if (!found) throw new Error("Subscription not found");
    setContract(found as Contract);
    // Tax is included in the detail response (re-quoted on each load via the
    // input-hash freshness check). No separate fetch.
    setTaxCents((found.tax?.tax_cents as number | undefined) ?? null);
    // Last-5-orders widget payload — the detail handler scopes these to
    // this subscription's orders and orders them newest-first.
    setRecentOrders(Array.isArray(data.recent_orders) ? (data.recent_orders as RecentOrder[]) : []);
  }, [subscriptionId]);

  const loadCatalog = useCallback(async () => {
    try {
      const r = await fetch("/api/portal?route=bootstrap", { credentials: "same-origin" });
      if (!r.ok) return;
      const data = await r.json();
      const cfg = (data?.config || {}) as { catalog?: CatalogProduct[]; shippingProtectionProductIds?: string[] };
      if (Array.isArray(cfg.catalog)) setCatalog(cfg.catalog);
      if (Array.isArray(cfg.shippingProtectionProductIds)) setShipProtVariantIds(cfg.shippingProtectionProductIds);
    } catch { /* non-fatal — items card just disables add/swap */ }
  }, []);

  useEffect(() => {
    (async () => {
      setError(null);
      try {
        await Promise.all([loadContract(), loadCatalog()]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, [loadContract, loadCatalog]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-32 animate-pulse rounded bg-zinc-100" />
        <div className="h-48 animate-pulse rounded-2xl bg-zinc-100" />
      </div>
    );
  }
  if (error || !contract) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6">
        <p className="text-sm font-semibold text-rose-800">Couldn&apos;t load this subscription</p>
        <p className="mt-1 text-xs text-rose-700">{error || "Unknown error"}</p>
        <a
          href="/subscriptions"
          onClick={(e) => { e.preventDefault(); window.location.href = "/subscriptions"; }}
          className="mt-3 inline-block text-sm font-semibold text-rose-700 underline"
        >
          ← Back to subscriptions
        </a>
      </div>
    );
  }

  const status = (contract.status || "").toLowerCase();
  const cadence = friendlyCadence(
    contract.billingPolicy?.interval || contract.billingInterval,
    contract.billingPolicy?.intervalCount || contract.billingIntervalCount,
  );
  const next = contract.nextBillingDate
    ? new Date(contract.nextBillingDate).toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
      })
    : null;
  // Shipping protection lives as a line item on the contract (the
  // warehouse charges $3.75 per shipment). We detect it by variant id
  // against the workspace's configured shipping-protection variants
  // so we can pull it out of the items card and surface it as its
  // own toggle below.
  const shipProtSet = new Set(shipProtVariantIds.map(String));
  const shipLine = (contract.lines || []).find((l) => shipProtSet.has(String(l.variantId || "")));
  const realLines = (contract.lines || []).filter(
    (l) => !l.is_gift && !shipProtSet.has(String(l.variantId || "")),
  );
  const subtotalCents = realLines.reduce((s, l) => {
    const price = parseFloat(l.currentPrice?.amount || "0");
    return s + Math.round(price * 100) * (l.quantity || 1);
  }, 0);
  const isCancelled = status === "cancelled";
  const productIdsForReviews = Array.from(new Set(
    realLines.map((l) => String(l.productId || "")).filter(Boolean),
  ));

  if (cancelMode) {
    return (
      <CancelFlow
        contract={contract}
        primaryColor={workspace.primaryColor}
        onAbort={() => setCancelMode(false)}
        onMutate={loadContract}
        action={action}
      />
    );
  }

  return (
    <div className="space-y-5">
      <a
        href="/subscriptions"
        onClick={(e) => { e.preventDefault(); window.location.href = "/subscriptions"; }}
        className="inline-flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-900"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        All subscriptions
      </a>

      {contract.crisisBanner?.message && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {contract.crisisBanner.message}
        </div>
      )}

      {contract.portalState?.needsAttention && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-sm font-semibold text-rose-800">Action needed</p>
          <p className="mt-1 text-xs text-rose-700">
            We weren&apos;t able to process your most recent payment. Update your card to keep this subscription active.
          </p>
        </div>
      )}

      {/* Pre-delivery gate — the subscription is READ-ONLY (Phase 2). Every
          mutating action is gated on the backend AND hidden from the UI here;
          the banner sets that expectation without the misleading
          "cancel/update payment anytime" language it used to carry. */}
      {contract.portalState?.mutationsLocked && (
        <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-sky-900">
            <span aria-hidden>🚚</span>
            {contract.portalState.deliveryState === "in_transit" ? "Your first order is on its way!" : "Your first order is being prepared"}
          </p>
          <p className="mt-1 text-xs text-sky-800">
            Your subscription is read-only until your first order is delivered. Once it arrives, you&apos;ll be able to fully manage it here — swap products, change quantities, adjust your schedule, and more.
          </p>
        </div>
      )}

      {/* Header */}
      <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <header className="flex flex-col gap-2 border-b border-zinc-100 p-5 sm:flex-row sm:items-baseline sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                {status === "paused" ? "Paused subscription" : isCancelled ? "Cancelled subscription" : "Next delivery"}
              </p>
              <StatusPill status={status} />
            </div>
            <p className="mt-0.5 text-lg font-semibold text-zinc-900">
              {status === "paused" ? "Resume anytime" : isCancelled ? "No upcoming charges" : next || "Date to be set"}
            </p>
          </div>
          <div className="text-left text-sm text-zinc-500 sm:text-right">
            <div>{cadence}</div>
            <div className="mt-0.5 font-medium text-zinc-700">
              ${(((contract.pricing?.total_cents ?? subtotalCents) + (taxCents ?? 0)) / 100).toFixed(2)} per delivery
            </div>
          </div>
        </header>
        {(contract.pricing?.pills?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5 px-5 pb-4 pt-4">
            {contract.pricing!.pills.map((pill, i) => (
              <span
                key={i}
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${detailPillClasses(pill.kind)}`}
              >
                {pill.label}
              </span>
            ))}
          </div>
        )}
      </article>

      {/* Lifecycle control — sits above the items so the primary state action
          (pause / resume / reactivate) is front-and-center. Hidden while the
          first-delivery gate holds (Phase 2 — pause/resume/reactivate are all
          gated on the backend; the button should not be offered). */}
      {status === "active" && !contract.portalState?.mutationsLocked && (
        <PauseCard contract={contract} primaryColor={workspace.primaryColor} onMutate={loadContract} action={action} />
      )}
      {status === "paused" && !contract.portalState?.mutationsLocked && (
        <ResumeCard contract={contract} primaryColor={workspace.primaryColor} onMutate={loadContract} action={action} />
      )}
      {isCancelled && !contract.portalState?.mutationsLocked && (
        <ReactivateCard contract={contract} primaryColor={workspace.primaryColor} onMutate={loadContract} action={action} />
      )}

      {/* Items + per-line actions — shipping protection has its own
          dedicated toggle card below, so hide it from the items list. When the
          first-delivery gate is on, items show read-only (no swap/qty/add/remove). */}
      <ItemsActionsCard
        contract={contract}
        catalog={catalog}
        isCancelled={isCancelled}
        primaryColor={workspace.primaryColor}
        onMutate={loadContract}
        action={action}
        excludeVariantIds={shipProtVariantIds}
        locked={!!contract.portalState?.mutationsLocked}
      />

      {/* Order summary — full breakdown of what they'll be charged. */}
      {!isCancelled && <OrderSummaryCard pricing={contract.pricing} taxCents={taxCents} showTax={!!contract.is_internal} />}

      {/* Recent orders — last 5 orders on THIS sub, newest first.
          ALWAYS shown (read-only display), including during the
          first-delivery window: the customer needs to see the box
          they're about to receive even when the sub is gated. */}
      <RecentOrdersCard orders={recentOrders} />


      {/* Manage cadence — order now / change date / frequency (active only).
          Hidden until the first order is delivered (schedule mutations gated).
          Pause/Resume/Reactivate render above the items + stay available. */}
      {status === "active" && !contract.portalState?.mutationsLocked && (
        <>
          <OrderActionsCard contract={contract} primaryColor={workspace.primaryColor} onMutate={loadContract} action={action} />
          <FrequencyCard contract={contract} primaryColor={workspace.primaryColor} onMutate={loadContract} action={action} />
        </>
      )}

      {/* Account-level cards — only on live subs */}
      {!isCancelled && (
        <>
          {shipProtVariantIds.length > 0 && !contract.portalState?.mutationsLocked && (
            <ShippingProtectionCard
              contract={contract}
              shipLine={shipLine}
              variantIds={shipProtVariantIds}
              onMutate={loadContract}
              action={action}
            />
          )}
          {!contract.portalState?.mutationsLocked && (
            <AddressCard contract={contract} primaryColor={workspace.primaryColor} onMutate={loadContract} action={action} />
          )}
          {!contract.portalState?.mutationsLocked && (
            <CouponCard contract={contract} primaryColor={workspace.primaryColor} onMutate={loadContract} action={action} />
          )}
          {!contract.portalState?.mutationsLocked && (
            <PaymentMethodCard contract={contract} primaryColor={workspace.primaryColor} onMutate={loadContract} action={action} />
          )}
          <RewardsCard contract={contract} primaryColor={workspace.primaryColor} action={action} />
          {productIdsForReviews.length > 0 && <ReviewsCard productIds={productIdsForReviews} />}
          {!contract.portalState?.mutationsLocked && (
            <CancelCard onStart={() => setCancelMode(true)} />
          )}
        </>
      )}

      <ActionOverlay
        phase={actionPhase}
        description={actionDescription}
        onClose={() => setActionPhase("idle")}
      />
    </div>
  );
}

// ──────────────────────────── items card ────────────────────────────

function ItemsActionsCard({
  contract, catalog, isCancelled, primaryColor, onMutate, action, excludeVariantIds, locked,
}: {
  contract: Contract;
  catalog: CatalogProduct[];
  isCancelled: boolean;
  primaryColor: string;
  onMutate: () => Promise<void>;
  action: ActionApi;
  excludeVariantIds?: string[];
  /** First-delivery gate — show items read-only (no swap/qty/add/remove). */
  locked?: boolean;
}) {
  const [modal, setModal] = useState<
    | { type: "addSwap"; mode: "add" | "swap"; line?: ContractLine }
    | { type: "quantity"; line: ContractLine }
    | null
  >(null);
  const excluded = new Set((excludeVariantIds || []).map(String));
  const lines = (contract.lines || []).filter(
    (l) => !l.is_gift && !excluded.has(String(l.variantId || "")),
  );
  const canRemove = !locked && lines.length > 1;
  const readonly = isCancelled || !!locked;

  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      <header className="border-b border-zinc-100 p-5">
        <h3 className="text-base font-semibold text-zinc-900">Items</h3>
        <p className="mt-0.5 text-sm text-zinc-500">What&apos;s included in your subscription.</p>
      </header>

      <ul className="divide-y divide-zinc-100">
        {lines.map((ln) => (
          <li key={ln.id} className="p-4 sm:p-5">
            {readonly ? (
              <LineRow ln={ln} />
            ) : (
              <LineDisclosure
                ln={ln}
                catalog={catalog}
                canRemove={canRemove}
                contract={contract}
                primaryColor={primaryColor}
                onSwap={() => setModal({ type: "addSwap", mode: "swap", line: ln })}
                onQty={() => setModal({ type: "quantity", line: ln })}
                onMutate={onMutate}
                action={action}
              />
            )}
          </li>
        ))}
      </ul>

      {!readonly && catalog.length > 0 && (
        <div className="border-t border-zinc-100 bg-zinc-50 p-4">
          <button
            type="button"
            onClick={() => setModal({ type: "addSwap", mode: "add" })}
            className="w-full rounded-lg border border-dashed border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 hover:border-zinc-400 hover:text-zinc-900"
          >
            + Add item
          </button>
        </div>
      )}

      {modal?.type === "addSwap" && (
        <AddSwapModal
          contract={contract}
          catalog={catalog}
          mode={modal.mode}
          line={modal.line}
          primaryColor={primaryColor}
          onClose={() => setModal(null)}
          onDone={async () => { setModal(null); await onMutate(); }}
          action={action}
        />
      )}
      {modal?.type === "quantity" && (
        <QuantityModal
          contract={contract}
          line={modal.line}
          primaryColor={primaryColor}
          onClose={() => setModal(null)}
          onDone={async () => { setModal(null); await onMutate(); }}
          action={action}
        />
      )}
    </article>
  );
}

// ─────────────────────────── line components ────────────────────────

function SummaryRow({ label, children, bold }: { label: React.ReactNode; children: React.ReactNode; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${bold ? "text-base font-semibold text-zinc-900" : "text-zinc-700"}`}>
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

/** Order summary — MSRP strikethrough → subtotal (+ rule discount %), coupon,
 *  shipping, protection, estimated tax, and the all-in per-delivery total. */
function OrderSummaryCard({ pricing, taxCents, showTax }: {
  pricing?: Contract["pricing"]; taxCents: number | null; showTax: boolean;
}) {
  if (!pricing) return null;
  const { msrp_cents, subtotal_cents, discount_cents, shipping_cents, protection_cents, free_shipping } = pricing;
  const rulePct = msrp_cents > subtotal_cents && msrp_cents > 0 ? Math.round((1 - subtotal_cents / msrp_cents) * 100) : 0;
  const total = Math.max(0, subtotal_cents - discount_cents) + shipping_cents + protection_cents + (showTax ? (taxCents ?? 0) : 0);

  return (
    <ActionCard title="Order summary" subtitle="What you'll be charged each delivery.">
      <div className="space-y-2 text-sm">
        <SummaryRow label="Subtotal">
          <span className="flex items-center gap-2">
            {msrp_cents > subtotal_cents && (
              <span className="text-zinc-400 line-through">${(msrp_cents / 100).toFixed(2)}</span>
            )}
            <span className="font-medium text-zinc-900">${(subtotal_cents / 100).toFixed(2)}</span>
            {rulePct > 0 && (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">{rulePct}% off</span>
            )}
          </span>
        </SummaryRow>
        {discount_cents > 0 && (
          <SummaryRow label={<span className="text-emerald-700">Coupon</span>}>
            <span className="text-emerald-700">−${(discount_cents / 100).toFixed(2)}</span>
          </SummaryRow>
        )}
        <SummaryRow label="Shipping">
          {free_shipping ? <span className="font-medium text-emerald-700">Free</span> : `$${(shipping_cents / 100).toFixed(2)}`}
        </SummaryRow>
        {protection_cents > 0 && (
          <SummaryRow label="Shipping protection">${(protection_cents / 100).toFixed(2)}</SummaryRow>
        )}
        {showTax && (
          <SummaryRow label="Estimated tax">
            {taxCents == null ? <span className="text-zinc-400">Calculating…</span> : `$${(taxCents / 100).toFixed(2)}`}
          </SummaryRow>
        )}
        <div className="my-1 border-t border-zinc-100" />
        <SummaryRow label="Total per delivery" bold>${(total / 100).toFixed(2)}</SummaryRow>
      </div>
    </ActionCard>
  );
}

/** Tone → Tailwind classes for the honest status badge. Kept local so the
 *  order-status classifier stays free of styling concerns. */
const RECENT_TONE_CLASS: Record<OrderStatusTag["tone"], string> = {
  emerald: "bg-emerald-50 text-emerald-700",
  sky: "bg-sky-50 text-sky-700",
  amber: "bg-amber-50 text-amber-800",
  zinc: "bg-zinc-100 text-zinc-600",
};

/** Last-5-orders widget — read-only. Renders order number, placed date,
 *  the honest three-state delivery tag + optional financial tag, and
 *  amount. Each row links into the Phase 1 order detail page
 *  (`/orders/{uuid}`, rewritten by middleware to /portal/{slug}/orders/{uuid}). */
function RecentOrdersCard({ orders }: { orders: RecentOrder[] }) {
  return (
    <ActionCard title="Recent orders" subtitle="The last 5 orders on this subscription.">
      {orders.length === 0 ? (
        <p className="text-sm text-zinc-500">No orders yet for this subscription.</p>
      ) : (
        <ul className="-mx-5 divide-y divide-zinc-100 border-t border-zinc-100">
          {orders.map((o) => {
            const delivery = deliveryStatusTag(o, Date.now());
            const financial = financialTag(o);
            const placed = new Date(o.created_at).toLocaleDateString("en-US", {
              month: "long", day: "numeric", year: "numeric",
            });
            return (
              <li key={o.id}>
                <a
                  href={`/orders/${o.id}`}
                  onClick={(e) => { e.preventDefault(); window.location.href = `/orders/${o.id}`; }}
                  className="flex items-center gap-4 px-5 py-3 text-left transition hover:bg-zinc-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-semibold text-zinc-900">{o.order_number}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${RECENT_TONE_CLASS[delivery.tone]}`}>
                        {delivery.label}
                      </span>
                      {financial && (
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${RECENT_TONE_CLASS[financial.tone]}`}>
                          {financial.label}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500">{placed}</p>
                  </div>
                  <div className="text-sm font-medium text-zinc-900">${(o.total_cents / 100).toFixed(2)}</div>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </ActionCard>
  );
}

/** Discount-pill color by kind — matches the subscriptions list. */
function detailPillClasses(kind: string): string {
  if (kind === "free_shipping") return "bg-sky-50 text-sky-700";
  if (kind === "coupon") return "bg-amber-50 text-amber-700";
  return "bg-emerald-50 text-emerald-700"; // sns + quantity_break
}

/** Price cell — shows the charged total, with the full (pre-discount) price
 *  struck through above it when a quantity break / S&S discount applies. */
function LinePrice({ ln, priceCents }: { ln: ContractLine; priceCents: number }) {
  const baseUnit = parseFloat(ln.basePrice?.amount || "0");
  const chargedUnit = parseFloat(ln.currentPrice?.amount || "0");
  const showStrike = baseUnit > chargedUnit && baseUnit > 0;
  const baseTotal = baseUnit * (ln.quantity || 1);
  return (
    <div className="text-right">
      {showStrike && (
        <div className="text-xs text-zinc-400 line-through">${baseTotal.toFixed(2)}</div>
      )}
      <div className="text-sm font-medium text-zinc-900">${(priceCents / 100).toFixed(2)}</div>
    </div>
  );
}

function LineRow({ ln }: { ln: ContractLine }) {
  const priceCents = Math.round(parseFloat(ln.currentPrice?.amount || "0") * 100) * (ln.quantity || 1);
  const img = ln.variantImage?.transformedSrc;
  return (
    <div className="flex items-center gap-4">
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img} alt={ln.title || "Item"} className="h-14 w-14 flex-shrink-0 rounded-lg object-cover" />
      ) : (
        <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-zinc-100" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-900">
          {ln.title || "Item"}
          {ln.variantTitle && ln.variantTitle !== "Default Title" && (
            <span className="text-zinc-500"> — {ln.variantTitle}</span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">Qty {ln.quantity || 1}</div>
      </div>
      <LinePrice ln={ln} priceCents={priceCents} />
    </div>
  );
}

function LineDisclosure({
  ln, catalog, canRemove, contract, primaryColor, onSwap, onQty, onMutate, action,
}: {
  ln: ContractLine;
  catalog: CatalogProduct[];
  canRemove: boolean;
  contract: Contract;
  primaryColor: string;
  onSwap: () => void;
  onQty: () => void;
  onMutate: () => Promise<void>;
  action: ActionApi;
}) {
  const [open, setOpen] = useState(false);
  const [flavorOpen, setFlavorOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Find the matching catalog product. ln.productId may be either our
  // internal UUID or a Shopify product id — match either.
  const lnPid = String(ln.productId || "");
  const currentProduct = catalog.find(
    (p) => String(p.productId || "") === lnPid || String(p.internalId || "") === lnPid,
  );
  const flavorVariants = (currentProduct?.variants || []).filter(
    (v) =>
      String(v.id) !== String(ln.variantId) &&
      (v.inventory_quantity == null || (v.inventory_quantity || 0) > 0),
  );
  const hasFlavorOptions = flavorVariants.length > 0;

  async function callMutation(
    route: string,
    payload: Record<string, unknown>,
    okMsg: string,
    busyKey: string,
  ) {
    if (busy) return;
    setBusy(busyKey);
    action.startAction();
    try {
      const res = await fetch(`/api/portal?route=${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
        return;
      }
      action.completeAction(okMsg);
      setOpen(false); setFlavorOpen(false);
      await onMutate();
    } catch {
      action.failAction();
    } finally {
      setBusy(null);
    }
  }

  const priceCents = Math.round(parseFloat(ln.currentPrice?.amount || "0") * 100) * (ln.quantity || 1);
  const img = ln.variantImage?.transformedSrc;

  return (
    <div>
      <div className="flex items-center gap-4">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt={ln.title || "Item"} className="h-14 w-14 flex-shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-zinc-100" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-900">
            {ln.title || "Item"}
            {ln.variantTitle && ln.variantTitle !== "Default Title" && (
              <span className="text-zinc-500"> — {ln.variantTitle}</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500">Qty {ln.quantity || 1}</div>
        </div>
        <LinePrice ln={ln} priceCents={priceCents} />
      </div>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-3 flex w-full items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50"
      >
        <span>{open ? "Hide" : "Make changes to this item"}</span>
        <svg className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-3 space-y-2 rounded-lg bg-zinc-50 p-3">
          {hasFlavorOptions && (
            <div>
              <DisclosureAction
                title="Change flavor"
                sub="Switch to another flavor of this product."
                disabled={busy === "flavor"}
                onClick={() => setFlavorOpen(!flavorOpen)}
              />
              {flavorOpen && (
                <div className="mt-2 grid grid-cols-2 gap-2 px-1 pb-1">
                  {flavorVariants.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      disabled={!!busy}
                      onClick={() =>
                        callMutation(
                          "replaceVariants",
                          {
                            contractId: contract.id,
                            oldLineId: ln.id,
                            newVariants: [{ variantId: String(v.id), quantity: ln.quantity || 1 }],
                            carryForwardDiscount: "EXISTING_PLAN",
                          },
                          `Switched to ${v.title}`,
                          "flavor",
                        )
                      }
                      className="rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-xs font-medium text-zinc-700 hover:border-zinc-300"
                      style={busy === "flavor" ? { opacity: 0.5 } : undefined}
                    >
                      {v.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <DisclosureAction
            title="Swap product"
            sub="Replace with a different product."
            onClick={onSwap}
          />
          <DisclosureAction
            title="Change quantity"
            sub="Update how many you receive."
            onClick={onQty}
          />
          {canRemove && (
            <DisclosureAction
              title={busy === "remove" ? "Removing…" : "Remove"}
              sub="Remove this item from your subscription."
              danger
              disabled={!!busy}
              onClick={() =>
                callMutation(
                  "removeLineItem",
                  { contractId: contract.id, lineId: ln.id, variantId: ln.variantId },
                  "Item removed",
                  "remove",
                )
              }
            />
          )}
        </div>
      )}
      <input type="hidden" value={primaryColor} />
    </div>
  );
}

function DisclosureAction({
  title, sub, danger, disabled, onClick,
}: {
  title: string;
  sub: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`block w-full rounded-md border border-zinc-200 bg-white p-3 text-left transition hover:border-zinc-300 disabled:opacity-50 ${danger ? "hover:border-rose-300" : ""}`}
    >
      <div className={`text-sm font-semibold ${danger ? "text-rose-700" : "text-zinc-900"}`}>{title}</div>
      <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>
    </button>
  );
}

// ─────────────────────────────── modals ─────────────────────────────

function ModalShell({
  title, onClose, children, footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-zinc-100 p-4">
          <h3 className="text-base font-semibold text-zinc-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer && (
          <footer className="flex flex-wrap gap-2 border-t border-zinc-100 bg-zinc-50 p-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

function variantImage(v?: CatalogVariant): string | null {
  const src = v?.image?.src;
  if (!src) return null;
  return src.includes("?") ? `${src}&width=800` : `${src}?width=800`;
}

function productImage(p?: CatalogProduct): string | null {
  const src = p?.image?.src;
  if (!src) return null;
  return src.includes("?") ? `${src}&width=800` : `${src}?width=800`;
}

function priceCentsFor(v?: CatalogVariant): { msrpCents: number | null; payCents: number | null } {
  if (!v) return { msrpCents: null, payCents: null };
  // Catalog passes prices as numeric *_cents or as dollar strings.
  const toCents = (raw: unknown): number | null => {
    if (raw == null) return null;
    const n = Number(raw);
    if (!isFinite(n)) return null;
    if (String(raw).includes(".") || n < 1000) return Math.round(n * 100);
    return Math.trunc(n);
  };
  const msrpCents = toCents(v.compare_at_price_cents) ?? toCents(v.compare_at_price)
    ?? toCents(v.price_cents) ?? toCents(v.price);
  if (msrpCents == null) return { msrpCents: null, payCents: null };
  const payCents = Math.round(msrpCents * 0.75);
  return { msrpCents, payCents };
}

function AddSwapModal({
  contract, catalog, mode, line, primaryColor, onClose, onDone, action,
}: {
  contract: Contract;
  catalog: CatalogProduct[];
  mode: "add" | "swap";
  line?: ContractLine;
  primaryColor: string;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  action: ActionApi;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [variant, setVariant] = useState<CatalogVariant | null>(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<{ base_cents: number | null; unit_cents: number | null } | null>(null);

  const isSwap = mode === "swap";

  // Internal subs: price the previewed line through the engine so the quantity
  // break (mix-and-match across the projected total) + S&S match what will
  // actually be charged. Appstle subs fall back to the client estimate below.
  const swapLineVariantId = isSwap ? line?.variantId : undefined;
  useEffect(() => {
    if (!contract.is_internal || !variant) { setQuote(null); return; }
    let alive = true;
    fetch("/api/portal?route=priceQuote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ contractId: contract.id, variantId: String(variant.id), quantity: qty, replaceVariantId: swapLineVariantId }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.ok && d?.internal) setQuote({ base_cents: d.base_cents ?? null, unit_cents: d.unit_cents ?? null }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [contract.is_internal, contract.id, variant?.id, qty, swapLineVariantId]); // eslint-disable-line react-hooks/exhaustive-deps
  const linePid = String(line?.productId || "");
  const products = catalog
    .filter((p) =>
      !(isSwap && line && (String(p.productId || "") === linePid || String(p.internalId || "") === linePid)),
    )
    .filter((p) => (p.variants || []).some((v) => v.inventory_quantity == null || (v.inventory_quantity || 0) > 0));

  async function submit() {
    if (!variant || busy) return;
    setBusy(true);
    onClose();
    action.startAction();
    try {
      const payload: Record<string, unknown> = {
        contractId: contract.id,
        newVariants: [{ variantId: String(variant.id), quantity: qty }],
      };
      if (isSwap && line) {
        payload.oldLineId = line.id;
      }
      const res = await fetch("/api/portal?route=replaceVariants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
        setBusy(false);
        return;
      }
      action.completeAction(isSwap ? "Item swapped" : "Item added");
      await onDone();
    } catch {
      action.failAction();
      setBusy(false);
    }
  }

  // Step 1: pick a product
  if (step === 1) {
    return (
      <ModalShell title={isSwap ? "Swap item" : "Add item"} onClose={onClose}>
        <p className="mb-3 text-sm text-zinc-600">
          {isSwap ? "Pick a different product, then choose your flavor." : "Pick a product, then choose your flavor and quantity."}
        </p>
        <ul className="space-y-2">
          {products.map((p) => {
            const img = productImage(p);
            return (
              <li key={p.productId || p.internalId}>
                <button
                  type="button"
                  onClick={() => {
                    setProduct(p);
                    setVariant((p.variants || []).find((v) => v.inventory_quantity == null || (v.inventory_quantity || 0) > 0) || null);
                    setStep(2);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 bg-white p-3 text-left hover:border-zinc-300"
                >
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt={p.title} className="h-12 w-12 flex-shrink-0 rounded object-cover" />
                  ) : (
                    <div className="h-12 w-12 flex-shrink-0 rounded bg-zinc-100" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-zinc-900">{p.title}</div>
                    {p.rating?.value ? (
                      <div className="mt-0.5 text-xs text-amber-600">
                        ★ {p.rating.value.toFixed(2)}{" "}
                        <span className="text-zinc-500">({p.rating.count})</span>
                      </div>
                    ) : null}
                  </div>
                  <span className="text-xs font-semibold text-zinc-500">Select →</span>
                </button>
              </li>
            );
          })}
          {products.length === 0 && (
            <li className="rounded-lg bg-zinc-50 p-4 text-center text-sm text-zinc-500">
              No products available right now.
            </li>
          )}
        </ul>
      </ModalShell>
    );
  }

  // Step 2: variant + qty
  const variants = (product?.variants || []).filter((v) => v.inventory_quantity == null || (v.inventory_quantity || 0) > 0);
  // Internal subs: the engine quote drives the price (rule S&S + mix-and-match
  // break). Appstle subs (and while the quote loads) use the client estimate.
  const clientPrice = priceCentsFor(variant || undefined);
  const msrpCents = quote?.base_cents ?? clientPrice.msrpCents;
  const payCents = quote?.unit_cents ?? clientPrice.payCents;
  const totalMsrp = (msrpCents || 0) * qty;
  const totalPay = (payCents || 0) * qty;
  const discountPct = msrpCents && payCents != null && msrpCents > payCents
    ? Math.round((1 - payCents / msrpCents) * 100)
    : 0;
  const varImg = variantImage(variant || undefined) || productImage(product || undefined);

  return (
    <ModalShell
      title={isSwap ? "Swap item" : "Add item"}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            disabled={busy || !variant}
            onClick={submit}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: primaryColor }}
          >
            {busy ? "Saving…" : isSwap ? "Swap" : "Add to subscription"}
          </button>
          <button
            type="button"
            onClick={() => setStep(1)}
            disabled={busy}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:border-zinc-400 disabled:opacity-50"
          >
            Back
          </button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-3">
        {varImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={varImg} alt={product?.title || ""} className="h-14 w-14 flex-shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-zinc-100" />
        )}
        <div>
          <div className="text-sm font-semibold text-zinc-900">{product?.title}</div>
          {variant?.title && variant.title !== "Default Title" && (
            <div className="mt-0.5 text-xs text-zinc-500">{variant.title}</div>
          )}
        </div>
      </div>

      {variants.length > 1 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Flavor</div>
          <div className="flex flex-wrap gap-2">
            {variants.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setVariant(v)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                  variant?.id === v.id
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400"
                }`}
              >
                {v.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Quantity</div>
        <select
          value={qty}
          onChange={(e) => setQty(Number(e.target.value) || 1)}
          className="w-24 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900"
        >
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </div>

      {payCents != null && (
        <div className="rounded-lg bg-zinc-50 p-3">
          <div className="text-xs text-zinc-500">Price</div>
          <div className="mt-1 flex items-baseline gap-2">
            {msrpCents != null && totalMsrp > totalPay && (
              <span className="text-sm text-zinc-400 line-through">${(totalMsrp / 100).toFixed(2)}</span>
            )}
            <span className="text-lg font-bold text-zinc-900">${(totalPay / 100).toFixed(2)}</span>
            {discountPct > 0 && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                {discountPct}% off
              </span>
            )}
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function QuantityModal({
  contract, line, primaryColor, onClose, onDone, action,
}: {
  contract: Contract;
  line: ContractLine;
  primaryColor: string;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  action: ActionApi;
}) {
  const initial = line.quantity || 1;
  const [qty, setQty] = useState(initial);
  const [busy, setBusy] = useState(false);
  const img = line.variantImage?.transformedSrc || null;

  async function save() {
    if (qty === initial) { onClose(); return; }
    setBusy(true);
    onClose();
    action.startAction();
    try {
      const res = await fetch("/api/portal?route=replaceVariants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          contractId: contract.id,
          oldLineId: line.id,
          newVariants: [{ variantId: line.variantId, quantity: qty }],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
        setBusy(false);
        return;
      }
      action.completeAction("Quantity updated");
      await onDone();
    } catch {
      action.failAction();
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="Change quantity"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: primaryColor }}
          >
            {busy ? "Saving…" : "Submit"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:border-zinc-400 disabled:opacity-50"
          >
            Cancel
          </button>
        </>
      }
    >
      <div className="mb-4 flex items-center gap-3">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt={line.title || ""} className="h-14 w-14 flex-shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-zinc-100" />
        )}
        <div>
          <div className="text-sm font-semibold text-zinc-900">{line.title || "Item"}</div>
          {line.variantTitle && line.variantTitle !== "Default Title" && (
            <div className="mt-0.5 text-xs text-zinc-500">{line.variantTitle}</div>
          )}
        </div>
      </div>
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Quantity</div>
        <select
          value={qty}
          onChange={(e) => setQty(Number(e.target.value) || 1)}
          className="w-28 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900"
        >
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </div>
    </ModalShell>
  );
}

// ────────────────────── status-action cards (chunk 3) ──────────────────────

function ActionCard({
  title, subtitle, children,
}: {
  title: string;
  subtitle?: string | null;
  children: React.ReactNode;
}) {
  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      <header className="border-b border-zinc-100 p-5">
        <h3 className="text-base font-semibold text-zinc-900">{title}</h3>
        {subtitle && <p className="mt-0.5 text-sm text-zinc-500">{subtitle}</p>}
      </header>
      <div className="space-y-2 p-5">{children}</div>
    </article>
  );
}

function PrimaryButton({
  busy, disabled, onClick, children, primaryColor,
}: {
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  primaryColor: string;
}) {
  return (
    <button
      type="button"
      disabled={busy || disabled}
      onClick={onClick}
      className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
      style={{ background: primaryColor }}
    >
      {busy ? "Working…" : children}
    </button>
  );
}

function GhostButton({
  busy, disabled, onClick, children, danger,
}: {
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={busy || disabled}
      onClick={onClick}
      className={`w-full rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold transition hover:border-zinc-400 disabled:opacity-50 ${
        danger ? "text-rose-700 hover:text-rose-800" : "text-zinc-700 hover:text-zinc-900"
      }`}
    >
      {busy ? "Working…" : children}
    </button>
  );
}

// useMutator — shared "call /api/portal?route=X, drive the overlay,
// refresh the contract" hook so each card stays short.
function useMutator(action: ActionApi, onMutate: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  async function run(
    route: string,
    payload: Record<string, unknown>,
    success: string,
    onSuccess?: () => void,
  ) {
    if (busy) return;
    setBusy(true);
    action.startAction();
    try {
      const res = await fetch(`/api/portal?route=${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
        return;
      }
      action.completeAction(success);
      onSuccess?.();
      await onMutate();
    } catch {
      action.failAction();
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

function PauseCard({ contract, primaryColor, onMutate, action }: {
  contract: Contract; primaryColor: string; onMutate: () => Promise<void>; action: ActionApi;
}) {
  const { busy, run } = useMutator(action, onMutate);
  function doPause(days: number) {
    const resumeDate = new Date();
    resumeDate.setDate(resumeDate.getDate() + days);
    const label = resumeDate.toLocaleDateString("en-US", { month: "long", day: "numeric" });
    run("pause", { contractId: contract.id, pauseDays: days }, `Subscription paused until ${label}`);
  }
  return (
    <ActionCard title="Pause subscription" subtitle="Take a break without losing your subscriber perks.">
      {/* Stack on mobile, sit side-by-side (50/50) on desktop. */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="sm:flex-1">
          <PrimaryButton busy={busy} onClick={() => doPause(30)} primaryColor={primaryColor}>Pause 30 days</PrimaryButton>
        </div>
        <div className="sm:flex-1">
          <GhostButton busy={busy} onClick={() => doPause(60)}>Pause 60 days</GhostButton>
        </div>
      </div>
    </ActionCard>
  );
}

function ResumeCard({ contract, primaryColor, onMutate, action }: {
  contract: Contract; primaryColor: string; onMutate: () => Promise<void>; action: ActionApi;
}) {
  const { busy, run } = useMutator(action, onMutate);
  return (
    <ActionCard title="Resume subscription" subtitle="Restart your deliveries when you're ready.">
      <PrimaryButton
        busy={busy}
        primaryColor={primaryColor}
        onClick={() => run("resume", { contractId: contract.id }, "Subscription resumed!")}
      >
        Resume subscription
      </PrimaryButton>
    </ActionCard>
  );
}

function ReactivateCard({ contract, primaryColor, onMutate, action }: {
  contract: Contract; primaryColor: string; onMutate: () => Promise<void>; action: ActionApi;
}) {
  const [modal, setModal] = useState(false);
  const [date, setDate] = useState("");
  const { busy, run } = useMutator(action, onMutate);
  const { minStr, maxStr } = dateBounds();
  return (
    <ActionCard title="Reactivate subscription" subtitle="Pick up where you left off.">
      <PrimaryButton busy={false} onClick={() => { setDate(""); setModal(true); }} primaryColor={primaryColor}>
        Reactivate
      </PrimaryButton>
      {modal && (
        <ModalShell
          title="Reactivate subscription"
          onClose={() => setModal(false)}
          footer={
            <>
              <button
                type="button"
                disabled={busy || !date}
                onClick={() => {
                  setModal(false);
                  run("reactivate", { contractId: contract.id, nextBillingDate: date }, "Subscription reactivated!");
                }}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: primaryColor }}
              >
                {busy ? "Reactivating…" : "Reactivate"}
              </button>
              <button
                type="button"
                onClick={() => setModal(false)}
                disabled={busy}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          }
        >
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Choose your next order date
          </label>
          <input
            type="date"
            min={minStr}
            max={maxStr}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
          />
        </ModalShell>
      )}
    </ActionCard>
  );
}

function OrderActionsCard({ contract, primaryColor, onMutate, action }: {
  contract: Contract; primaryColor: string; onMutate: () => Promise<void>; action: ActionApi;
}) {
  const [dateModal, setDateModal] = useState(false);
  const [confirmNow, setConfirmNow] = useState(false);
  const [date, setDate] = useState("");
  const { busy, run } = useMutator(action, onMutate);
  const { minStr, maxStr } = dateBounds();

  return (
    <ActionCard title="Order actions" subtitle="Manage your next shipment.">
      {/* Stack on mobile, sit side-by-side (50/50) on desktop. */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="sm:flex-1">
          <PrimaryButton busy={busy} onClick={() => setConfirmNow(true)} primaryColor={primaryColor}>
            Order now
          </PrimaryButton>
        </div>
        <div className="sm:flex-1">
          <GhostButton busy={busy} onClick={() => { setDate(""); setDateModal(true); }}>
            Change next order date
          </GhostButton>
        </div>
      </div>

      {confirmNow && (
        <ModalShell
          title="Order now"
          onClose={() => setConfirmNow(false)}
          footer={
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmNow(false);
                  run("orderNow", { contractId: contract.id }, "Order placed! Check your email for confirmation.");
                }}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: primaryColor }}
              >
                {busy ? "Placing…" : "Order now"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmNow(false)}
                disabled={busy}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          }
        >
          <p className="text-sm text-zinc-700">
            This will process your next subscription order immediately. Your card on file will be charged.
          </p>
        </ModalShell>
      )}

      {dateModal && (
        <ModalShell
          title="Change next order date"
          onClose={() => setDateModal(false)}
          footer={
            <>
              <button
                type="button"
                disabled={busy || !date}
                onClick={() => {
                  if (date < minStr || date > maxStr) {
                    action.failAction("Pick a date within the next 90 days.");
                    return;
                  }
                  setDateModal(false);
                  const pretty = new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
                  run("changeDate", { contractId: contract.id, nextBillingDate: date }, `Next order date changed to ${pretty}`);
                }}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: primaryColor }}
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setDateModal(false)}
                disabled={busy}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          }
        >
          <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Next order date
          </label>
          <input
            type="date"
            min={minStr}
            max={maxStr}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
          />
        </ModalShell>
      )}
    </ActionCard>
  );
}

function FrequencyCard({ contract, primaryColor, onMutate, action }: {
  contract: Contract; primaryColor: string; onMutate: () => Promise<void>; action: ActionApi;
}) {
  const [modal, setModal] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { busy, run } = useMutator(action, onMutate);

  // Three default cadences in week units — match the Shopify-extension
  // portal so the customer sees the same option set across surfaces.
  const options = [
    { label: "Twice a Month", interval: "WEEK", count: 2 },
    { label: "Monthly", interval: "WEEK", count: 4 },
    { label: "Every 2 Months", interval: "WEEK", count: 8 },
  ];
  const currentInterval = (contract.billingPolicy?.interval || contract.billingInterval || "").toUpperCase();
  const currentCount = Number(contract.billingPolicy?.intervalCount || contract.billingIntervalCount || 0);
  const isCurrent = (o: typeof options[number]) => o.interval === currentInterval && o.count === currentCount;
  const currentLabel = options.find(isCurrent)?.label
    || friendlyCadence(
      contract.billingPolicy?.interval || contract.billingInterval,
      contract.billingPolicy?.intervalCount || contract.billingIntervalCount,
    );

  function save() {
    const opt = options.find((o) => o.label === selected);
    if (!opt) return;
    setModal(false);
    run("frequency", { contractId: contract.id, intervalCount: opt.count, interval: opt.interval }, `Delivery frequency changed to ${opt.label}`);
  }

  return (
    <ActionCard title="Delivery frequency" subtitle={currentLabel}>
      <GhostButton busy={busy} onClick={() => { setSelected(null); setModal(true); }}>
        Change frequency
      </GhostButton>
      {modal && (
        <ModalShell
          title="Change delivery frequency"
          onClose={() => setModal(false)}
          footer={
            <>
              <button
                type="button"
                disabled={busy || !selected}
                onClick={save}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: primaryColor }}
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setModal(false)}
                disabled={busy}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          }
        >
          <ul className="space-y-2">
            {options.map((o) => {
              const current = isCurrent(o);
              return (
                <li key={o.label}>
                  <label
                    className={`flex items-center gap-3 rounded-lg border p-3 ${
                      current
                        ? "border-zinc-200 bg-zinc-50 opacity-60"
                        : selected === o.label
                          ? "border-zinc-900 bg-zinc-50"
                          : "border-zinc-200 bg-white hover:border-zinc-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="freq"
                      value={o.label}
                      disabled={current}
                      checked={selected === o.label}
                      onChange={() => setSelected(o.label)}
                      className="h-4 w-4"
                    />
                    <span className="flex-1 text-sm font-medium text-zinc-900">{o.label}</span>
                    {current && (
                      <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-700">
                        Current
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        </ModalShell>
      )}
    </ActionCard>
  );
}

// ─────────────────────────── chunk 4 cards ──────────────────────────

const US_STATES: Array<[string, string]> = [
  ["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],
  ["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["FL","Florida"],["GA","Georgia"],
  ["HI","Hawaii"],["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],
  ["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],["ME","Maine"],["MD","Maryland"],
  ["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],["MS","Mississippi"],["MO","Missouri"],
  ["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],["NH","New Hampshire"],["NJ","New Jersey"],
  ["NM","New Mexico"],["NY","New York"],["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],
  ["OK","Oklahoma"],["OR","Oregon"],["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],
  ["SD","South Dakota"],["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],
  ["VA","Virginia"],["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"],
  ["DC","District of Columbia"],
  // US territories
  ["PR","Puerto Rico"],["VI","U.S. Virgin Islands"],["GU","Guam"],
  ["AS","American Samoa"],["MP","Northern Mariana Islands"],
];

interface VerificationResult {
  valid?: boolean;
  errors?: string[];
  suggested?: { address1?: string; address2?: string; city?: string; province?: string; zip?: string };
  entered?: { address1?: string; address2?: string; city?: string; province?: string; zip?: string };
}

function AddressCard({ contract, primaryColor, onMutate, action }: {
  contract: Contract; primaryColor: string; onMutate: () => Promise<void>; action: ActionApi;
}) {
  const addr = contract.deliveryMethod?.address || {};
  const [editing, setEditing] = useState(false);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    firstName: addr.firstName || "",
    lastName: addr.lastName || "",
    address1: addr.address1 || "",
    address2: addr.address2 || "",
    city: addr.city || "",
    province: addr.province || addr.provinceCode || "",
    zip: addr.zip || "",
  });

  async function save(skipVerification: boolean) {
    setBusy(true);
    setVerification(null);
    action.startAction();
    try {
      const res = await fetch("/api/portal?route=address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ contractId: contract.id, ...form, skipVerification }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
        setBusy(false);
        return;
      }
      if (data?.verification && data.verification.valid === false) {
        // EasyPost says the address is suspicious — let the customer
        // choose between suggested + entered without firing the
        // success overlay yet.
        setVerification(data.verification as VerificationResult);
        setBusy(false);
        action.completeAction("Please confirm your address");
        return;
      }
      action.completeAction("Address updated");
      setEditing(false);
      await onMutate();
    } catch {
      action.failAction();
    } finally {
      setBusy(false);
    }
  }

  function useSuggested() {
    if (!verification?.suggested) return;
    const s = verification.suggested;
    setForm((prev) => ({
      ...prev,
      address1: s.address1 || prev.address1,
      address2: s.address2 || "",
      city: s.city || prev.city,
      province: s.province || prev.province,
      zip: s.zip || prev.zip,
    }));
    setVerification(null);
    // Re-save bypassing verification — EasyPost already gave us its
    // normalized form, no point re-checking.
    setTimeout(() => save(true), 50);
  }

  const display = [
    addr.address1,
    addr.address2,
    [addr.city, addr.province || addr.provinceCode, addr.zip].filter(Boolean).join(", "),
  ].filter(Boolean).join("\n");

  const textFields: Array<keyof typeof form> = ["firstName", "lastName", "address1", "address2", "city", "zip"];
  const labels: Record<string, string> = {
    firstName: "First name", lastName: "Last name", address1: "Address",
    address2: "Apt / Suite", city: "City", zip: "ZIP code",
  };

  return (
    <ActionCard title="Shipping address">
      <p className="whitespace-pre-line text-sm text-zinc-600">{display || "No address on file"}</p>
      <GhostButton busy={false} onClick={() => { setVerification(null); setEditing(true); }}>
        Change address
      </GhostButton>

      {editing && (
        <ModalShell
          title="Change shipping address"
          onClose={() => { setEditing(false); setVerification(null); }}
          footer={
            verification ? undefined : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => save(false)}
                  className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: primaryColor }}
                >
                  {busy ? "Verifying…" : "Save"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { setEditing(false); setVerification(null); }}
                  className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 disabled:opacity-50"
                >
                  Cancel
                </button>
              </>
            )
          }
        >
          {verification ? (
            <div className="space-y-3">
              {verification.errors && verification.errors.length > 0 && (
                <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                  {verification.errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
              {verification.suggested ? (
                <>
                  <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Suggested address</div>
                  <button
                    type="button"
                    onClick={useSuggested}
                    className="block w-full rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-left text-sm"
                  >
                    <div>{verification.suggested.address1}</div>
                    {verification.suggested.address2 && <div>{verification.suggested.address2}</div>}
                    <div>{verification.suggested.city}, {verification.suggested.province} {verification.suggested.zip}</div>
                    <span className="mt-2 inline-block rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
                      Use this address
                    </span>
                  </button>
                  <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">You entered</div>
                  <button
                    type="button"
                    onClick={() => { setVerification(null); save(true); }}
                    className="block w-full rounded-lg border border-zinc-200 bg-white p-3 text-left text-sm"
                  >
                    <div>{verification.entered?.address1}</div>
                    {verification.entered?.address2 && <div>{verification.entered.address2}</div>}
                    <div>{verification.entered?.city}, {verification.entered?.province} {verification.entered?.zip}</div>
                    <span className="mt-2 inline-block rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-700">
                      Use as entered
                    </span>
                  </button>
                </>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setVerification(null)}
                    className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700"
                  >
                    Edit address
                  </button>
                  <button
                    type="button"
                    onClick={() => { setVerification(null); save(true); }}
                    className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
                    style={{ background: primaryColor }}
                  >
                    Save anyway
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {textFields.map((k) => (
                <div key={k}>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">{labels[k]}</label>
                  <input
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
                    value={form[k]}
                    onChange={(e) => setForm((p) => ({ ...p, [k]: e.target.value }))}
                  />
                </div>
              ))}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">State</label>
                <select
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
                  value={form.province}
                  onChange={(e) => setForm((p) => ({ ...p, province: e.target.value }))}
                >
                  <option value="">Select state</option>
                  {US_STATES.map(([code, name]) => (
                    <option key={code} value={code}>{name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </ModalShell>
      )}
    </ActionCard>
  );
}

interface LoyaltyCoupon { id: string; code: string; discount_value: number; status: string }
interface LoyaltyTier { index: number; label: string; points_cost: number; affordable: boolean }
interface LoyaltyResp { ok?: boolean; enabled?: boolean; unused_coupons?: LoyaltyCoupon[]; tiers?: LoyaltyTier[] }

function CouponCard({ contract, primaryColor, onMutate, action }: {
  contract: Contract; primaryColor: string; onMutate: () => Promise<void>; action: ActionApi;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [loyalty, setLoyalty] = useState<LoyaltyResp | null>(null);
  const [loyaltyBusy, setLoyaltyBusy] = useState<string | null>(null);

  const allDiscounts = contract.appliedDiscounts || [];
  const hasManual = allDiscounts.some((d) => d.type === "MANUAL" || d.type === "AUTOMATIC_DISCOUNT");
  const hasCode = allDiscounts.some((d) => d.type === "CODE_DISCOUNT" || d.type === "code");

  // Pull the loyalty balance lazily — only when no code is applied, so
  // we don't hit the loyalty endpoint for customers who already used a
  // coupon this cycle.
  useEffect(() => {
    if (hasCode) return;
    let alive = true;
    fetch("/api/portal?route=loyaltyBalance", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (alive && data?.ok && data?.enabled) setLoyalty(data as LoyaltyResp); })
      .catch(() => {});
    return () => { alive = false; };
  }, [hasCode]);

  async function apply() {
    if (!code.trim() || busy) return;
    setBusy(true);
    action.startAction();
    try {
      const res = await fetch("/api/portal?route=coupon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ contractId: contract.id, discountCode: code.trim(), mode: "apply" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
      } else {
        action.completeAction("Coupon applied");
        setCode("");
        await onMutate();
      }
    } catch { action.failAction(); }
    finally { setBusy(false); }
  }

  async function removeDiscount(d: AppliedDiscount) {
    if (busy) return;
    setBusy(true);
    action.startAction();
    try {
      const res = await fetch("/api/portal?route=coupon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ contractId: contract.id, discountId: d.id, discountCode: d.code || d.title, mode: "remove" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
      } else {
        action.completeAction("Discount removed");
        await onMutate();
      }
    } catch { action.failAction(); }
    finally { setBusy(false); }
  }

  async function applyLoyaltyCoupon(c: LoyaltyCoupon) {
    setLoyaltyBusy(c.id);
    action.startAction();
    try {
      const res = await fetch("/api/portal?route=loyaltyApplyToSubscription", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ contractId: contract.id, redemptionId: c.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        action.failAction(data?.error || data?.message || undefined);
      } else {
        action.completeAction(`$${data.discount_value} loyalty coupon applied`);
        await onMutate();
      }
    } catch { action.failAction(); }
    finally { setLoyaltyBusy(null); }
  }

  async function redeemTier(t: LoyaltyTier) {
    setLoyaltyBusy("tier-" + t.index);
    action.startAction();
    try {
      const res = await fetch("/api/portal?route=loyaltyApplyToSubscription", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ contractId: contract.id, tierId: t.index }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        action.failAction(data?.error || data?.message || undefined);
      } else {
        action.completeAction(`$${data.discount_value} loyalty coupon redeemed & applied`);
        await onMutate();
      }
    } catch { action.failAction(); }
    finally { setLoyaltyBusy(null); }
  }

  const activeLoyaltyCoupons = (loyalty?.unused_coupons || []).filter((c) => c.status === "active");
  const affordableTiers = (loyalty?.tiers || []).filter((t) => t.affordable);
  const showLoyalty = !hasCode && (activeLoyaltyCoupons.length > 0 || affordableTiers.length > 0);

  return (
    <ActionCard title="Coupon">
      {allDiscounts.length > 0 && (
        <ul className="space-y-2">
          {allDiscounts.map((d, i) => {
            const label = d.code || d.title || "Discount";
            // Value conventions differ: internal coupons store fixed_amount in
            // CENTS, Appstle-synced ones (FIXED_AMOUNT) store DOLLARS. Percentages
            // are 0-100 either way.
            const isPct = d.type === "percentage" || d.valueType === "PERCENTAGE";
            const valueLabel = d.value == null
              ? null
              : isPct
                ? `${d.value}% off`
                : d.type === "fixed_amount"
                  ? `$${(Number(d.value) / 100).toFixed(2)} off` // internal: cents
                  : `$${Number(d.value).toFixed(2)} off`; // Appstle: dollars
            return (
              <li key={d.id || i} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-zinc-900">{label}</span>
                    {d.type === "MANUAL" && (
                      <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-700">
                        Auto
                      </span>
                    )}
                    {valueLabel && <span className="text-xs text-zinc-600">{valueLabel}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => removeDiscount(d)}
                  className="ml-3 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-semibold text-zinc-700 hover:border-zinc-400 disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {allDiscounts.length > 0 ? (
        <p className="text-sm text-zinc-600">Remove the current coupon to apply a different one.</p>
      ) : (
        <>
          <div className="flex gap-2">
            <input
              type="text"
              className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm uppercase text-zinc-900 placeholder:text-zinc-400 placeholder:normal-case"
              placeholder="Discount code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
            />
            <button
              type="button"
              disabled={busy || !code.trim()}
              onClick={apply}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: primaryColor }}
            >
              {busy ? "…" : "Apply"}
            </button>
          </div>

          {showLoyalty && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-amber-900">Use reward points</p>
              <div className="mt-2 space-y-2">
                {activeLoyaltyCoupons.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={loyaltyBusy != null}
                    onClick={() => applyLoyaltyCoupon(c)}
                    className="block w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-left text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  >
                    {loyaltyBusy === c.id ? "Applying…" : `Apply $${Math.round(c.discount_value)} coupon — ${c.code}`}
                  </button>
                ))}
                {activeLoyaltyCoupons.length === 0 && affordableTiers.map((t) => (
                  <button
                    key={t.index}
                    type="button"
                    disabled={loyaltyBusy != null}
                    onClick={() => redeemTier(t)}
                    className="block w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-left text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  >
                    {loyaltyBusy === "tier-" + t.index
                      ? "Redeeming…"
                      : `Redeem ${t.label} & apply — ${t.points_cost.toLocaleString()} pts`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </ActionCard>
  );
}

interface VaultedCard { id: string; brand: string | null; last4: string | null; is_default: boolean; provider: string; status: string }

function PaymentMethodCard({ contract, primaryColor, onMutate, action }: {
  contract: Contract; primaryColor: string; onMutate: () => Promise<void>; action: ActionApi;
}) {
  const pm = contract.paymentMethod;
  const isInternal = !!contract.is_internal;
  const [picking, setPicking] = useState(false);
  const [cards, setCards] = useState<VaultedCard[]>([]);
  const [busy, setBusy] = useState(false);

  if (!pm && !isInternal) return null;

  async function openPicker() {
    setPicking(true);
    try {
      const res = await fetch("/api/portal?route=paymentMethods", { credentials: "same-origin" });
      const data = res.ok ? await res.json() : null;
      setCards(((data?.methods as VaultedCard[]) || []).filter((m) => m.provider === "braintree" && m.status === "active"));
    } catch { setCards([]); }
  }

  async function selectCard(id: string) {
    if (busy) return;
    setBusy(true);
    action.startAction();
    try {
      const res = await fetch("/api/portal?route=setSubscriptionPaymentMethod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ contractId: contract.id, paymentMethodId: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) { action.failAction(data?.message || data?.error || undefined); return; }
      action.completeAction("Payment method updated for this subscription");
      setPicking(false);
      await onMutate();
    } catch { action.failAction(); }
    finally { setBusy(false); }
  }

  return (
    <ActionCard title="Payment method">
      {pm ? (
        <div className="flex items-center gap-3">
          <span className="text-2xl" aria-hidden>💳</span>
          <div>
            <div className="text-sm font-semibold text-zinc-900">{pm.brand || "Card"} ending in {pm.last4 || "••••"}</div>
            {pm.expiry && <div className="text-xs text-zinc-500">Expires {pm.expiry}</div>}
          </div>
        </div>
      ) : (
        <p className="text-sm text-zinc-600">No payment method on file.</p>
      )}

      {isInternal ? (
        picking ? (
          <div className="mt-3 space-y-2">
            {cards.map((c) => {
              const isCurrent = pm?.last4 === c.last4 && (pm?.brand || "").toLowerCase() === (c.brand || "").toLowerCase();
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={busy}
                  onClick={() => selectCard(c.id)}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition disabled:opacity-50 ${isCurrent ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 bg-white hover:border-zinc-300"}`}
                >
                  <span className="font-medium text-zinc-900">{c.brand || "Card"} •• {c.last4 || "••••"}</span>
                  <span className="text-xs text-zinc-500">{isCurrent ? "Current" : c.is_default ? "Default" : "Use this"}</span>
                </button>
              );
            })}
            {cards.length === 0 && <p className="text-sm text-zinc-500">No saved cards yet.</p>}
            <div className="flex items-center justify-between pt-1">
              <a
                href={`/payment-methods?add=1&forSub=${encodeURIComponent(contract.internal_id || contract.id)}`}
                onClick={(e) => { e.preventDefault(); window.location.href = `/payment-methods?add=1&forSub=${encodeURIComponent(contract.internal_id || contract.id)}`; }}
                className="text-xs font-semibold"
                style={{ color: primaryColor }}
              >
                + Add a new card
              </a>
              <button type="button" onClick={() => setPicking(false)} className="text-xs font-medium text-zinc-500 hover:text-zinc-700">Cancel</button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={openPicker}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:border-zinc-400"
          >
            Change card for this subscription
          </button>
        )
      ) : (
        <a
          href="/payment-methods"
          onClick={(e) => { e.preventDefault(); window.location.href = "/payment-methods"; }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:border-zinc-400"
        >
          Manage payment methods
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </a>
      )}
    </ActionCard>
  );
}

function CancelCard({ onStart }: { onStart: () => void }) {
  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-zinc-900">Cancel subscription</h3>
          <p className="mt-0.5 text-sm text-zinc-500">We&apos;ll ask a couple of quick questions first.</p>
        </div>
        <button
          type="button"
          onClick={onStart}
          className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:border-rose-300 hover:text-rose-800 sm:flex-shrink-0"
        >
          Cancel
        </button>
      </div>
    </article>
  );
}

// ────────────────────────── cancel flow ─────────────────────────────

interface CancelReason { id: string; label: string; type?: string; suggested_remedy_id?: string | null }
interface CancelRemedy { id: string; type: string; label: string; description?: string }
interface CancelReview { reviewer_name?: string; rating?: number; title?: string; body?: string; summary?: string }

function CancelFlow({
  contract, primaryColor, onAbort, onMutate, action,
}: {
  contract: Contract;
  primaryColor: string;
  onAbort: () => void;
  onMutate: () => Promise<void>;
  action: ActionApi;
}) {
  const [step, setStep] = useState<"reason" | "remedies" | "confirm" | "done">("reason");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<CancelReason[]>([]);
  const [firstName, setFirstName] = useState<string>("");
  const [pickedReason, setPickedReason] = useState<CancelReason | null>(null);
  const [leadIn, setLeadIn] = useState<string | null>(null);
  const [remedies, setRemedies] = useState<CancelRemedy[]>([]);
  const [reviews, setReviews] = useState<CancelReview[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1: fetch reasons + remedy catalog on mount
  useEffect(() => {
    let alive = true;
    const url = `/api/portal?route=cancelJourney&contractId=${encodeURIComponent(contract.id)}`;
    fetch(url, { credentials: "same-origin" })
      .then((r) => r.ok ? r.json() : Promise.reject(r))
      .then((data) => {
        if (!alive) return;
        setReasons((data.cancel_reasons || []) as CancelReason[]);
        setFirstName(String(data.customerFirstName || ""));
      })
      .catch(() => { if (alive) setError("Couldn't load cancel options"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [contract.id]);

  async function pickReason(reason: CancelReason) {
    if (busy) return;
    setBusy(true);
    setPickedReason(reason);
    action.startAction();
    try {
      const res = await fetch(`/api/portal?route=cancelJourney&contractId=${encodeURIComponent(contract.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          contractId: contract.id,
          step: "reason",
          reason: reason.id,
          reasonLabel: reason.label,
          reasonType: reason.type || "remedy",
          suggested_remedy_id: reason.suggested_remedy_id,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
        setBusy(false);
        return;
      }
      action.completeAction("");
      setRemedies((data.remedies || []) as CancelRemedy[]);
      setReviews((data.reviews || []) as CancelReview[]);
      setLeadIn(data.lead_in || null);
      setSessionId(data.sessionId || null);
      setStep("remedies");
    } catch {
      action.failAction();
    } finally {
      setBusy(false);
    }
  }

  async function acceptRemedy(remedy: CancelRemedy) {
    if (busy) return;
    setBusy(true);
    action.startAction();
    try {
      const res = await fetch(`/api/portal?route=cancelJourney&contractId=${encodeURIComponent(contract.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          contractId: contract.id,
          step: "remedy",
          remedyId: remedy.id,
          accepted: true,
          sessionId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
        return;
      }
      action.completeAction(remedy.label ? `${remedy.label} applied` : "Saved!");
      await onMutate();
      setStep("done");
    } catch { action.failAction(); }
    finally { setBusy(false); }
  }

  async function confirmCancel() {
    if (busy) return;
    setBusy(true);
    action.startAction();
    try {
      const res = await fetch(`/api/portal?route=cancelJourney&contractId=${encodeURIComponent(contract.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          contractId: contract.id,
          step: "confirm_cancel",
          reason: pickedReason?.label || "Customer cancelled via portal",
          sessionId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
        return;
      }
      action.completeAction("Subscription cancelled");
      await onMutate();
      setStep("done");
    } catch { action.failAction(); }
    finally { setBusy(false); }
  }

  // ── chrome ──
  const back = (
    <button
      type="button"
      onClick={onAbort}
      className="inline-flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-900"
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      Never mind, take me back
    </button>
  );

  if (loading) {
    return (
      <div className="space-y-4">
        {back}
        <div className="h-48 animate-pulse rounded-2xl bg-zinc-100" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-4">
        {back}
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800">{error}</div>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="space-y-4">
        <article className="rounded-2xl border border-zinc-200 bg-white p-6 text-center">
          <p className="text-base font-semibold text-zinc-900">All set, {firstName || "thanks"}.</p>
          <p className="mt-1 text-sm text-zinc-600">We&apos;ve recorded your decision. You can manage things anytime from here.</p>
          <button
            type="button"
            onClick={onAbort}
            className="mt-4 rounded-lg px-4 py-2 text-sm font-semibold text-white"
            style={{ background: primaryColor }}
          >
            Back to subscription
          </button>
        </article>
      </div>
    );
  }

  if (step === "reason") {
    return (
      <div className="space-y-5">
        {back}
        <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-xl font-bold text-zinc-900">
            {firstName ? `${firstName}, ` : ""}before you go…
          </h2>
          <p className="mt-1 text-sm text-zinc-600">Mind sharing what&apos;s prompting this? It helps us help you.</p>
          <ul className="mt-5 space-y-2">
            {reasons.length === 0 ? (
              <li className="rounded-lg bg-zinc-50 p-4 text-sm text-zinc-500">
                No cancel reasons configured yet — set them up in Settings → Cancel Flow.
              </li>
            ) : reasons.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => pickReason(r)}
                  className="flex w-full items-center justify-between rounded-lg border border-zinc-200 bg-white p-4 text-left transition hover:border-zinc-400 disabled:opacity-50"
                >
                  <span className="text-sm font-medium text-zinc-900">{r.label}</span>
                  <svg className="h-4 w-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </article>
      </div>
    );
  }

  // step === "remedies"
  return (
    <div className="space-y-5">
      {back}
      <article className="rounded-2xl border border-zinc-200 bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Because you said
        </p>
        <h2 className="mt-1 text-xl font-bold text-zinc-900">{pickedReason?.label}</h2>
        {leadIn && <p className="mt-2 text-sm leading-relaxed text-zinc-700">{leadIn}</p>}
      </article>

      {remedies.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Here&apos;s what we can do
          </p>
          {remedies.map((r) => (
            <article key={r.id} className="overflow-hidden rounded-2xl border border-zinc-200 bg-white p-5">
              <h3 className="text-base font-semibold text-zinc-900">{r.label}</h3>
              {r.description && <p className="mt-1 text-sm leading-relaxed text-zinc-600">{r.description}</p>}
              <button
                type="button"
                disabled={busy}
                onClick={() => acceptRemedy(r)}
                className="mt-3 w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: primaryColor }}
              >
                Yes, let&apos;s do this
              </button>
            </article>
          ))}
        </div>
      )}

      {reviews.length > 0 && (
        <article className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">What other customers say</p>
          {reviews.slice(0, 1).map((r, i) => (
            <div key={i} className="mt-2">
              <div className="text-amber-500" aria-label={`${r.rating || 5} stars`}>{"★".repeat(r.rating || 5)}</div>
              {(r.summary || r.title) && (
                <p className="mt-1 text-sm font-semibold text-zinc-900">
                  {r.summary || r.title}
                </p>
              )}
              {r.body && r.body !== (r.summary || r.title) && (
                <p className="mt-1 text-sm italic text-zinc-600">“{r.body.slice(0, 220)}{r.body.length > 220 ? "…" : ""}”</p>
              )}
              {r.reviewer_name && <p className="mt-2 text-xs text-zinc-500">— {r.reviewer_name}</p>}
            </div>
          ))}
        </article>
      )}

      {/* Stand firm: confirm cancel */}
      <article className="rounded-2xl border border-zinc-200 bg-white p-5">
        <p className="text-sm text-zinc-700">
          Still want to cancel? We&apos;ll stop future deliveries.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={confirmCancel}
          className="mt-3 w-full rounded-lg border border-rose-300 bg-white px-4 py-2.5 text-sm font-semibold text-rose-700 hover:border-rose-400 hover:text-rose-800 disabled:opacity-50"
        >
          Yes, cancel my subscription
        </button>
      </article>
    </div>
  );
}

// ───────────────────── chunk 5 cards (cross-sell trio) ─────────────────────

function ShippingProtectionCard({
  contract, shipLine, variantIds, onMutate, action,
}: {
  contract: Contract;
  shipLine?: ContractLine;
  variantIds: string[];
  onMutate: () => Promise<void>;
  action: ActionApi;
}) {
  // Internal subs track protection on the row (column) — single source of truth
  // with billing + the order summary. Appstle subs use the line-item add/remove.
  const isInternal = !!contract.is_internal;
  const hasShipProt = isInternal ? !!contract.shipping_protection_added : !!shipLine;
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    action.startAction();
    try {
      if (isInternal) {
        const res = await fetch("/api/portal?route=shippingProtection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ contractId: contract.id, enabled: !hasShipProt }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.error) { action.failAction(data?.message || data?.error || undefined); return; }
        action.completeAction(hasShipProt ? "Shipping protection removed" : "Shipping protection added");
      } else if (hasShipProt && shipLine) {
        const res = await fetch("/api/portal?route=removeLineItem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ contractId: contract.id, lineId: shipLine.id, variantId: shipLine.variantId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.error) { action.failAction(data?.message || data?.error || undefined); return; }
        action.completeAction("Shipping protection removed");
      } else {
        const res = await fetch("/api/portal?route=replaceVariants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ contractId: contract.id, newVariants: [{ variantId: String(variantIds[0]), quantity: 1 }] }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.error) { action.failAction(data?.message || data?.error || undefined); return; }
        action.completeAction("Shipping protection added");
      }
      await onMutate();
    } catch { action.failAction(); }
    finally { setBusy(false); }
  }

  return (
    <article
      className={`overflow-hidden rounded-2xl border p-5 ${
        hasShipProt ? "border-emerald-200 bg-emerald-50" : "border-zinc-200 bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className={hasShipProt ? "text-emerald-600" : "text-zinc-400"}>
            <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              {hasShipProt && <polyline points="9 12 11 14 15 10" />}
            </svg>
          </div>
          <div>
            <h3 className="text-base font-semibold text-zinc-900">Shipping protection</h3>
            <p className={`mt-0.5 text-xs font-semibold uppercase tracking-wider ${
              hasShipProt ? "text-emerald-700" : "text-zinc-500"
            }`}>
              {hasShipProt ? "Protected" : "Not protected"}
            </p>
          </div>
        </div>
        <ToggleSwitch on={hasShipProt} disabled={busy} onChange={toggle} />
      </div>
      <p className="mt-3 text-sm text-zinc-600">
        {hasShipProt
          ? "Your orders are protected against loss, theft, and damage."
          : "Protect against loss, theft, and damage."}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="text-zinc-400 line-through">$5.00</span>{" "}
          <strong className="text-zinc-900">$3.75</strong>
        </div>
        <span className="rounded-full bg-zinc-900 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
          85% of customers choose this
        </span>
      </div>
    </article>
  );
}

function ToggleSwitch({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition disabled:opacity-50 ${
        on ? "bg-emerald-600" : "bg-zinc-300"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
          on ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

interface LoyaltyBalance {
  ok?: boolean;
  enabled?: boolean;
  points_balance?: number;
  dollar_value?: number;
  tiers?: Array<{ index: number; label: string; points_cost: number; points_needed?: number; affordable: boolean }>;
  unused_coupons?: Array<{ id: string; code: string; discount_value: number; status: string; expires_at?: string }>;
}

function RewardsCard({ contract, primaryColor, action }: { contract: Contract; primaryColor: string; action: ActionApi }) {
  const [data, setData] = useState<LoyaltyBalance | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  void contract;

  useEffect(() => {
    let alive = true;
    fetch("/api/portal?route=loyaltyBalance", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: LoyaltyBalance | null) => { if (alive && d?.ok && d?.enabled) setData(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  async function redeemTier(tierIndex: number) {
    setBusy(String(tierIndex));
    action.startAction();
    try {
      const res = await fetch("/api/portal?route=loyaltyRedeem", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ tierId: tierIndex }),
      });
      const r = await res.json().catch(() => ({}));
      if (!r?.ok) { action.failAction(r?.error || undefined); return; }
      action.completeAction(`Coupon ${r.code} created — $${r.discount_value} off`);
      const fresh = await fetch("/api/portal?route=loyaltyBalance", { credentials: "same-origin" }).then((rr) => (rr.ok ? rr.json() : null));
      if (fresh?.ok && fresh?.enabled) setData(fresh as LoyaltyBalance);
    } catch { action.failAction(); }
    finally { setBusy(null); }
  }

  if (!data) return null;
  const { points_balance = 0, dollar_value = 0, tiers = [], unused_coupons = [] } = data;
  const hasCoupons = unused_coupons.length > 0;

  return (
    <ActionCard title="Rewards" subtitle="Your points and perks.">
      <div className="flex items-center gap-3 rounded-xl bg-gradient-to-br from-amber-50 to-orange-50 p-4">
        <div className="text-3xl">🎁</div>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-zinc-700">
            You have <strong>{points_balance.toLocaleString()}</strong> reward points
          </div>
          {dollar_value > 0 && (
            <div className="mt-0.5 text-xs text-zinc-600">
              That&apos;s worth <strong>${dollar_value.toFixed(2)}</strong> in rewards
            </div>
          )}
        </div>
        {dollar_value > 0 && (
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-white"
            style={{ background: primaryColor }}
          >
            ${dollar_value.toFixed(0)} value
          </span>
        )}
      </div>

      {tiers.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Redeem your points</div>
          <ul className="space-y-2">
            {tiers.map((t) => (
              <li key={t.index}>
                <button
                  type="button"
                  disabled={!t.affordable || busy != null}
                  onClick={() => redeemTier(t.index)}
                  className={`flex w-full items-center justify-between rounded-lg border p-3 text-left transition ${
                    t.affordable
                      ? "border-amber-300 bg-amber-50 hover:bg-amber-100"
                      : "border-zinc-200 bg-zinc-50 opacity-60"
                  } disabled:cursor-not-allowed`}
                >
                  <span className="text-sm font-semibold text-zinc-900">{t.label}</span>
                  <span className="text-xs font-medium text-zinc-600">
                    {busy === String(t.index)
                      ? "Redeeming…"
                      : t.affordable
                        ? `${t.points_cost.toLocaleString()} pts`
                        : `Need ${(t.points_needed || 0).toLocaleString()} more`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasCoupons && (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Your coupons</div>
          <ul className="space-y-2">
            {unused_coupons.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-3">
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-sm font-semibold text-zinc-900">{c.code}</span>
                  <span className="ml-2 text-xs text-zinc-600">${Math.round(c.discount_value)} off</span>
                </div>
                <div className="flex items-center gap-2">
                  {c.status === "active" && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                      Ready
                    </span>
                  )}
                  {c.status === "applied" && (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-700">
                      Applied
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ActionCard>
  );
}

interface ReviewRow {
  summary?: string;
  title?: string;
  body?: string;
  author?: string;
  rating?: number;
  featured?: boolean;
}

const REVIEWS_ROTATE_MS = 15000;
const REVIEW_TRUNCATE = 260;

function truncateReview(str: string, max: number): { text: string; cut: boolean } {
  if (!str || str.length <= max) return { text: str || "", cut: false };
  let cut = str.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return { text: cut.replace(/\s+$/, "") + "…", cut: true };
}

function ReviewsCard({ productIds }: { productIds: string[] }) {
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let alive = true;
    const ids = productIds.filter(Boolean).join(",");
    if (!ids) return;
    fetch(`/api/portal?route=reviews&productIds=${encodeURIComponent(ids)}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { ok?: boolean; by_product_id?: Record<string, { ok?: boolean; reviews?: ReviewRow[] }> } | null) => {
        if (!alive || !data?.ok || !data.by_product_id) return;
        const byPid = data.by_product_id;
        // Round-robin: pick the next review from each product per round,
        // featured-first within each product. Same as the Preact source.
        const orderedPids = productIds.filter((pid) => {
          const e = byPid[pid];
          return e?.ok && Array.isArray(e.reviews) && e.reviews.length > 0;
        });
        const sorted: Record<string, ReviewRow[]> = {};
        for (const pid of orderedPids) {
          const rs = [...(byPid[pid].reviews || [])].filter((r) => r.summary || r.title || r.body);
          rs.sort((a, b) => {
            if (a.featured && !b.featured) return -1;
            if (!a.featured && b.featured) return 1;
            return (b.rating || 0) - (a.rating || 0);
          });
          sorted[pid] = rs;
        }
        const seq: ReviewRow[] = [];
        const maxRounds = Math.max(0, ...orderedPids.map((pid) => sorted[pid].length));
        for (let round = 0; round < maxRounds; round++) {
          for (const pid of orderedPids) {
            if (round < sorted[pid].length) seq.push(sorted[pid][round]);
          }
        }
        setReviews(seq);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [productIds]);

  useEffect(() => {
    if (reviews.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % reviews.length), REVIEWS_ROTATE_MS);
    return () => clearInterval(t);
  }, [reviews.length]);

  if (!reviews.length) return null;

  const r = reviews[idx % reviews.length] || {};
  const headline = r.summary || r.title || (r.body ? r.body.split(/[.!?]/)[0] + "." : "Loved it");
  const bodyRaw = r.body || "";
  const showBody = bodyRaw && bodyRaw !== headline;
  const { text: bodyText, cut } = showBody ? truncateReview(bodyRaw, REVIEW_TRUNCATE) : { text: "", cut: false };
  const author = r.author || "Verified Customer";

  return (
    <ActionCard title="Reviews" subtitle="What customers are saying.">
      <div className="text-2xl text-amber-500" aria-label="5 out of 5 stars">★★★★★</div>
      <div className="text-base font-semibold text-zinc-900">
        <span className="mr-1 text-2xl text-zinc-300" aria-hidden>“</span>
        {headline}
      </div>
      {showBody && bodyText && (
        <p className="text-sm italic text-zinc-600">“{bodyText}”</p>
      )}
      {cut && (
        <button
          type="button"
          onClick={(e) => e.preventDefault()}
          className="text-xs font-semibold text-zinc-600 underline"
        >
          Read full review
        </button>
      )}
      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-500">
          <strong className="text-zinc-700">{author}</strong>
          <span className="mx-2 text-zinc-300">•</span>
          <span className="inline-flex items-center gap-1 text-emerald-600">
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
              <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.4 7.4a1 1 0 01-1.4 0L3.3 9.5a1 1 0 011.4-1.4l3.9 3.9 6.7-6.7a1 1 0 011.4 0z" clipRule="evenodd" />
            </svg>
            Verified
          </span>
        </div>
        {reviews.length > 1 && (
          <div className="flex gap-1">
            <button
              type="button"
              aria-label="Previous review"
              onClick={() => setIdx((i) => (i - 1 + reviews.length) % reviews.length)}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600 hover:border-zinc-300"
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Next review"
              onClick={() => setIdx((i) => (i + 1) % reviews.length)}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600 hover:border-zinc-300"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </ActionCard>
  );
}

function dateBounds() {
  // Tomorrow+1 → 90 days out — matches the Preact source's bounds
  // (Appstle won't accept same-day or past dates).
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 2);
  const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 90);
  return {
    minStr: tomorrow.toISOString().split("T")[0],
    maxStr: maxDate.toISOString().split("T")[0],
  };
}

// ─────────────────────────────── pills ──────────────────────────────

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "bg-emerald-100 text-emerald-800"
      : status === "paused"
        ? "bg-amber-100 text-amber-800"
        : status === "cancelled"
          ? "bg-zinc-200 text-zinc-700"
          : "bg-zinc-100 text-zinc-700";
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${tone}`}>
      {label}
    </span>
  );
}
