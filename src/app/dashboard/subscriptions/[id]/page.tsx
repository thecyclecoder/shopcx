"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

interface SubDetail {
  id: string;
  shopify_contract_id: string;
  status: string;
  items: { title?: string; sku?: string; quantity?: number; price_cents?: number; variant_title?: string; product_id?: string; selling_plan?: string; line_id?: string }[] | null;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  last_payment_status: string | null;
  delivery_price_cents: number | null;
  created_at: string;
  recovery_status: string | null;
  customer_id: string;
  customers: { id: string; email: string; first_name: string | null; last_name: string | null; shopify_customer_id: string | null; retention_score: number | null };
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

interface Order {
  id: string;
  shopify_order_id: string;
  order_number: string | null;
  total_cents: number | null;
  line_items: { title?: string; quantity?: number }[] | null;
  fulfillments: { status?: string }[] | null;
  created_at: string;
}

interface CustomerEvent {
  id: string;
  event_type: string;
  summary: string;
  created_at: string;
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

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string | null): string {
  if (!d) return "--";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatInterval(interval: string | null, count: number | null): string {
  if (!interval) return "--";
  const c = count || 1;
  if (c === 1) return `Every ${interval}`;
  return `Every ${c} ${interval}s`;
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

  // Action form state
  const [cancelReason, setCancelReason] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [frequencyInterval, setFrequencyInterval] = useState("MONTH");
  const [frequencyCount, setFrequencyCount] = useState(1);
  const [nextDate, setNextDate] = useState("");

  const loadSub = async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}`);
    if (!res.ok) { router.push("/dashboard/subscriptions"); return; }
    const data = await res.json();
    setSub(data.subscription);
    setDunningCycles(data.dunning_cycles || []);
    setPaymentFailures(data.payment_failures || []);
    setOrders(data.orders || []);
    setEvents(data.events || []);
    setLoading(false);
  };

  useEffect(() => { loadSub(); }, [subId, workspace.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  if (loading || !sub) {
    return <div className="flex h-full items-center justify-center"><p className="text-sm text-zinc-400">Loading...</p></div>;
  }

  const customer = sub.customers;
  const customerName = `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim() || customer?.email;
  const items = sub.items || [];
  const activeDunning = dunningCycles.find(c => ["active", "skipped", "paused"].includes(c.status));

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
        {/* Left: Info + Items + Recovery + Orders + Activity */}
        <div className="space-y-6 lg:col-span-2">
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

          {/* Items */}
          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Products ({items.length})</h3>
            </div>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {items.map((item, i) => {
                const isShippingProtection = (item.title || "").toLowerCase().includes("shipping protection");
                return (
                  <div key={i} className="flex items-center justify-between px-5 py-3">
                    <div>
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
                    <span className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
                      {item.price_cents ? formatCents(item.price_cents * (item.quantity || 1)) : "--"}
                    </span>
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

              {/* Payment attempt timeline */}
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

          {/* Order History */}
          {orders.length > 0 && (
            <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Order History ({orders.length})</h3>
              </div>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {orders.map(o => (
                  <div key={o.id} className="flex items-center justify-between px-5 py-3">
                    <div>
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">#{o.order_number || o.shopify_order_id}</span>
                      <span className="ml-2 text-xs text-zinc-400">{formatDate(o.created_at)}</span>
                    </div>
                    <span className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">{o.total_cents ? formatCents(o.total_cents) : "--"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Activity Log */}
          {events.length > 0 && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Activity</h3>
              <div className="space-y-2">
                {events.map(ev => (
                  <div key={ev.id} className="flex items-start gap-2 text-sm">
                    <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                    <div>
                      <span className="text-zinc-600 dark:text-zinc-400">{ev.summary}</span>
                      <span className="ml-2 text-xs text-zinc-300 dark:text-zinc-600">{new Date(ev.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Actions */}
        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Actions</h3>
            <div className="space-y-2">
              {/* Pause/Resume */}
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

              {/* Cancel */}
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
                        <button onClick={() => setShowCancel(false)} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
                          Back
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Skip */}
              {sub.status === "active" && (
                <button onClick={() => { if (confirm("Skip next order?")) doAction("skip"); }} disabled={!!acting}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400">
                  {acting === "skip" ? "Skipping..." : "Skip next order"}
                </button>
              )}

              {/* Bill Now */}
              {sub.status === "active" && (
                <button onClick={doBillNow} disabled={!!acting}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400">
                  {acting === "bill_now" ? "Processing..." : "Process payment now"}
                </button>
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
    </div>
  );
}
