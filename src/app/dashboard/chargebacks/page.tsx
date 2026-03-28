"use client";

import { useState, useEffect, useCallback } from "react";

interface ChargebackEvent {
  id: string;
  shopify_dispute_id: string;
  shopify_order_id: string | null;
  order_number: string | null;
  customer_id: string | null;
  customers: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    retention_score: number | null;
  } | null;
  dispute_type: string;
  reason: string | null;
  network_reason_code: string | null;
  amount_cents: number | null;
  currency: string;
  status: string;
  evidence_due_by: string | null;
  evidence_sent_on: string | null;
  finalized_on: string | null;
  auto_action_taken: string | null;
  auto_action_at: string | null;
  fraud_case_id: string | null;
  ticket_id: string | null;
  initiated_at: string;
  created_at: string;
  active_sub_count: number;
}

interface Stats {
  total_count: number;
  under_review_count: number;
  won_count: number;
  lost_count: number;
  total_amount_cents: number;
  auto_cancelled_count: number;
  evidence_due_soon: number;
}

const REASON_BADGES: Record<string, { label: string; color: string }> = {
  fraudulent: { label: "Fraud", color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
  unrecognized: { label: "Unrecognized", color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
  subscription_cancelled: { label: "Sub. Cancelled", color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" },
  product_not_received: { label: "Not Received", color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" },
  duplicate: { label: "Duplicate", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" },
  product_unacceptable: { label: "Product Issue", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" },
  credit_not_processed: { label: "Credit Issue", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" },
};

const STATUS_BADGES: Record<string, { label: string; color: string }> = {
  under_review: { label: "Under Review", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  accepted: { label: "Accepted", color: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
  won: { label: "Won", color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  lost: { label: "Lost", color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
};

const ACTION_BADGES: Record<string, { label: string; color: string }> = {
  subscriptions_cancelled: { label: "Subs Cancelled", color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
  flagged_for_review: { label: "Flagged", color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" },
  none: { label: "No Action", color: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
};

function formatCents(cents: number | null, currency = "USD"): string {
  if (cents == null) return "--";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function evidenceDueColor(dueDate: string | null): string {
  if (!dueDate) return "text-zinc-400";
  const days = Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86400000);
  if (days <= 3) return "text-red-600 dark:text-red-400 font-medium";
  if (days <= 7) return "text-yellow-600 dark:text-yellow-400";
  return "text-zinc-500";
}

export default function ChargebacksPage() {
  const [chargebacks, setChargebacks] = useState<ChargebackEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [reasonFilter, setReasonFilter] = useState("all");
  const [selected, setSelected] = useState<ChargebackEvent | null>(null);
  const [reinstating, setReinstating] = useState(false);
  const [page, setPage] = useState(0);
  const [sortCol, setSortCol] = useState("created_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const limit = 25;

  function handleSort(col: string) {
    if (sortCol === col) {
      setSortOrder((o) => (o === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortOrder("desc");
    }
    setPage(0);
  }

  const fetchChargebacks = useCallback(async () => {
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (reasonFilter !== "all") params.set("reason", reasonFilter);
    params.set("sort", sortCol);
    params.set("order", sortOrder);
    params.set("limit", String(limit));
    params.set("offset", String(page * limit));

    const res = await fetch(`/api/chargebacks?${params}`);
    if (res.ok) {
      const data = await res.json();
      setChargebacks(data.data || []);
      setTotal(data.total || 0);
    }
    setLoading(false);
  }, [statusFilter, reasonFilter, page, sortCol, sortOrder]);

  const fetchStats = useCallback(async () => {
    const res = await fetch("/api/chargebacks/stats");
    if (res.ok) {
      const data = await res.json();
      setStats(data);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchChargebacks();
  }, [fetchChargebacks]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleReinstate = async (chargebackId: string) => {
    if (!confirm("Are you sure you want to reinstate the cancelled subscriptions? This will resume billing.")) return;
    setReinstating(true);
    try {
      const res = await fetch(`/api/chargebacks/${chargebackId}/reinstate`, { method: "POST" });
      if (res.ok) {
        fetchChargebacks();
        fetchStats();
      }
    } finally {
      setReinstating(false);
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Chargebacks</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Monitor disputes and automated subscription actions.
        </p>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <StatCard label="Total" value={String(stats.total_count)} />
          <StatCard label="Under Review" value={String(stats.under_review_count)} accent="blue" />
          <StatCard label="Won" value={String(stats.won_count)} accent="green" />
          <StatCard label="Lost" value={String(stats.lost_count)} accent="red" />
          <StatCard label="Subs Cancelled" value={String(stats.auto_cancelled_count)} accent="red" />
          <StatCard label="Evidence Due Soon" value={String(stats.evidence_due_soon)} accent={stats.evidence_due_soon > 0 ? "yellow" : undefined} />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
        >
          <option value="all">All statuses</option>
          <option value="under_review">Under Review</option>
          <option value="accepted">Accepted</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
        </select>
        <select
          value={reasonFilter}
          onChange={(e) => { setReasonFilter(e.target.value); setPage(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
        >
          <option value="all">All reasons</option>
          <option value="fraudulent">Fraud</option>
          <option value="unrecognized">Unrecognized</option>
          <option value="subscription_cancelled">Sub. Cancelled</option>
          <option value="product_not_received">Not Received</option>
          <option value="product_unacceptable">Product Issue</option>
          <option value="duplicate">Duplicate</option>
          <option value="credit_not_processed">Credit Issue</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
            <tr>
              <SortHeader label="Date" col="created_at" current={sortCol} order={sortOrder} onSort={handleSort} />
              <th className="px-4 py-3 font-medium text-zinc-500">Order</th>
              <th className="px-4 py-3 font-medium text-zinc-500">Customer</th>
              <SortHeader label="Amount" col="amount_cents" current={sortCol} order={sortOrder} onSort={handleSort} />
              <th className="px-4 py-3 font-medium text-zinc-500">Reason</th>
              <th className="px-4 py-3 font-medium text-zinc-500">Status</th>
              <SortHeader label="Active Subs" col="active_sub_count" current={sortCol} order={sortOrder} onSort={handleSort} />
              <th className="px-4 py-3 font-medium text-zinc-500">Action</th>
              <SortHeader label="Evidence Due" col="evidence_due_by" current={sortCol} order={sortOrder} onSort={handleSort} />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-zinc-400">Loading...</td></tr>
            ) : chargebacks.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-zinc-400">No chargebacks found</td></tr>
            ) : chargebacks.map((cb) => (
              <tr
                key={cb.id}
                onClick={() => setSelected(selected?.id === cb.id ? null : cb)}
                className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              >
                <td className="whitespace-nowrap px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  {new Date(cb.initiated_at).toLocaleDateString()}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                  {cb.order_number || cb.shopify_order_id || "--"}
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  {cb.customers
                    ? `${cb.customers.first_name || ""} ${cb.customers.last_name || ""}`.trim() || cb.customers.email
                    : "--"}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                  {formatCents(cb.amount_cents, cb.currency)}
                </td>
                <td className="px-4 py-3">
                  <Badge {...(REASON_BADGES[cb.reason || ""] || { label: cb.reason || "--", color: "bg-zinc-100 text-zinc-500" })} />
                </td>
                <td className="px-4 py-3">
                  <Badge {...(STATUS_BADGES[cb.status] || { label: cb.status, color: "bg-zinc-100 text-zinc-500" })} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-center">
                  {cb.active_sub_count > 0 ? (
                    <span className="inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                      {cb.active_sub_count}
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-300 dark:text-zinc-600">0</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {cb.auto_action_taken ? (
                    <Badge {...(ACTION_BADGES[cb.auto_action_taken] || { label: cb.auto_action_taken, color: "bg-zinc-100 text-zinc-500" })} />
                  ) : (
                    <span className="text-zinc-400">Pending</span>
                  )}
                </td>
                <td className={`whitespace-nowrap px-4 py-3 ${evidenceDueColor(cb.evidence_due_by)}`}>
                  {cb.evidence_due_by ? new Date(cb.evidence_due_by).toLocaleDateString() : "--"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-500">{total} total</p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded border border-zinc-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
            >
              Previous
            </button>
            <span className="px-2 py-1 text-sm text-zinc-500">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="rounded border border-zinc-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-zinc-700"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <DetailPanel
          cb={selected}
          onClose={() => setSelected(null)}
          onReinstate={handleReinstate}
          reinstating={reinstating}
          onRefresh={() => { fetchChargebacks(); fetchStats(); }}
        />
      )}
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  const accentColors: Record<string, string> = {
    blue: "text-blue-600 dark:text-blue-400",
    green: "text-green-600 dark:text-green-400",
    red: "text-red-600 dark:text-red-400",
    yellow: "text-yellow-600 dark:text-yellow-400",
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className={`mt-1 text-lg font-bold ${accent ? accentColors[accent] : "text-zinc-900 dark:text-zinc-100"}`}>
        {value}
      </p>
    </div>
  );
}

interface Subscription {
  id: string;
  shopify_contract_id: string;
  status: string;
  items: string;
  next_billing_date: string | null;
  billing_interval: string | null;
  customer_email: string;
  customer_name: string;
  is_linked: boolean;
}

function DetailPanel({
  cb,
  onClose,
  onReinstate,
  reinstating,
  onRefresh,
}: {
  cb: ChargebackEvent;
  onClose: () => void;
  onReinstate: (id: string) => void;
  reinstating: boolean;
  onRefresh: () => void;
}) {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [subsLoading, setSubsLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // Account linking state
  const [linkedProfiles, setLinkedProfiles] = useState<{ id: string; email: string; first_name: string | null; last_name: string | null; retention_score: number | null }[]>([]);
  const [suggestions, setSuggestions] = useState<{ id: string; email: string; first_name: string | null; last_name: string | null; phone: string | null; match_reason: string }[]>([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linkingId, setLinkingId] = useState<string | null>(null);

  useEffect(() => {
    setSubsLoading(true);
    setLinksLoading(true);
    fetch(`/api/chargebacks/${cb.id}/subscriptions`)
      .then((r) => r.json())
      .then((d) => setSubs(d.subscriptions || []))
      .finally(() => setSubsLoading(false));

    // Load linked profiles + suggestions
    if (cb.customer_id) {
      Promise.all([
        fetch(`/api/customers/${cb.customer_id}/links`).then((r) => r.json()),
        fetch(`/api/customers/${cb.customer_id}/suggestions`).then((r) => r.json()),
      ]).then(([linksData, suggestionsData]) => {
        setLinkedProfiles(linksData.linked || []);
        setSuggestions(suggestionsData.suggestions || []);
      }).finally(() => setLinksLoading(false));
    } else {
      setLinksLoading(false);
    }
  }, [cb.id, cb.customer_id]);

  const refreshSubs = () => {
    setSubsLoading(true);
    fetch(`/api/chargebacks/${cb.id}/subscriptions`)
      .then((r) => r.json())
      .then((d) => setSubs(d.subscriptions || []))
      .finally(() => setSubsLoading(false));
  };

  const handleLink = async (targetId: string) => {
    if (!cb.customer_id) return;
    setLinkingId(targetId);
    try {
      const res = await fetch(`/api/customers/${cb.customer_id}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link_to: targetId }),
      });
      if (res.ok) {
        // Move from suggestions to linked
        const linked = suggestions.find((s) => s.id === targetId);
        if (linked) {
          setLinkedProfiles((prev) => [...prev, { id: linked.id, email: linked.email, first_name: linked.first_name, last_name: linked.last_name, retention_score: null }]);
          setSuggestions((prev) => prev.filter((s) => s.id !== targetId));
        }
        // Refresh subscriptions — newly linked accounts may have active subs
        refreshSubs();
      }
    } finally {
      setLinkingId(null);
    }
  };

  const handleCancelSub = async (subId: string) => {
    if (!confirm("Cancel this subscription? This will stop all future billing via Appstle.")) return;
    setCancellingId(subId);
    try {
      const res = await fetch(`/api/chargebacks/${cb.id}/cancel-subscription`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptionId: subId }),
      });
      if (res.ok) {
        setSubs((prev) => prev.filter((s) => s.id !== subId));
        onRefresh();
      }
    } finally {
      setCancellingId(null);
    }
  };

  const reason = REASON_BADGES[cb.reason || ""];
  const status = STATUS_BADGES[cb.status];
  const action = cb.auto_action_taken ? ACTION_BADGES[cb.auto_action_taken] : null;

  return (
    <div className="fixed inset-y-0 right-0 z-30 w-full max-w-md overflow-y-auto border-l border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">Chargeback Details</h2>
        <button
          onClick={onClose}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="space-y-4 p-4">
        {/* Status + Reason */}
        <div className="flex flex-wrap gap-2">
          {status && <Badge {...status} />}
          {reason && <Badge {...reason} />}
          {cb.dispute_type === "inquiry" && (
            <Badge label="Inquiry" color="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" />
          )}
        </div>

        {/* Key details */}
        <div className="space-y-2 text-sm">
          <DetailRow label="Dispute ID" value={cb.shopify_dispute_id} />
          <DetailRow label="Order" value={cb.order_number || cb.shopify_order_id || "--"} />
          <DetailRow label="Amount" value={formatCents(cb.amount_cents, cb.currency)} />
          <DetailRow label="Currency" value={cb.currency} />
          {cb.network_reason_code && <DetailRow label="Network Code" value={cb.network_reason_code} />}
          <DetailRow label="Type" value={cb.dispute_type} />
          <DetailRow label="Initiated" value={new Date(cb.initiated_at).toLocaleString()} />
          <DetailRow
            label="Evidence Due"
            value={cb.evidence_due_by ? new Date(cb.evidence_due_by).toLocaleDateString() : "N/A"}
            className={evidenceDueColor(cb.evidence_due_by)}
          />
          {cb.evidence_sent_on && <DetailRow label="Evidence Sent" value={new Date(cb.evidence_sent_on).toLocaleDateString()} />}
          {cb.finalized_on && <DetailRow label="Finalized" value={new Date(cb.finalized_on).toLocaleDateString()} />}
        </div>

        {/* Customer info */}
        {cb.customers && (
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs font-medium text-zinc-500">Customer</p>
            <p className="mt-1 font-medium text-zinc-900 dark:text-zinc-100">
              {`${cb.customers.first_name || ""} ${cb.customers.last_name || ""}`.trim() || cb.customers.email}
            </p>
            <p className="text-sm text-zinc-500">{cb.customers.email}</p>
            {cb.customers.retention_score != null && (
              <p className="mt-1 text-xs text-zinc-400">
                Retention score: {cb.customers.retention_score}
              </p>
            )}
          </div>
        )}

        {/* Active Subscriptions */}
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-xs font-medium text-zinc-500">Active Subscriptions</p>
          {subsLoading ? (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600" />
              <span className="text-xs text-zinc-400">Loading...</span>
            </div>
          ) : subs.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-400">No active subscriptions found</p>
          ) : (
            <div className="mt-2 space-y-3">
              {subs.map((sub) => (
                <div key={sub.id} className="rounded-md border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {sub.items || "Subscription"}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {sub.customer_email}
                        {sub.is_linked && (
                          <span className="ml-1 rounded bg-blue-100 px-1 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                            linked
                          </span>
                        )}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-zinc-400">
                        <span className={sub.status === "active" ? "text-green-600 dark:text-green-400" : "text-yellow-600 dark:text-yellow-400"}>
                          {sub.status}
                        </span>
                        {sub.next_billing_date && (
                          <span>Next: {new Date(sub.next_billing_date).toLocaleDateString()}</span>
                        )}
                        {sub.billing_interval && <span>{sub.billing_interval}</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => handleCancelSub(sub.id)}
                      disabled={cancellingId === sub.id}
                      className="shrink-0 rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-900/20"
                    >
                      {cancellingId === sub.id ? "Cancelling..." : "Cancel"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Account Linking */}
        {cb.customer_id && (
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs font-medium text-zinc-500">Linked Accounts</p>
            {linksLoading ? (
              <div className="mt-2 flex items-center gap-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600" />
                <span className="text-xs text-zinc-400">Loading...</span>
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                {/* Already linked */}
                {linkedProfiles.map((lp) => (
                  <div key={lp.id} className="flex items-center gap-2 rounded-md border border-emerald-100 bg-emerald-50/50 px-3 py-2 dark:border-emerald-900/30 dark:bg-emerald-900/10">
                    <svg className="h-4 w-4 shrink-0 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
                    </svg>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-zinc-900 dark:text-zinc-100">
                        {`${lp.first_name || ""} ${lp.last_name || ""}`.trim() || lp.email}
                      </p>
                      <p className="truncate text-xs text-zinc-500">{lp.email}</p>
                    </div>
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
                      linked
                    </span>
                  </div>
                ))}

                {/* Suggestions */}
                {suggestions.length > 0 && (
                  <>
                    {linkedProfiles.length > 0 && <div className="border-t border-zinc-100 dark:border-zinc-800" />}
                    <p className="text-[11px] font-medium text-zinc-400">Suggested matches</p>
                    {suggestions.map((s) => (
                      <div key={s.id} className="flex items-center gap-2 rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800/50">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-zinc-900 dark:text-zinc-100">
                            {`${s.first_name || ""} ${s.last_name || ""}`.trim() || s.email}
                          </p>
                          <p className="truncate text-xs text-zinc-500">{s.email}</p>
                          <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
                            {s.match_reason}
                          </span>
                        </div>
                        <button
                          onClick={() => handleLink(s.id)}
                          disabled={linkingId === s.id}
                          className="shrink-0 rounded-md border border-indigo-200 bg-white px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-900 dark:bg-zinc-900 dark:text-indigo-400 dark:hover:bg-indigo-900/20"
                        >
                          {linkingId === s.id ? "Linking..." : "Link"}
                        </button>
                      </div>
                    ))}
                  </>
                )}

                {linkedProfiles.length === 0 && suggestions.length === 0 && (
                  <p className="text-sm text-zinc-400">No linked accounts or suggestions found</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Auto action */}
        {action && (
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs font-medium text-zinc-500">Automated Action</p>
            <div className="mt-1 flex items-center gap-2">
              <Badge {...action} />
              {cb.auto_action_at && (
                <span className="text-xs text-zinc-400">
                  {new Date(cb.auto_action_at).toLocaleString()}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Reinstate button — only if subs were cancelled and chargeback was won */}
        {cb.auto_action_taken === "subscriptions_cancelled" && cb.status === "won" && (
          <button
            onClick={() => onReinstate(cb.id)}
            disabled={reinstating}
            className="w-full rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {reinstating ? "Reinstating..." : "Reinstate Cancelled Subscriptions"}
          </button>
        )}

        {/* Links */}
        <div className="flex flex-wrap gap-2 pt-2">
          {cb.fraud_case_id && (
            <a
              href={`/dashboard/fraud?case=${cb.fraud_case_id}`}
              className="text-sm text-indigo-600 hover:underline dark:text-indigo-400"
            >
              View Fraud Case
            </a>
          )}
          {cb.ticket_id && (
            <a
              href={`/dashboard/tickets/${cb.ticket_id}`}
              className="text-sm text-indigo-600 hover:underline dark:text-indigo-400"
            >
              View Ticket
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className={className || "text-zinc-900 dark:text-zinc-100"}>{value}</span>
    </div>
  );
}

function SortHeader({ label, col, current, order, onSort }: { label: string; col: string; current: string; order: string; onSort: (col: string) => void }) {
  const active = current === col;
  return (
    <th
      onClick={() => onSort(col)}
      className="cursor-pointer select-none px-4 py-3 font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            {order === "desc"
              ? <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              : <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />}
          </svg>
        ) : (
          <svg className="h-3 w-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4M8 15l4 4 4-4" />
          </svg>
        )}
      </span>
    </th>
  );
}
