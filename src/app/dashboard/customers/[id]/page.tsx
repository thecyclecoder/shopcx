"use client";

import React, { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import StoreCreditModal from "@/components/store-credit-modal";
import ReturnsList from "@/components/shared/ReturnsList";
import OrdersTable from "@/components/shared/OrdersTable";
import { formatCents, formatDate } from "@/components/shared/format-utils";
import type { OrderRow } from "@/components/shared/OrdersTable";

interface Customer {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  retention_score: number;
  subscription_status: string;
  email_marketing_status: string | null;
  sms_marketing_status: string | null;
  total_orders: number;
  ltv_cents: number;
  first_order_at: string | null;
  last_order_at: string | null;
  tags: string[];
  default_address: { address1?: string; address2?: string; city?: string; province?: string; provinceCode?: string; country?: string; countryCodeV2?: string; zip?: string } | null;
  addresses: { address1?: string; city?: string; province?: string; country?: string; zip?: string }[];
  note: string | null;
  locale: string | null;
  shopify_created_at: string | null;
  created_at: string;
}

interface PaymentMethod {
  type: string;
  brand?: string;
  last_digits?: string;
  expiry?: string;
  email?: string | null;
}

interface OrderLineItem {
  title: string;
  quantity: number;
  price_cents: number;
  sku: string | null;
}

interface TrackingInfo {
  number: string;
  url: string | null;
  company: string | null;
}

interface Fulfillment {
  trackingInfo: TrackingInfo[];
  status: string | null;
  createdAt: string | null;
}

interface Order {
  id: string;
  order_number: string | null;
  email: string | null;
  total_cents: number;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  source_name: string | null;
  order_type: string | null;
  tags: string | null;
  line_items: OrderLineItem[];
  fulfillments: Fulfillment[];
  created_at: string;
}

interface SubscriptionItem {
  title: string | null;
  sku: string | null;
  quantity: number;
  price_cents: number;
  selling_plan: string | null;
}

interface Subscription {
  id: string;
  shopify_contract_id?: string;
  status: string;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  last_payment_status: string | null;
  items: SubscriptionItem[];
  delivery_price_cents: number;
  created_at: string;
  updated_at: string;
}

/* formatCents, formatDate imported from @/components/shared */

function RetentionBadge({ score }: { score: number }) {
  let classes: string;
  if (score > 70) {
    classes =
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400";
  } else if (score >= 40) {
    classes =
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
  } else {
    classes =
      "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${classes}`}
    >
      {score}/100
    </span>
  );
}

interface CustomerEvent {
  id: string;
  event_type: string;
  source: string;
  summary: string | null;
  properties: Record<string, unknown>;
  created_at: string;
}

const EVENT_ICONS: Record<string, { icon: string; color: string }> = {
  "order.created": { icon: "M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z", color: "text-emerald-500" },
  "customer.updated": { icon: "M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0", color: "text-blue-500" },
  "ticket.created": { icon: "M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75", color: "text-indigo-500" },
  "subscription.created": { icon: "M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3", color: "text-violet-500" },
  "subscription.cancelled": { icon: "M6 18L18 6M6 6l12 12", color: "text-red-500" },
  "subscription.paused": { icon: "M15.75 5.25v13.5m-7.5-13.5v13.5", color: "text-amber-500" },
  "subscription.activated": { icon: "M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z", color: "text-emerald-500" },
  "subscription.billing-failure": { icon: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z", color: "text-red-500" },
  "subscription.billing-skipped": { icon: "M3 8.688c0-.864.933-1.405 1.683-.977l7.108 4.062a1.125 1.125 0 010 1.953l-7.108 4.062A1.125 1.125 0 013 16.81V8.688zM12.75 8.688c0-.864.933-1.405 1.683-.977l7.108 4.062a1.125 1.125 0 010 1.953l-7.108 4.062a1.125 1.125 0 01-1.683-.977V8.688z", color: "text-amber-500" },
  "subscription.billing-success": { icon: "M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z", color: "text-emerald-500" },
};

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const workspace = useWorkspace();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [customerTickets, setCustomerTickets] = useState<{ id: string; subject: string | null; status: string; channel: string; tags: string[]; created_at: string; last_customer_reply_at: string | null }[]>([]);
  const [linkedIdentities, setLinkedIdentities] = useState<{ id: string; email: string; first_name: string | null; last_name: string | null; is_primary: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // selectedOrderId now managed internally by OrdersTable
  const [linkEmail, setLinkEmail] = useState("");
  const [linkMessage, setLinkMessage] = useState("");
  const [suggestions, setSuggestions] = useState<{ id: string; email: string; first_name: string | null; last_name: string | null; phone: string | null; match_reason: string }[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [events, setEvents] = useState<CustomerEvent[]>([]);
  const [isPrimary, setIsPrimary] = useState(true);
  const [primaryCustomer, setPrimaryCustomer] = useState<{ id: string; email: string; first_name: string | null; last_name: string | null } | null>(null);
  const [reviews, setReviews] = useState<{ id: string; rating: number | null; title: string | null; body: string | null; review_type: string; status: string; featured: boolean; product_name: string | null; published_at: string | null }[]>([]);
  const [storeCreditBalance, setStoreCreditBalance] = useState<number | null>(null);
  const [showStoreCreditModal, setShowStoreCreditModal] = useState(false);
  const [storeCreditHistory, setStoreCreditHistory] = useState<{ id: string; type: string; amount: number; reason: string | null; issued_by_name: string; balance_after: number | null; created_at: string; ticket_id: string | null }[]>([]);
  const [showCreditHistory, setShowCreditHistory] = useState(false);
  const [loyaltyMember, setLoyaltyMember] = useState<{ id: string; points_balance: number; points_earned: number; points_spent: number } | null>(null);
  const [loyaltyTiers, setLoyaltyTiers] = useState<{ label: string; points_cost: number; discount_value: number; affordable: boolean }[]>([]);
  const [loyaltyRedeeming, setLoyaltyRedeeming] = useState(false);
  const [loyaltyRedeemTier, setLoyaltyRedeemTier] = useState("");
  const [loyaltyResult, setLoyaltyResult] = useState<{ code: string; value: number } | null>(null);
  const [customerReturns, setCustomerReturns] = useState<{ id: string; order_number: string; status: string; resolution_type: string; net_refund_cents: number; created_at: string }[]>([]);

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/customers/${id}`);
      if (!res.ok) {
        setError("Customer not found");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setCustomer(data.customer);
      setOrders(data.orders);
      setSubscriptions(data.subscriptions || []);
      setCustomerTickets(data.tickets || []);
      setLinkedIdentities(data.linked_identities || []);
      setReviews(data.reviews || []);
      setIsPrimary(data.is_primary ?? true);
      setPrimaryCustomer(data.primary_customer || null);
      setLoading(false);

      // Auto-enrich if missing personalization
      if (data.customer && !data.customer.first_name) {
        fetch(`/api/customers/${id}/enrich`, { method: "POST" })
          .then((r) => r.json())
          .then((enriched) => {
            if (enriched.enriched && enriched.customer) {
              setCustomer(enriched.customer);
            }
          })
          .catch(() => {});
      }

      // Load link suggestions + payment methods
      fetch(`/api/customers/${id}/suggestions`)
        .then((r) => r.json())
        .then((s) => setSuggestions(s.suggestions || []));
      fetch(`/api/customers/${id}/payment-methods`)
        .then((r) => r.json())
        .then((p) => setPaymentMethods(p.payment_methods || []));
      fetch(`/api/customers/${id}/events`)
        .then((r) => r.json())
        .then((e) => { if (Array.isArray(e)) setEvents(e); });
      fetch(`/api/store-credit/balance?customerId=${id}`)
        .then(r => r.json())
        .then(b => setStoreCreditBalance(b.balance ?? 0))
        .catch(() => setStoreCreditBalance(0));
      fetch(`/api/store-credit/history?customerId=${id}`)
        .then(r => r.json())
        .then(h => setStoreCreditHistory(h.history || []))
        .catch(() => {});
      // Returns
      fetch(`/api/workspaces/${workspace.id}/returns?customer_id=${id}&limit=50`)
        .then(r => r.json())
        .then(d => setCustomerReturns(d.returns || []))
        .catch(() => {});
      // Loyalty
      fetch(`/api/loyalty/members?workspace_id=${workspace.id}&customer_id=${id}`)
        .then(r => r.json())
        .then(d => {
          if (d.members?.[0]) setLoyaltyMember(d.members[0]);
        })
        .catch(() => {});
      fetch(`/api/workspaces/${workspace.id}/loyalty`)
        .then(r => r.json())
        .then(d => {
          if (d.redemption_tiers) setLoyaltyTiers(d.redemption_tiers);
        })
        .catch(() => {});
    }
    load();
  }, [id]);

  const handleLinkById = async (targetId: string, targetEmail: string, targetFirst: string | null, targetLast: string | null) => {
    setLinkMessage("");
    const res = await fetch(`/api/customers/${id}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link_to: targetId }),
    });

    if (res.ok) {
      setLinkedIdentities((prev) => [...prev, { id: targetId, email: targetEmail, first_name: targetFirst, last_name: targetLast, is_primary: false }]);
      setSuggestions((prev) => prev.filter((s) => s.id !== targetId));
      setLinkMessage("Linked!");
    } else {
      const data = await res.json();
      setLinkMessage(data.error || "Failed to link");
    }
  };

  const handleLink = async () => {
    if (!linkEmail.trim()) return;
    setLinkMessage("");

    const searchRes = await fetch(`/api/customers?search=${encodeURIComponent(linkEmail)}&limit=1`);
    const searchData = await searchRes.json();
    const target = searchData.customers?.[0];

    if (!target) {
      setLinkMessage("No customer found with that email");
      return;
    }
    if (target.id === id) {
      setLinkMessage("That's this customer");
      return;
    }

    await handleLinkById(target.id, target.email, target.first_name, target.last_name);
    setLinkEmail("");
  };

  const handleUnlink = async (unlinkId: string) => {
    const res = await fetch(`/api/customers/${id}/links?unlink_id=${unlinkId}`, { method: "DELETE" });
    if (res.ok) {
      setLinkedIdentities((prev) => prev.filter((l) => l.id !== unlinkId));
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-sm text-zinc-400">{error || "Customer not found"}</p>
        <button
          onClick={() => router.push("/dashboard/customers")}
          className="mt-4 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Back to customers
        </button>
      </div>
    );
  }

  const displayName =
    [customer.first_name, customer.last_name].filter(Boolean).join(" ") ||
    customer.email;

  return (
    <div className="p-8">
      {/* Back button */}
      <button
        onClick={() => router.push("/dashboard/customers")}
        className="mb-6 flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 19.5L8.25 12l7.5-7.5"
          />
        </svg>
        Back to customers
      </button>

      {/* Linked profile banner for secondary profiles */}
      {!isPrimary && primaryCustomer && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 dark:border-indigo-800 dark:bg-indigo-950">
          <svg className="h-4 w-4 flex-shrink-0 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.502a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.34 8.374" />
          </svg>
          <p className="text-sm text-indigo-700 dark:text-indigo-300">
            Secondary profile — linked to{" "}
            <button
              onClick={() => router.push(`/dashboard/customers/${primaryCustomer.id}`)}
              className="font-medium underline hover:text-indigo-900 dark:hover:text-indigo-100"
            >
              {[primaryCustomer.first_name, primaryCustomer.last_name].filter(Boolean).join(" ") || primaryCustomer.email}
            </button>
          </p>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            {displayName}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">{customer.email}</p>
          {customer.phone && (
            <p className="mt-0.5 text-sm text-zinc-400">{customer.phone}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <RetentionBadge score={customer.retention_score} />
          {["owner", "admin"].includes(workspace.role) && (
            <button
              onClick={() => setShowStoreCreditModal(true)}
              className="rounded-md border border-indigo-300 px-3 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-950"
            >
              Manage store credit
            </button>
          )}
        </div>
      </div>

      {/* Stats cards */}
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium uppercase text-zinc-500">LTV</p>
          <p className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {formatCents(customer.ltv_cents)}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium uppercase text-zinc-500">Total Orders</p>
          <p className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {customer.total_orders}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium uppercase text-zinc-500">Subscription</p>
          <p className="mt-1 text-xl font-semibold capitalize text-zinc-900 dark:text-zinc-100">
            {customer.subscription_status}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium uppercase text-zinc-500">Store Credit</p>
          <p className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {storeCreditBalance !== null ? (storeCreditBalance > 0 ? `$${storeCreditBalance.toFixed(2)}` : "$0") : "..."}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium uppercase text-zinc-500">Customer Since</p>
          <p className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {formatDate(customer.shopify_created_at || customer.first_order_at || customer.created_at)}
          </p>
        </div>
      </div>

      {/* Contact & Marketing */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Contact */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium uppercase text-zinc-500">Contact</p>
          <div className="mt-2 space-y-1.5 text-sm text-zinc-700 dark:text-zinc-300">
            <p>{customer.email}</p>
            {customer.phone && <p>{customer.phone}</p>}
            {customer.default_address && (
              <p className="text-sm text-zinc-400">
                {[customer.default_address.city, customer.default_address.province, customer.default_address.countryCodeV2].filter(Boolean).join(", ")}
                {customer.default_address.zip && ` ${customer.default_address.zip}`}
              </p>
            )}
            {customer.locale && (
              <p className="text-sm text-zinc-400">Locale: {customer.locale}</p>
            )}
          </div>
        </div>

        {/* Marketing */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium uppercase text-zinc-500">Marketing</p>
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full ${customer.email_marketing_status === "subscribed" ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                Email: <span className="capitalize">{customer.email_marketing_status?.replace("_", " ") || "Unknown"}</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full ${customer.sms_marketing_status === "subscribed" ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                SMS: <span className="capitalize">{customer.sms_marketing_status?.replace("_", " ") || "Unknown"}</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Payment Methods (live from Shopify) */}
      {paymentMethods.length > 0 && (
        <div className="mt-6">
          <p className="text-sm font-medium uppercase text-zinc-500">Payment Methods</p>
          <div className="mt-2 space-y-1.5">
            {paymentMethods.map((pm, i) => (
              <div key={i} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                {pm.type === "credit_card" && (
                  <>
                    <span className="capitalize">{pm.brand}</span>
                    <span className="text-zinc-400">****{pm.last_digits}</span>
                    <span className="text-sm text-zinc-400">exp {pm.expiry}</span>
                  </>
                )}
                {pm.type === "shop_pay" && (
                  <>
                    <span>Shop Pay</span>
                    <span className="text-zinc-400">****{pm.last_digits}</span>
                    <span className="text-sm text-zinc-400">exp {pm.expiry}</span>
                  </>
                )}
                {pm.type === "paypal" && (
                  <span>PayPal{pm.email ? ` (${pm.email})` : ""}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Addresses */}
      {customer.addresses && customer.addresses.length > 0 && (
        <div className="mt-6">
          <p className="text-sm font-medium uppercase text-zinc-500">Addresses</p>
          <div className="mt-2 space-y-2">
            {customer.addresses.map((addr, i) => (
              <div key={i} className="rounded border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                {addr.address1 && <p>{addr.address1}</p>}
                <p>{[addr.city, addr.province, addr.zip].filter(Boolean).join(", ")}</p>
                {addr.country && <p>{addr.country}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Note */}
      {customer.note && (
        <div className="mt-6">
          <p className="text-sm font-medium uppercase text-zinc-500">Note</p>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{customer.note}</p>
        </div>
      )}

      {/* Tags */}
      {customer.tags && customer.tags.length > 0 && (
        <div className="mt-6">
          <p className="text-sm font-medium uppercase text-zinc-500">Tags</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {customer.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-sm font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Linked Identities */}
      <div className="mt-6">
        <p className="text-sm font-medium uppercase text-zinc-500">
          Linked Identities{linkedIdentities.length > 0 && <span className="ml-1 normal-case text-indigo-500">({linkedIdentities.length})</span>}
        </p>

        {linkedIdentities.length === 0 && suggestions.length === 0 && (
          <p className="mt-2 text-sm text-zinc-400">No linked accounts.</p>
        )}

        {linkedIdentities.length > 0 && (
          <div className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {linkedIdentities.map((li) => (
              <div key={li.id} className="flex items-center justify-between px-3 py-2">
                <button
                  onClick={() => router.push(`/dashboard/customers/${li.id}`)}
                  className="text-left"
                >
                  <span className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
                    {li.email}
                  </span>
                  {(li.first_name || li.last_name) && (
                    <span className="ml-2 text-sm text-zinc-400">
                      {[li.first_name, li.last_name].filter(Boolean).join(" ")}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => handleUnlink(li.id)}
                  className="text-sm text-zinc-400 hover:text-red-500"
                >
                  Unlink
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            value={linkEmail}
            onChange={(e) => setLinkEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLink()}
            placeholder="Link by email..."
            className="block flex-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <button
            onClick={handleLink}
            disabled={!linkEmail.trim()}
            className="cursor-pointer rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Link
          </button>
        </div>
        {linkMessage && (
          <p className="mt-1 text-sm text-indigo-600 dark:text-indigo-400">{linkMessage}</p>
        )}

        {/* Auto-suggested matches */}
        {suggestions.length > 0 && (
          <div className="mt-3">
            <p className="text-sm font-medium uppercase tracking-wider text-zinc-400">Possible Matches</p>
            <div className="mt-1.5 divide-y divide-zinc-200 rounded-lg border border-amber-200 bg-amber-50 dark:divide-zinc-700 dark:border-amber-800 dark:bg-amber-950">
              {suggestions.map((s) => (
                <div key={s.id} className="flex items-center justify-between px-3 py-2">
                  <div>
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{s.email}</span>
                    {(s.first_name || s.last_name) && (
                      <span className="ml-1.5 text-sm text-zinc-500">
                        {[s.first_name, s.last_name].filter(Boolean).join(" ")}
                      </span>
                    )}
                    <span className="ml-1.5 rounded bg-amber-200 px-1 py-0.5 text-sm font-medium text-amber-700 dark:bg-amber-800 dark:text-amber-300">
                      {s.match_reason}
                    </span>
                  </div>
                  <button
                    onClick={() => handleLinkById(s.id, s.email, s.first_name, s.last_name)}
                    className="cursor-pointer rounded-md border border-indigo-300 px-2 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-950"
                  >
                    Link
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Tickets */}
      {customerTickets.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Tickets ({customerTickets.length})
          </h2>
          <div className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {customerTickets.map((t) => (
              <button
                key={t.id}
                onClick={() => router.push(`/dashboard/tickets/${t.id}`)}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${
                      t.status === "open" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                      : t.status === "pending" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                      : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}>
                      {t.status}
                    </span>
                    <span className="truncate text-sm text-zinc-900 dark:text-zinc-100">{t.subject || "(no subject)"}</span>
                  </div>
                  {t.tags?.length > 0 && (
                    <div className="mt-0.5 flex gap-1">
                      {t.tags.slice(0, 3).map(tag => {
                        const isSmart = tag.startsWith("smart:");
                        return (
                          <span key={tag} className={`rounded px-1 py-0.5 text-sm font-medium ${isSmart ? "bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400" : "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400"}`}>{tag}</span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <span className="ml-2 shrink-0 text-sm text-zinc-400">{formatDate(t.created_at)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Returns */}
      {customerReturns.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Returns ({customerReturns.length})
          </h2>
          <div className="mt-3">
            <ReturnsList returns={customerReturns} variant="full" showDate />
          </div>
        </div>
      )}

      {/* Loyalty */}
      {loyaltyMember && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <button
            onClick={() => router.push(`/dashboard/loyalty/${(loyaltyMember as Record<string, unknown>).id}`)}
            className="flex w-full items-center justify-between"
          >
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Loyalty Points</h2>
            <svg className="h-4 w-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <div>
              <p className="text-xs text-zinc-400">Balance</p>
              <p className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{loyaltyMember.points_balance.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-400">Earned</p>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{loyaltyMember.points_earned.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-400">Spent</p>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{loyaltyMember.points_spent.toLocaleString()}</p>
            </div>
          </div>
          {loyaltyResult && (
            <div className="mt-3 rounded-md bg-emerald-50 p-3 dark:bg-emerald-900/20">
              <p className="text-sm text-emerald-700 dark:text-emerald-400">Coupon created: <strong>{loyaltyResult.code}</strong> (${loyaltyResult.value} off)</p>
            </div>
          )}
          {loyaltyTiers.length > 0 && (
            <div className="mt-3 flex items-center gap-2">
              <select value={loyaltyRedeemTier} onChange={(e) => setLoyaltyRedeemTier(e.target.value)}
                className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
                <option value="">Redeem points...</option>
                {loyaltyTiers.map((t, i) => {
                  const canAfford = (loyaltyMember?.points_balance || 0) >= t.points_cost;
                  return (
                    <option key={i} value={String(i)} disabled={!canAfford}>
                      {t.label} — {t.points_cost.toLocaleString()} pts{!canAfford ? " (insufficient)" : ""}
                    </option>
                  );
                })}
              </select>
              <button disabled={!loyaltyRedeemTier || loyaltyRedeeming} onClick={async () => {
                setLoyaltyRedeeming(true);
                setLoyaltyResult(null);
                try {
                  const res = await fetch("/api/loyalty/redeem", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ workspace_id: workspace.id, member_id: (loyaltyMember as Record<string, unknown>)?.id, tier_index: parseInt(loyaltyRedeemTier) }),
                  });
                  const data = await res.json();
                  if (data.ok) {
                    setLoyaltyResult({ code: data.code, value: data.discount_value });
                    setLoyaltyMember(prev => prev ? { ...prev, points_balance: data.new_balance, points_spent: prev.points_spent + (loyaltyTiers[parseInt(loyaltyRedeemTier)]?.points_cost || 0) } : prev);
                    setLoyaltyRedeemTier("");
                  }
                } catch {}
                setLoyaltyRedeeming(false);
              }} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
                {loyaltyRedeeming ? "..." : "Redeem"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Subscriptions */}
      {subscriptions.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Subscriptions
          </h2>
          <div className="mt-3 space-y-2">
            {subscriptions.map((sub) => (
              <div key={sub.id}
                onClick={() => router.push(`/dashboard/subscriptions/${sub.id}`)}
                className={`cursor-pointer rounded-lg border p-3 transition-colors hover:border-zinc-300 dark:hover:border-zinc-700 ${
                  sub.last_payment_status === "failed" ? "border-amber-200 bg-amber-50/30 dark:border-amber-800/50 dark:bg-amber-950/20" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
                }`}>
                <div className="flex items-center justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${
                      sub.status === "active" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                      : sub.status === "paused" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                      : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}>
                      {sub.status}
                    </span>
                    {sub.billing_interval && sub.billing_interval_count && (
                      <span className="text-sm text-zinc-500">
                        Every {sub.billing_interval_count} {sub.billing_interval}{sub.billing_interval_count > 1 ? "s" : ""}
                      </span>
                    )}
                    {sub.last_payment_status === "failed" && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">In Recovery</span>
                    )}
                  </div>
                  {sub.last_payment_status && (
                    <span className={`text-sm ${
                      sub.last_payment_status === "succeeded" ? "text-emerald-500"
                      : sub.last_payment_status === "failed" ? "text-red-500"
                      : "text-zinc-400"
                    }`}>
                      {sub.last_payment_status}
                    </span>
                  )}
                </div>
                {sub.items?.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {sub.items.map((item, idx) => (
                      <div key={idx} className="flex justify-between text-sm">
                        <span className="text-zinc-600 dark:text-zinc-400">{item.quantity}x {item.title}</span>
                        <span className="text-zinc-400">{formatCents(item.price_cents * item.quantity)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {sub.next_billing_date && (
                  <p className="mt-1.5 text-sm text-zinc-400">
                    Next billing: {formatDate(sub.next_billing_date)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Orders */}
      <div className="mt-8">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Recent Orders
        </h2>
        <div className="mt-3">
          <OrdersTable orders={orders as OrderRow[]} detailTextSize="sm" />
        </div>
      </div>

      {/* Reviews & Ratings */}
      {reviews.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Reviews &amp; Ratings ({reviews.length})
          </h2>
          <div className="mt-3 space-y-3">
            {reviews.map((rv) => (
              <div key={rv.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center gap-2">
                  <div className="flex gap-0.5">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <svg key={i} className={`h-4 w-4 ${i < (rv.rating || 0) ? "text-yellow-400" : "text-zinc-200 dark:text-zinc-700"}`} fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    ))}
                  </div>
                  {rv.featured && (
                    <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">Featured</span>
                  )}
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    {rv.review_type === "store" ? "Site Review" : rv.review_type === "rating" ? "Rating" : "Product Review"}
                  </span>
                  {rv.product_name && (
                    <span className="text-xs text-zinc-400 truncate">{rv.product_name}</span>
                  )}
                </div>
                {rv.title && <p className="mt-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">{rv.title}</p>}
                {rv.body && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400 line-clamp-3">{rv.body}</p>}
                {rv.published_at && (
                  <p className="mt-1.5 text-xs text-zinc-400">{new Date(rv.published_at).toLocaleDateString()}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timeline */}
      {events.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Timeline</h2>
          <div className="mt-3 space-y-0">
            {events.map((evt, idx) => {
              const iconInfo = EVENT_ICONS[evt.event_type] || { icon: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z", color: "text-zinc-400" };
              return (
                <div key={evt.id} className="flex gap-3">
                  {/* Timeline line + icon */}
                  <div className="flex flex-col items-center">
                    <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 ${iconInfo.color}`}>
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d={iconInfo.icon} />
                      </svg>
                    </div>
                    {idx < events.length - 1 && (
                      <div className="w-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
                    )}
                  </div>
                  {/* Content */}
                  <div className="pb-6">
                    <p className="text-sm text-zinc-900 dark:text-zinc-100">
                      {evt.summary || evt.event_type}
                    </p>
                    <p className="mt-0.5 text-sm text-zinc-400">
                      {new Date(evt.created_at).toLocaleString("en-US", {
                        month: "short", day: "numeric", year: "numeric",
                        hour: "numeric", minute: "2-digit",
                      })}
                      {" · "}
                      <span className="capitalize">{evt.source}</span>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Store Credit History */}
      {storeCreditHistory.length > 0 && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <button
            onClick={() => setShowCreditHistory(!showCreditHistory)}
            className="flex w-full items-center justify-between"
          >
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Store Credit History ({storeCreditHistory.length})
            </h2>
            <svg className={`h-4 w-4 text-zinc-400 transition-transform ${showCreditHistory ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          {showCreditHistory && (
            <div className="mt-3 space-y-2">
              {storeCreditHistory.map((entry) => (
                <div key={entry.id} className="flex items-start justify-between rounded bg-zinc-50 px-3 py-2 dark:bg-zinc-800">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        entry.type === "credit"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                          : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                      }`}>
                        {entry.type === "credit" ? "+" : "-"}${entry.amount.toFixed(2)}
                      </span>
                      <span className="text-xs text-zinc-400">
                        by {entry.issued_by_name}
                      </span>
                    </div>
                    {entry.reason && (
                      <p className="mt-0.5 text-xs text-zinc-500">{entry.reason}</p>
                    )}
                    {entry.ticket_id && (
                      <button
                        onClick={() => router.push(`/dashboard/tickets/${entry.ticket_id}`)}
                        className="mt-0.5 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        View ticket
                      </button>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-zinc-400">
                      {new Date(entry.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </p>
                    {entry.balance_after !== null && (
                      <p className="text-xs text-zinc-500">Bal: ${entry.balance_after.toFixed(2)}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Store Credit Modal */}
      {showStoreCreditModal && (
        <StoreCreditModal
          customerId={id}
          currentBalance={storeCreditBalance ?? 0}
          onClose={() => setShowStoreCreditModal(false)}
          onSuccess={(newBalance) => {
            setStoreCreditBalance(newBalance);
            setShowStoreCreditModal(false);
            // Refresh history
            fetch(`/api/store-credit/history?customerId=${id}`)
              .then(r => r.json())
              .then(h => setStoreCreditHistory(h.history || []))
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}
