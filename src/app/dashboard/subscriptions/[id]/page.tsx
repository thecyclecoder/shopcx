"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";
import StoreCreditModal from "@/components/store-credit-modal";
import ReturnsList from "@/components/shared/ReturnsList";
import { ReplacementsList } from "@/components/shared/ReplacementsList";
import type { ReplacementItem } from "@/components/shared/ReplacementsList";
import OrdersTable from "@/components/shared/OrdersTable";
import ChargebacksList from "@/components/shared/ChargebacksList";
import FraudCasesList from "@/components/shared/FraudCasesList";
import type { ChargebackItem } from "@/components/shared/ChargebacksList";
import type { FraudCaseItem } from "@/components/shared/FraudCasesList";
import { formatCents, formatDate, formatItemName } from "@/components/shared/format-utils";
import type { OrderRow } from "@/components/shared/OrdersTable";

interface CustomerData {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  shopify_customer_id: string | null;
  retention_score: number | null;
  subscription_status: string | null;
  ltv_cents: number | null;
  total_orders: number | null;
  email_marketing_status: string | null;
  sms_marketing_status: string | null;
  default_address: { address1?: string; city?: string; province?: string; countryCodeV2?: string; zip?: string } | null;
  tags: string[] | null;
  first_order_at: string | null;
  shopify_created_at: string | null;
  created_at: string;
}

interface SubItem {
  title?: string;
  sku?: string;
  quantity?: number;
  price_cents?: number;
  variant_title?: string;
  product_id?: string;
  variant_id?: string;
  selling_plan?: string;
  line_id?: string;
}

interface SubDetail {
  id: string;
  shopify_contract_id: string;
  status: string;
  items: SubItem[] | null;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  last_payment_status: string | null;
  delivery_price_cents: number | null;
  applied_discounts: { id: string; type: string; title: string; value: number; valueType: string }[] | null;
  created_at: string;
  recovery_status: string | null;
  customer_id: string;
  customers: CustomerData;
}

interface DunningCycle {
  id: string;
  cycle_number: number;
  status: string;
  cards_tried: string[];
  payment_update_sent: boolean;
  payment_update_sent_at: string | null;
  skipped_at: string | null;
  recovered_at: string | null;
  paused_at: string | null;
  created_at: string;
}

interface PaymentFailure {
  id: string;
  payment_method_last4: string | null;
  attempt_type: string;
  succeeded: boolean;
  created_at: string;
}

interface OrderLineItem {
  title: string;
  quantity: number;
  price_cents: number;
  sku: string | null;
}

interface Fulfillment {
  trackingInfo: { number: string; url: string | null; company: string | null }[];
  status: string | null;
  createdAt: string | null;
}

interface Order {
  id: string;
  shopify_order_id: string;
  order_number: string | null;
  total_cents: number | null;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  source_name: string | null;
  order_type: string | null;
  tags: string | null;
  line_items: OrderLineItem[] | null;
  fulfillments: Fulfillment[] | null;
  created_at: string;
}

interface CustomerEvent {
  id: string;
  event_type: string;
  summary: string;
  source: string;
  created_at: string;
}

interface Product {
  id: string;
  shopify_product_id: string;
  title: string;
  variants: { id: string; shopify_variant_id: string; title: string }[] | null;
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  cancelled: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  expired: "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500",
};

const RECOVERY_BADGE: Record<string, { label: string; classes: string }> = {
  in_recovery: { label: "In Recovery", classes: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border border-amber-200 dark:border-amber-800" },
  failed: { label: "Payment Failed", classes: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
  recovered: { label: "Recovered", classes: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
};

const EVENT_ICONS: Record<string, { icon: string; color: string }> = {
  "subscription.created": { icon: "M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3", color: "text-violet-500" },
  "subscription.cancelled": { icon: "M6 18L18 6M6 6l12 12", color: "text-red-500" },
  "subscription.paused": { icon: "M15.75 5.25v13.5m-7.5-13.5v13.5", color: "text-amber-500" },
  "subscription.activated": { icon: "M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z", color: "text-emerald-500" },
  "subscription.item_added": { icon: "M12 4.5v15m7.5-7.5h-15", color: "text-blue-500" },
  "subscription.item_removed": { icon: "M19.5 12h-15", color: "text-red-500" },
  "subscription.item_updated": { icon: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182", color: "text-indigo-500" },
};

/* formatCents, formatDate imported from @/components/shared/format-utils */

function formatInterval(interval: string | null, count: number | null): string {
  if (!interval) return "--";
  const c = count || 1;
  if (c === 1) return `Every ${interval}`;
  return `Every ${c} ${interval}s`;
}

function RetentionBadge({ score }: { score: number }) {
  const classes = score > 70
    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
    : score >= 40
    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>{score}/100</span>;
}

export default function SubscriptionDetailPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const params = useParams();
  const subId = params.id as string;

  const [sub, setSub] = useState<SubDetail | null>(null);
  const [dunningCycles, setDunningCycles] = useState<DunningCycle[]>([]);
  const [paymentFailures, setPaymentFailures] = useState<PaymentFailure[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [events, setEvents] = useState<CustomerEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  // selectedOrderId now managed internally by OrdersTable

  // Action form state
  const [cancelReason, setCancelReason] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [frequencyInterval, setFrequencyInterval] = useState("MONTH");
  const [frequencyCount, setFrequencyCount] = useState(1);
  const [nextDate, setNextDate] = useState("");

  // Item management state
  const [products, setProducts] = useState<Product[]>([]);
  const [showAddItem, setShowAddItem] = useState(false);
  const [addVariantId, setAddVariantId] = useState("");
  const [addQuantity, setAddQuantity] = useState(1);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState(1);
  const [swapVariantId, setSwapVariantId] = useState("");
  const [storeCreditBalance, setStoreCreditBalance] = useState<number | null>(null);
  const [showStoreCreditModal, setShowStoreCreditModal] = useState(false);
  const [subReturns, setSubReturns] = useState<{ id: string; order_number: string; status: string; resolution_type: string; net_refund_cents: number; created_at: string }[]>([]);
  const [subReplacements, setSubReplacements] = useState<ReplacementItem[]>([]);
  const [chargebacks, setChargebacks] = useState<ChargebackItem[]>([]);
  const [fraudCases, setFraudCases] = useState<FraudCaseItem[]>([]);

  const loadSub = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}`);
    if (!res.ok) { router.push("/dashboard/subscriptions"); return; }
    const data = await res.json();
    setSub(data.subscription);
    setDunningCycles(data.dunning_cycles || []);
    setPaymentFailures(data.payment_failures || []);
    setOrders(data.orders || []);
    setEvents(data.events || []);
    setLoading(false);
    // Fetch store credit balance
    if (data.subscription?.customer_id) {
      fetch(`/api/store-credit/balance?customerId=${data.subscription.customer_id}`)
        .then(r => r.json())
        .then(b => setStoreCreditBalance(b.balance ?? 0))
        .catch(() => setStoreCreditBalance(0));
      // Fetch returns for this customer (filter by subscription orders client-side)
      fetch(`/api/workspaces/${workspace.id}/returns?customer_id=${data.subscription.customer_id}&limit=50`)
        .then(r => r.json())
        .then(d => {
          const orderNums = new Set((data.orders || []).map((o: { order_number: string | null }) => o.order_number));
          const matched = (d.returns || []).filter((r: { order_number: string }) => orderNums.has(r.order_number));
          setSubReturns(matched);
        })
        .catch(() => {});

      // Fetch replacements for this subscription
      fetch(`/api/workspaces/${workspace.id}/replacements?subscription_id=${subId}&limit=50`)
        .then(r => r.json())
        .then(d => setSubReplacements(d.replacements || []))
        .catch(() => {});

      // Fetch chargebacks for this customer
      fetch(`/api/chargebacks?customer_id=${data.subscription.customer_id}&limit=10`)
        .then(r => r.json())
        .then(d => setChargebacks(d.data || []))
        .catch(() => {});

      // Fetch fraud cases for this customer
      fetch(`/api/workspaces/${workspace.id}/fraud-cases?customer_id=${data.subscription.customer_id}&limit=10`)
        .then(r => r.json())
        .then(d => setFraudCases(d.cases || []))
        .catch(() => {});
    }
  }, [workspace.id, subId, router]);

  useEffect(() => { loadSub(); }, [loadSub]);

  // Load products for item management
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/products`)
      .then(r => r.ok ? r.json() : [])
      .then(setProducts);
  }, [workspace.id]);

  const doAction = async (action: string, body: Record<string, unknown> = {}) => {
    setActing(action);
    const res = await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
    if (res.ok) {
      await loadSub();
      setShowCancel(false);
    } else {
      const data = await res.json();
      alert(data.error || "Action failed");
    }
    setActing(null);
  };

  const doBillNow = async () => {
    if (!confirm("Process payment now? This will attempt to bill the customer immediately.")) return;
    setActing("bill_now");
    await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}/bill-now`, { method: "POST" });
    await loadSub();
    setActing(null);
  };

  const doPaymentUpdate = async () => {
    setActing("payment_update");
    await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}/payment-update`, { method: "POST" });
    await loadSub();
    setActing(null);
  };

  // Item management
  const doAddItem = async () => {
    if (!addVariantId) return;
    setActing("add_item");
    const res = await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantId: addVariantId, quantity: addQuantity }),
    });
    if (res.ok) {
      await loadSub();
      setShowAddItem(false);
      setAddVariantId("");
      setAddQuantity(1);
    } else {
      const data = await res.json();
      alert(data.error || "Failed to add item");
    }
    setActing(null);
  };

  const doRemoveItem = async (variantId: string) => {
    if (!confirm("Remove this item from the subscription?")) return;
    setActing("remove_item");
    const res = await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}/items`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantId }),
    });
    if (res.ok) {
      await loadSub();
    } else {
      const data = await res.json();
      alert(data.error || "Failed to remove item");
    }
    setActing(null);
  };

  const doUpdateItem = async (variantId: string) => {
    setActing("update_item");
    const body: Record<string, unknown> = { variantId };
    if (editQuantity) body.quantity = editQuantity;
    if (swapVariantId) body.newVariantId = swapVariantId;

    const res = await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}/items`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      await loadSub();
      setEditingItem(null);
      setSwapVariantId("");
    } else {
      const data = await res.json();
      alert(data.error || "Failed to update item");
    }
    setActing(null);
  };

  if (loading || !sub) {
    return <div className="flex h-full items-center justify-center"><p className="text-sm text-zinc-400">Loading...</p></div>;
  }

  const customer = sub.customers;
  const customerName = `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim() || customer?.email;
  const items = sub.items || [];
  const activeDunning = dunningCycles.find(c => ["active", "skipped", "paused"].includes(c.status));

  // Build flat variant list for add/swap selects
  const variantOptions = products.flatMap(p =>
    (p.variants || []).map(v => ({
      value: v.shopify_variant_id,
      label: v.title === "Default Title" ? p.title : `${p.title} — ${v.title}`,
    }))
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Back */}
      <Link href="/dashboard/subscriptions" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to Subscriptions
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/dashboard/customers/${customer?.id}`} className="text-xl font-bold text-indigo-600 hover:underline dark:text-indigo-400">
            {customerName}
          </Link>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[sub.status] || STATUS_BADGE.active}`}>{sub.status}</span>
          {sub.recovery_status && RECOVERY_BADGE[sub.recovery_status] && (
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${RECOVERY_BADGE[sub.recovery_status].classes}`}>
              {RECOVERY_BADGE[sub.recovery_status].label}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-zinc-400">Contract #{sub.shopify_contract_id} &middot; {customer?.email}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: Info + Customer + Items + Orders + Activity */}
        <div className="space-y-6 lg:col-span-2">

          {/* Customer Card */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Customer</h3>
              {customer?.retention_score != null && <RetentionBadge score={customer.retention_score} />}
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <span className="text-xs text-zinc-400">LTV</span>
                <p className="font-medium text-zinc-700 dark:text-zinc-300">{customer?.ltv_cents ? formatCents(customer.ltv_cents) : "--"}</p>
              </div>
              <div>
                <span className="text-xs text-zinc-400">Total Orders</span>
                <p className="font-medium text-zinc-700 dark:text-zinc-300">{customer?.total_orders ?? "--"}</p>
              </div>
              <div>
                <span className="text-xs text-zinc-400">Subscription</span>
                <p className="font-medium capitalize text-zinc-700 dark:text-zinc-300">{customer?.subscription_status || "--"}</p>
              </div>
              <div>
                <span className="text-xs text-zinc-400">Customer Since</span>
                <p className="font-medium text-zinc-700 dark:text-zinc-300">{formatDate(customer?.shopify_created_at || customer?.first_order_at || customer?.created_at)}</p>
              </div>
            </div>

            {/* Contact & Marketing row */}
            <div className="mt-4 grid grid-cols-1 gap-4 border-t border-zinc-100 pt-4 dark:border-zinc-800 sm:grid-cols-2">
              <div className="space-y-1 text-sm">
                <p className="text-xs font-medium uppercase text-zinc-400">Contact</p>
                <p className="text-zinc-700 dark:text-zinc-300">{customer?.email}</p>
                {customer?.phone && <p className="text-zinc-500">{customer.phone}</p>}
                {customer?.default_address && (
                  <p className="text-zinc-400">
                    {[customer.default_address.city, customer.default_address.province, customer.default_address.countryCodeV2].filter(Boolean).join(", ")}
                    {customer.default_address.zip && ` ${customer.default_address.zip}`}
                  </p>
                )}
              </div>
              <div className="space-y-1 text-sm">
                <p className="text-xs font-medium uppercase text-zinc-400">Marketing</p>
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${customer?.email_marketing_status === "subscribed" ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
                  <span className="text-zinc-700 dark:text-zinc-300">Email: <span className="capitalize">{customer?.email_marketing_status?.replace("_", " ") || "Unknown"}</span></span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${customer?.sms_marketing_status === "subscribed" ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
                  <span className="text-zinc-700 dark:text-zinc-300">SMS: <span className="capitalize">{customer?.sms_marketing_status?.replace("_", " ") || "Unknown"}</span></span>
                </div>
              </div>
            </div>

            {/* Tags */}
            {customer?.tags && customer.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                {customer.tags.map(tag => (
                  <span key={tag} className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{tag}</span>
                ))}
              </div>
            )}
          </div>

          {/* Subscription Info */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Subscription Info</h3>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div><span className="text-zinc-400">Frequency</span><p className="font-medium text-zinc-700 dark:text-zinc-300">{formatInterval(sub.billing_interval, sub.billing_interval_count)}</p></div>
              <div><span className="text-zinc-400">Next Billing</span><p className="font-medium text-zinc-700 dark:text-zinc-300">{formatDate(sub.next_billing_date)}</p></div>
              <div><span className="text-zinc-400">Last Payment</span><p className={`font-medium ${sub.last_payment_status === "succeeded" ? "text-emerald-600" : sub.last_payment_status === "failed" ? "text-red-600" : "text-zinc-600"}`}>{sub.last_payment_status || "--"}</p></div>
              <div><span className="text-zinc-400">Created</span><p className="font-medium text-zinc-700 dark:text-zinc-300">{formatDate(sub.created_at)}</p></div>
              <div><span className="text-zinc-400">Shipping</span><p className="font-medium text-zinc-700 dark:text-zinc-300">{sub.delivery_price_cents ? formatCents(sub.delivery_price_cents) : "Free"}</p></div>
            </div>
          </div>

          {/* Items with management */}
          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Products ({items.length})</h3>
              {sub.status === "active" && (
                <button
                  onClick={() => setShowAddItem(!showAddItem)}
                  className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-600"
                >
                  {showAddItem ? "Cancel" : "+ Add Item"}
                </button>
              )}
            </div>

            {/* Add item form */}
            {showAddItem && (
              <div className="border-b border-zinc-200 bg-zinc-50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-800/30">
                <div className="flex flex-wrap gap-2">
                  <select
                    value={addVariantId}
                    onChange={e => setAddVariantId(e.target.value)}
                    className="flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    <option value="">Select product...</option>
                    {variantOptions.map(v => (
                      <option key={v.value} value={v.value}>{v.label}</option>
                    ))}
                  </select>
                  <select
                    value={addQuantity}
                    onChange={e => setAddQuantity(parseInt(e.target.value))}
                    className="w-16 rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <button
                    onClick={doAddItem}
                    disabled={!addVariantId || acting === "add_item"}
                    className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                  >
                    {acting === "add_item" ? "Adding..." : "Add"}
                  </button>
                </div>
              </div>
            )}

            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {items.map((item, i) => {
                const isShippingProtection = (item.title || "").toLowerCase().includes("shipping protection");
                const itemKey = item.variant_id || item.line_id || String(i);
                const isEditing = editingItem === itemKey;
                return (
                  <div key={itemKey} className="px-5 py-3">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {item.title || "Item"}
                          {isShippingProtection && (
                            <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Protection</span>
                          )}
                        </p>
                        <p className="text-xs text-zinc-400">
                          {item.variant_title && `${item.variant_title} · `}
                          {item.sku && `SKU: ${item.sku} · `}
                          Qty: {item.quantity || 1}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
                          {item.price_cents ? formatCents(item.price_cents * (item.quantity || 1)) : "--"}
                        </span>
                        {sub.status === "active" && item.variant_id && !isShippingProtection && (
                          <button
                            onClick={() => {
                              if (isEditing) { setEditingItem(null); }
                              else { setEditingItem(itemKey); setEditQuantity(item.quantity || 1); setSwapVariantId(""); }
                            }}
                            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Edit/Swap/Remove controls */}
                    {isEditing && item.variant_id && (
                      <div className="mt-3 space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/30">
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-zinc-500">Qty:</label>
                          <select
                            value={editQuantity}
                            onChange={e => setEditQuantity(parseInt(e.target.value))}
                            className="w-16 rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          >
                            {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                          <button
                            onClick={() => doUpdateItem(item.variant_id!)}
                            disabled={editQuantity === (item.quantity || 1) || acting === "update_item"}
                            className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
                          >
                            Update Qty
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-zinc-500">Swap:</label>
                          <select
                            value={swapVariantId}
                            onChange={e => setSwapVariantId(e.target.value)}
                            className="flex-1 rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          >
                            <option value="">Select replacement...</option>
                            {variantOptions.map(v => (
                              <option key={v.value} value={v.value}>{v.label}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => doUpdateItem(item.variant_id!)}
                            disabled={!swapVariantId || acting === "update_item"}
                            className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
                          >
                            Swap
                          </button>
                        </div>
                        {items.length > 1 && (
                          <button
                            onClick={() => doRemoveItem(item.variant_id!)}
                            disabled={acting === "remove_item"}
                            className="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400"
                          >
                            {acting === "remove_item" ? "Removing..." : "Remove Item"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Recovery Section */}
          {(activeDunning || dunningCycles.length > 0) && (
            <div className={`rounded-lg border p-5 ${activeDunning ? "border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/30" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"}`}>
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Payment Recovery</h3>
              {activeDunning && (
                <div className="mb-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-amber-700 dark:text-amber-400">Cycle {activeDunning.cycle_number} — {activeDunning.status}</span>
                  </div>
                  <div className="text-xs text-zinc-500">
                    <p>Cards tried: {activeDunning.cards_tried?.length || 0}</p>
                    <p>Payment update sent: {activeDunning.payment_update_sent ? `Yes (${formatDate(activeDunning.payment_update_sent_at)})` : "No"}</p>
                    {activeDunning.skipped_at && <p>Order skipped: {formatDate(activeDunning.skipped_at)}</p>}
                    {activeDunning.paused_at && <p>Subscription paused: {formatDate(activeDunning.paused_at)}</p>}
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button onClick={doPaymentUpdate} disabled={acting === "payment_update"}
                      className="rounded-md border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:text-amber-400">
                      {acting === "payment_update" ? "Sending..." : "Send Payment Update Email"}
                    </button>
                  </div>
                </div>
              )}
              {paymentFailures.length > 0 && (
                <div className="space-y-1.5">
                  <p className="mb-1 text-xs font-medium text-zinc-500">Payment Attempts</p>
                  {paymentFailures.slice(0, 10).map(pf => (
                    <div key={pf.id} className="flex items-center gap-2 text-xs">
                      <span className={`h-1.5 w-1.5 rounded-full ${pf.succeeded ? "bg-emerald-500" : "bg-red-500"}`} />
                      <span className="text-zinc-600 dark:text-zinc-400">{pf.attempt_type}</span>
                      {pf.payment_method_last4 && <span className="text-zinc-400">*{pf.payment_method_last4}</span>}
                      <span className={pf.succeeded ? "text-emerald-600" : "text-red-600"}>{pf.succeeded ? "Success" : "Failed"}</span>
                      <span className="text-zinc-300 dark:text-zinc-600">{new Date(pf.created_at).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Applied Discounts */}
          {(() => {
            const discounts = (sub.applied_discounts as { id: string; type: string; title: string; value: number; valueType: string }[] | null) || [];
            return discounts.length > 0 ? (
              <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Applied Discounts ({discounts.length})</h3>
                <div className="space-y-2">
                  {discounts.map((d) => (
                    <div key={d.id} className="flex items-center justify-between rounded-md border border-zinc-100 px-3 py-2 dark:border-zinc-800">
                      <div>
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{d.title}</span>
                        <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                          {d.value}{d.valueType === "PERCENTAGE" ? "%" : ""} off
                        </span>
                        <span className="ml-2 text-xs text-zinc-400">{d.type === "CODE_DISCOUNT" ? "Code" : d.type === "MANUAL" ? "Manual" : d.type}</span>
                      </div>
                      <button
                        onClick={async () => {
                          if (!confirm(`Remove discount "${d.title}"?`)) return;
                          const res = await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}/coupon`, {
                            method: "DELETE",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ discountId: d.id }),
                          });
                          if (res.ok) loadSub();
                        }}
                        className="rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
          })()}

          {/* Order History */}
          <OrdersTable
            orders={orders as OrderRow[]}
            title="Order History"
            showCount
            cardWrapper
            detailTextSize="xs"
          />

          {/* Returns */}
          {subReturns.length > 0 && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Returns ({subReturns.length})</h3>
              <ReturnsList returns={subReturns} variant="bare" />
            </div>
          )}

          {/* Replacements */}
          {subReplacements.length > 0 && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Replacements ({subReplacements.length})</h3>
              <ReplacementsList replacements={subReplacements} compact />
            </div>
          )}

          {/* Activity Timeline */}
          {events.length > 0 && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Activity</h3>
              <div className="space-y-0">
                {events.map((evt, idx) => {
                  const iconInfo = EVENT_ICONS[evt.event_type] || { icon: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z", color: "text-zinc-400" };
                  return (
                    <div key={evt.id} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 ${iconInfo.color}`}>
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d={iconInfo.icon} />
                          </svg>
                        </div>
                        {idx < events.length - 1 && <div className="w-px flex-1 bg-zinc-200 dark:bg-zinc-700" />}
                      </div>
                      <div className="pb-4">
                        <p className="text-sm text-zinc-700 dark:text-zinc-300">{evt.summary || evt.event_type}</p>
                        <p className="mt-0.5 text-xs text-zinc-400">
                          {new Date(evt.created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                          {evt.source && <> · <span className="capitalize">{evt.source}</span></>}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right: Actions */}
        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Actions</h3>
            <div className="space-y-2">
              {sub.status === "active" && (
                <button onClick={() => { if (confirm("Pause subscription?")) doAction("pause"); }} disabled={!!acting}
                  className="w-full rounded-md border border-amber-300 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:text-amber-400">
                  {acting === "pause" ? "Pausing..." : "Pause subscription"}
                </button>
              )}
              {sub.status === "paused" && (
                <button onClick={() => doAction("resume")} disabled={!!acting}
                  className="w-full rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50">
                  {acting === "resume" ? "Resuming..." : "Resume subscription"}
                </button>
              )}

              {sub.status !== "cancelled" && (
                <>
                  {!showCancel ? (
                    <button onClick={() => setShowCancel(true)}
                      className="w-full rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400">
                      Cancel subscription
                    </button>
                  ) : (
                    <div className="rounded-md border border-red-200 p-3 dark:border-red-900">
                      <input type="text" value={cancelReason} onChange={e => setCancelReason(e.target.value)}
                        placeholder="Cancellation reason..."
                        className="mb-2 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
                      <div className="flex gap-2">
                        <button onClick={() => doAction("cancel", { reason: cancelReason })} disabled={!!acting}
                          className="flex-1 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                          {acting === "cancel" ? "Cancelling..." : "Confirm Cancel"}
                        </button>
                        <button onClick={() => setShowCancel(false)} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">Back</button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {sub.status === "active" && (
                <button onClick={() => { if (confirm("Skip next order?")) doAction("skip"); }} disabled={!!acting}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400">
                  {acting === "skip" ? "Skipping..." : "Skip next order"}
                </button>
              )}

              {sub.status === "active" && (
                <button onClick={doBillNow} disabled={!!acting}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400">
                  {acting === "bill_now" ? "Processing..." : "Process payment now"}
                </button>
              )}

              {/* Store Credit */}
              {["owner", "admin"].includes(workspace.role) && (
                <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="text-zinc-500">Store Credit</span>
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">
                      {storeCreditBalance !== null ? (storeCreditBalance > 0 ? `$${storeCreditBalance.toFixed(2)}` : "None") : "..."}
                    </span>
                  </div>
                  <button
                    onClick={() => setShowStoreCreditModal(true)}
                    className="w-full rounded-md border border-indigo-300 px-4 py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-950"
                  >
                    Manage store credit
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Frequency */}
          {sub.status === "active" && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Change delivery frequency</h3>
              <div className="flex gap-2">
                <select value={frequencyInterval} onChange={e => setFrequencyInterval(e.target.value)}
                  className="flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  <option value="MONTH">Month</option>
                  <option value="WEEK">Week</option>
                </select>
                <select value={frequencyCount} onChange={e => setFrequencyCount(parseInt(e.target.value))}
                  className="w-16 rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {[1, 2, 3, 4, 6].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <button onClick={() => doAction("change_frequency", { interval: frequencyInterval, intervalCount: frequencyCount })} disabled={!!acting}
                className="mt-2 w-full rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
                {acting === "change_frequency" ? "Saving..." : "Update Frequency"}
              </button>
            </div>
          )}

          {/* Next Order Date */}
          {sub.status === "active" && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Change next order date</h3>
              <input type="date" value={nextDate} onChange={e => setNextDate(e.target.value)}
                min={new Date(Date.now() + 86400000).toISOString().split("T")[0]}
                max={new Date(Date.now() + 60 * 86400000).toISOString().split("T")[0]}
                className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
              <button onClick={() => { if (nextDate) doAction("change_date", { nextBillingDate: nextDate }); }} disabled={!!acting || !nextDate}
                className="mt-2 w-full rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
                {acting === "change_date" ? "Saving..." : "Update Date"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Chargebacks */}
      {chargebacks.length > 0 && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Chargebacks</h3>
          <ChargebacksList chargebacks={chargebacks} />
        </div>
      )}

      {/* Fraud Cases */}
      {fraudCases.length > 0 && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Fraud Cases</h3>
          <FraudCasesList cases={fraudCases} />
        </div>
      )}

      {/* Store Credit Modal */}
      {showStoreCreditModal && sub && (
        <StoreCreditModal
          customerId={sub.customer_id}
          currentBalance={storeCreditBalance ?? 0}
          subscriptionId={sub.id}
          onClose={() => setShowStoreCreditModal(false)}
          onSuccess={(newBalance) => {
            setStoreCreditBalance(newBalance);
            setShowStoreCreditModal(false);
          }}
        />
      )}
    </div>
  );
}
