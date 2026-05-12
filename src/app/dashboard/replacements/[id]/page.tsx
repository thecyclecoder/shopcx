"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface ReplacementDetail {
  id: string;
  original_order_number: string | null;
  original_order_id: string | null;
  shopify_draft_order_id: string | null;
  shopify_replacement_order_id: string | null;
  shopify_replacement_order_name: string | null;
  reason: string;
  reason_detail: string | null;
  status: string;
  customer_error: boolean;
  items: { title: string; variantId: string; quantity: number; type?: string }[] | null;
  address_validated: boolean;
  validated_address: {
    street1: string; street2?: string; city: string; state: string; zip: string; country: string; phone?: string;
  } | null;
  subscription_id: string | null;
  subscription_adjusted: boolean;
  new_next_billing_date: string | null;
  ticket_id: string | null;
  created_at: string;
  updated_at: string;
  customers: {
    id: string; first_name: string; last_name: string; email: string; phone: string | null;
  } | null;
}

const REASON_LABELS: Record<string, string> = {
  delivery_error: "Delivery Error",
  missing_items: "Missing Items",
  damaged_items: "Damaged Items",
  wrong_address: "Wrong Address",
  carrier_lost: "Carrier Lost",
  not_received: "Not Received",
  refused: "Refused",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  address_confirmed: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  created: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  shipped: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  completed: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  denied: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

function formatDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function ReplacementDetailPage() {
  const workspace = useWorkspace();
  const params = useParams();
  const router = useRouter();
  const replacementId = params.id as string;

  const [replacement, setReplacement] = useState<ReplacementDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/replacements/${replacementId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { setReplacement(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [workspace.id, replacementId]);

  const handleAction = async (action: string) => {
    setActionLoading(action);
    setMessage("");
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/replacements/${replacementId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(action === "create-draft"
          ? `Replacement order ${data.order_name} created`
          : `Subscription adjusted — next billing: ${data.new_next_billing_date}`);
        // Reload
        const res2 = await fetch(`/api/workspaces/${workspace.id}/replacements/${replacementId}`);
        if (res2.ok) setReplacement(await res2.json());
      } else {
        setMessage(data.error || "Action failed");
      }
    } catch {
      setMessage("Action failed");
    }
    setActionLoading(null);
  };

  const handleStatusUpdate = async (status: string) => {
    const res = await fetch(`/api/workspaces/${workspace.id}/replacements/${replacementId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      setReplacement(await res.json());
      setMessage(`Status updated to ${status}`);
    }
  };

  if (loading) return <div className="p-8 text-center text-zinc-400">Loading...</div>;
  if (!replacement) return <div className="p-8 text-center text-zinc-400">Replacement not found</div>;

  const r = replacement;

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <button onClick={() => router.push("/dashboard/replacements")} className="mb-2 text-sm text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
            &larr; Back to Replacements
          </button>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Replacement for {r.original_order_number || "—"}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Created {formatDate(r.created_at)}</p>
        </div>
        <div className="flex items-center gap-2">
          {r.items?.every(i => (i as { type?: string }).type === "all") ? (
            <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">Full</span>
          ) : (
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Partial</span>
          )}
          <span className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[r.status] || STATUS_COLORS.pending}`}>
            {r.status.replace("_", " ")}
          </span>
        </div>
      </div>

      {message && (
        <div className={`mb-4 rounded-md px-4 py-3 text-sm ${message.includes("fail") || message.includes("error") ? "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400" : "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"}`}>
          {message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main content */}
        <div className="space-y-6 lg:col-span-2">
          {/* Reason */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Reason</h2>
            <div className="flex items-center gap-3">
              <span className="text-sm text-zinc-700 dark:text-zinc-300">{REASON_LABELS[r.reason] || r.reason}</span>
              {r.customer_error && (
                <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600 dark:bg-amber-900/20 dark:text-amber-400">
                  Customer Error
                </span>
              )}
            </div>
            {r.reason_detail && <p className="mt-1 text-sm text-zinc-500">{r.reason_detail}</p>}
          </div>

          {/* Items */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Replacement Items</h2>
            {r.items?.length ? (
              <div className="space-y-2">
                {r.items.map((item, i) => (
                  <div key={i} className="flex items-center justify-between rounded-md border border-zinc-100 px-3 py-2 dark:border-zinc-800">
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">{item.title}</span>
                    <div className="flex items-center gap-3">
                      {item.type && (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${item.type === "damaged" ? "bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400" : "bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400"}`}>
                          {item.type}
                        </span>
                      )}
                      <span className="text-sm font-medium text-zinc-500">x{item.quantity}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-400">No items specified yet</p>
            )}
          </div>

          {/* Shipping Address */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Shipping Address</h2>
              {r.address_validated && (
                <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/20 dark:text-green-400">
                  Verified
                </span>
              )}
            </div>
            {r.validated_address ? (
              <div className="text-sm text-zinc-600 dark:text-zinc-400">
                <p>{r.validated_address.street1}</p>
                {r.validated_address.street2 && <p>{r.validated_address.street2}</p>}
                <p>{r.validated_address.city}, {r.validated_address.state} {r.validated_address.zip}</p>
                <p>{r.validated_address.country}</p>
              </div>
            ) : (
              <p className="text-sm text-zinc-400">Address not yet confirmed</p>
            )}
          </div>

          {/* Replacement Order */}
          {r.shopify_replacement_order_name && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Replacement Order</h2>
              <div className="flex items-center gap-4">
                <span className="font-mono text-lg font-bold text-zinc-900 dark:text-zinc-100">{r.shopify_replacement_order_name}</span>
                <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-400">
                  $0.00
                </span>
              </div>
            </div>
          )}

          {/* Subscription Adjustment */}
          {r.subscription_id && (() => {
            const isFullReplacement = r.items?.every(i => (i as { type?: string }).type === "all") ?? false;
            return (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Subscription</h2>
                {r.subscription_adjusted ? (
                  <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/20 dark:text-green-400">
                    Adjusted
                  </span>
                ) : isFullReplacement ? (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                    Needs adjustment
                  </span>
                ) : (
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    No adjustment needed
                  </span>
                )}
              </div>
              {r.new_next_billing_date && (
                <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                  Next billing date moved to: <span className="font-medium">{formatDate(r.new_next_billing_date)}</span>
                </p>
              )}
              {!r.subscription_adjusted && r.status === "created" && isFullReplacement && (
                <button
                  onClick={() => handleAction("adjust-subscription")}
                  disabled={!!actionLoading}
                  className="mt-3 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {actionLoading === "adjust-subscription" ? "Adjusting..." : "Adjust Next Billing Date"}
                </button>
              )}
            </div>
            );
          })()}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Customer */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Customer</h2>
            {r.customers ? (
              <div>
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {r.customers.first_name} {r.customers.last_name}
                </p>
                <p className="text-xs text-zinc-500">{r.customers.email}</p>
                {r.customers.phone && <p className="text-xs text-zinc-500">{r.customers.phone}</p>}
                <button
                  onClick={() => router.push(`/dashboard/customers/${r.customers!.id}`)}
                  className="mt-2 text-xs text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                >
                  View profile &rarr;
                </button>
              </div>
            ) : (
              <p className="text-sm text-zinc-400">No customer linked</p>
            )}
          </div>

          {/* Links */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Links</h2>
            <div className="space-y-2 text-sm">
              {r.original_order_number && (
                <button
                  onClick={() => router.push(`/dashboard/orders?search=${r.original_order_number}`)}
                  className="block text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                >
                  Original order: {r.original_order_number}
                </button>
              )}
              {r.ticket_id && (
                <button
                  onClick={() => router.push(`/dashboard/tickets/${r.ticket_id}`)}
                  className="block text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                >
                  View ticket &rarr;
                </button>
              )}
              {r.subscription_id && (
                <button
                  onClick={() => router.push(`/dashboard/subscriptions/${r.subscription_id}`)}
                  className="block text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                >
                  View subscription &rarr;
                </button>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Actions</h2>
            <div className="space-y-2">
              {r.status === "address_confirmed" && r.items?.length && (
                <button
                  onClick={() => handleAction("create-draft")}
                  disabled={!!actionLoading}
                  className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {actionLoading === "create-draft" ? "Creating..." : "Create Replacement Order"}
                </button>
              )}

              {r.status === "created" && (
                <button
                  onClick={() => handleStatusUpdate("shipped")}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Mark as Shipped
                </button>
              )}

              {r.status === "shipped" && (
                <button
                  onClick={() => handleStatusUpdate("completed")}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Mark as Completed
                </button>
              )}

              {(r.status === "pending" || r.status === "address_confirmed") && (
                <button
                  onClick={() => handleStatusUpdate("denied")}
                  className="w-full rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                >
                  Deny Replacement
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
