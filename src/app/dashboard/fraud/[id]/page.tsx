"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

interface FraudCaseDetail {
  id: string;
  rule_type: string;
  status: string;
  severity: string;
  title: string;
  summary: string | null;
  evidence: Record<string, unknown>;
  customer_ids: string[];
  order_ids: string[];
  assigned_to: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  resolution: string | null;
  dismissal_reason: string | null;
  first_detected_at: string;
  last_seen_at: string;
  created_at: string;
  fraud_rules: { name: string; description: string; rule_type: string };
}

interface HistoryEntry {
  id: string;
  action: string;
  old_value: string | null;
  new_value: string | null;
  notes: string | null;
  created_at: string;
  users: { email: string; raw_user_meta_data: { full_name?: string; name?: string } } | null;
}

interface Member {
  id: string;
  user_id: string;
  role: string;
  users: { email: string; raw_user_meta_data: { full_name?: string; name?: string } } | null;
}

const SEVERITY_COLORS: Record<string, string> = {
  high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  low: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  reviewing: "Reviewing",
  confirmed_fraud: "Confirmed Fraud",
  dismissed: "Dismissed",
};

const DISMISSAL_REASONS = [
  "False positive — family/household",
  "False positive — business address",
  "Reviewed — no action needed",
  "Other",
];

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

export default function FraudCaseDetailPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const params = useParams();
  const caseId = params.id as string;

  const [fraudCase, setFraudCase] = useState<FraudCaseDetail | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Review form
  const [reviewNotes, setReviewNotes] = useState("");
  const [resolution, setResolution] = useState("");
  const [dismissalReason, setDismissalReason] = useState("");
  const [assignTo, setAssignTo] = useState("");

  const applyData = (data: { case: FraudCaseDetail; history: HistoryEntry[]; members: Member[] }) => {
    setFraudCase(data.case);
    setHistory(data.history || []);
    setMembers(data.members || []);
    setReviewNotes(data.case.review_notes || "");
    setResolution(data.case.resolution || "");
    setDismissalReason(data.case.dismissal_reason || "");
    setAssignTo(data.case.assigned_to || "");
    setLoading(false);
  };

  const refreshCase = async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/fraud-cases/${caseId}`);
    if (!res.ok) { router.push("/dashboard/fraud"); return; }
    applyData(await res.json());
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/workspaces/${workspace.id}/fraud-cases/${caseId}`);
      if (cancelled) return;
      if (!res.ok) { router.push("/dashboard/fraud"); return; }
      applyData(await res.json());
    })();
    return () => { cancelled = true; };
  }, [caseId, workspace.id, router]);

  const updateCase = async (updates: Record<string, unknown>) => {
    setSaving(true);
    await fetch(`/api/workspaces/${workspace.id}/fraud-cases/${caseId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    await refreshCase();
    setSaving(false);
  };

  if (loading || !fraudCase) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-zinc-400">Loading case...</p>
      </div>
    );
  }

  const evidence = fraudCase.evidence;
  const isTerminal = fraudCase.status === "confirmed_fraud" || fraudCase.status === "dismissed";

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Back link */}
      <Link href="/dashboard/fraud" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to Fraud Monitor
      </Link>

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{fraudCase.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${SEVERITY_COLORS[fraudCase.severity]}`}>
              {fraudCase.severity}
            </span>
            <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {fraudCase.fraud_rules?.name || fraudCase.rule_type}
            </span>
            <span className="text-xs text-zinc-400">
              First detected {new Date(fraudCase.first_detected_at).toLocaleDateString()}
              {fraudCase.last_seen_at !== fraudCase.first_detected_at && (
                <> &middot; Last updated {new Date(fraudCase.last_seen_at).toLocaleDateString()}</>
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main content */}
        <div className="space-y-6 lg:col-span-2">
          {/* AI Summary */}
          {fraudCase.summary && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 px-5 py-4 dark:border-indigo-800 dark:bg-indigo-950/30">
              <p className="mb-1 text-xs font-semibold uppercase text-indigo-500">AI Analysis</p>
              <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{fraudCase.summary}</p>
            </div>
          )}

          {/* Evidence */}
          {fraudCase.rule_type === "shared_address" && (
            <SharedAddressEvidence evidence={evidence} />
          )}
          {fraudCase.rule_type === "high_velocity" && (
            <HighVelocityEvidence evidence={evidence} />
          )}
          {fraudCase.rule_type === "chargeback" && (
            <ChargebackEvidence evidence={evidence} />
          )}

          {/* Investigation Panel */}
          <InvestigationPanel workspaceId={workspace.id} caseId={caseId} />

          {/* Case History */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Case History</h3>
            {history.length === 0 ? (
              <p className="text-sm text-zinc-400">No activity yet.</p>
            ) : (
              <div className="space-y-2">
                {history.map((h) => (
                  <div key={h.id} className="flex items-start gap-2 text-sm">
                    <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                    <div>
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {h.users?.raw_user_meta_data?.full_name || h.users?.raw_user_meta_data?.name || h.users?.email || "System"}
                      </span>
                      <span className="text-zinc-400">
                        {h.action === "status_changed" && ` changed status from ${h.old_value} to ${h.new_value}`}
                        {h.action === "assigned" && ` assigned the case`}
                        {h.notes && ` — ${h.notes}`}
                      </span>
                      <span className="ml-2 text-xs text-zinc-300 dark:text-zinc-600">
                        {new Date(h.created_at).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Review panel (right) */}
        <div className="space-y-4">
          {/* Status */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Status</h3>
            <p className="mb-4 text-lg font-medium text-zinc-700 dark:text-zinc-300">
              {STATUS_LABELS[fraudCase.status]}
            </p>

            {/* Assign */}
            <label className="mb-1 block text-xs font-medium text-zinc-500">Assigned to</label>
            <select
              value={assignTo}
              onChange={(e) => { setAssignTo(e.target.value); updateCase({ assigned_to: e.target.value || null }); }}
              disabled={isTerminal}
              className="mb-4 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.users?.raw_user_meta_data?.full_name || m.users?.raw_user_meta_data?.name || m.users?.email}
                </option>
              ))}
            </select>

            {/* Review notes */}
            <label className="mb-1 block text-xs font-medium text-zinc-500">Review Notes</label>
            <textarea
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              disabled={isTerminal}
              rows={3}
              className="mb-4 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              placeholder="Notes about this case..."
            />

            {/* Resolution */}
            <label className="mb-1 block text-xs font-medium text-zinc-500">Action Taken</label>
            <input
              type="text"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              disabled={isTerminal}
              className="mb-4 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              placeholder='e.g. "Cancelled accounts", "Verified — family"'
            />

            {/* Action buttons */}
            {!isTerminal && (
              <div className="space-y-2">
                {fraudCase.status === "open" && (
                  <button
                    onClick={() => updateCase({ status: "reviewing", review_notes: reviewNotes })}
                    disabled={saving}
                    className="w-full rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
                  >
                    Mark as Reviewing
                  </button>
                )}
                <button
                  onClick={() => {
                    if (!reviewNotes.trim()) { alert("Review notes are required to confirm fraud."); return; }
                    updateCase({ status: "confirmed_fraud", review_notes: reviewNotes, resolution });
                  }}
                  disabled={saving}
                  className="w-full rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  Confirm Fraud
                </button>

                {/* Dismiss */}
                <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
                  <label className="mb-1 block text-xs font-medium text-zinc-500">Dismiss reason</label>
                  <select
                    value={dismissalReason}
                    onChange={(e) => setDismissalReason(e.target.value)}
                    className="mb-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  >
                    <option value="">Select a reason...</option>
                    {DISMISSAL_REASONS.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      if (!dismissalReason) { alert("Please select a dismissal reason."); return; }
                      updateCase({ status: "dismissed", dismissal_reason: dismissalReason, review_notes: reviewNotes });
                    }}
                    disabled={saving || !dismissalReason}
                    className="w-full rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    Dismiss Case
                  </button>
                </div>
              </div>
            )}

            {isTerminal && (
              <div className="rounded-md bg-zinc-50 p-3 text-sm text-zinc-500 dark:bg-zinc-800">
                {fraudCase.status === "confirmed_fraud" ? "This case has been confirmed as fraud." : "This case has been dismissed."}
                {fraudCase.dismissal_reason && <p className="mt-1 text-xs">Reason: {fraudCase.dismissal_reason}</p>}
                {fraudCase.resolution && <p className="mt-1 text-xs">Resolution: {fraudCase.resolution}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Evidence Components ──

function SharedAddressEvidence({ evidence }: { evidence: Record<string, unknown> }) {
  const e = evidence as {
    address: string;
    customer_count: number;
    total_order_count: number;
    total_order_value_cents: number;
    customers: { customer_id: string; name: string; email: string; order_count: number; first_order_date: string | null; last_order_date: string | null }[];
    name_variance: string;
  };

  return (
    <div className="space-y-4">
      {/* Address block */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Flagged Address</h3>
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{e.address}</p>
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-zinc-400">
          <span>{e.customer_count} customers</span>
          <span>{e.total_order_count} orders</span>
          <span>{formatCents(e.total_order_value_cents)} total value</span>
          <span>Name variance: {e.name_variance}</span>
        </div>
      </div>

      {/* Customer table */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Customers at this Address</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
                <th className="px-5 py-2">Name</th>
                <th className="px-5 py-2">Email</th>
                <th className="px-5 py-2">Orders</th>
                <th className="px-5 py-2">First Order</th>
                <th className="px-5 py-2">Last Order</th>
              </tr>
            </thead>
            <tbody>
              {e.customers?.map((c) => (
                <tr key={c.customer_id} className="border-b border-zinc-50 dark:border-zinc-800/50">
                  <td className="px-5 py-2">
                    <Link href={`/dashboard/customers/${c.customer_id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                      {c.name || "Unknown"}
                    </Link>
                  </td>
                  <td className="px-5 py-2 text-zinc-500">{c.email}</td>
                  <td className="px-5 py-2 tabular-nums text-zinc-600 dark:text-zinc-400">{c.order_count}</td>
                  <td className="px-5 py-2 text-zinc-400">{c.first_order_date ? new Date(c.first_order_date).toLocaleDateString() : "—"}</td>
                  <td className="px-5 py-2 text-zinc-400">{c.last_order_date ? new Date(c.last_order_date).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ChargebackEvidence({ evidence }: { evidence: Record<string, unknown> }) {
  const e = evidence as {
    dispute_id?: string;
    order_id?: string;
    reason?: string;
    amount?: number;
    evidence_due_date?: string;
    customer_email?: string;
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Chargeback Details</h3>
      <div className="space-y-2 text-sm">
        {e.dispute_id && <DetailRow label="Dispute ID" value={e.dispute_id} />}
        {e.order_id && <DetailRow label="Order" value={`#${e.order_id}`} />}
        {e.reason && <DetailRow label="Reason" value={e.reason} />}
        {e.amount != null && <DetailRow label="Amount" value={formatCents(e.amount)} />}
        {e.customer_email && <DetailRow label="Customer" value={e.customer_email} />}
        {e.evidence_due_date && <DetailRow label="Evidence Due" value={new Date(e.evidence_due_date).toLocaleDateString()} />}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-900 dark:text-zinc-100">{value}</span>
    </div>
  );
}

function HighVelocityEvidence({ evidence }: { evidence: Record<string, unknown> }) {
  const e = evidence as {
    customer_id: string;
    customer_name: string;
    customer_email: string;
    window_start: string;
    window_end: string;
    qualifying_orders: {
      order_id: string;
      order_date: string;
      items: { product_title: string; quantity: number; unit_price_cents: number }[];
      order_total_cents: number;
    }[];
    total_units_in_window: number;
    total_spend_in_window_cents: number;
  };

  return (
    <div className="space-y-4">
      {/* Customer block */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Customer</h3>
        <div className="flex items-center gap-4">
          <div>
            <Link href={`/dashboard/customers/${e.customer_id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              {e.customer_name || e.customer_email}
            </Link>
            <p className="text-sm text-zinc-400">{e.customer_email}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-zinc-400">
          <span>{e.qualifying_orders?.length} qualifying orders</span>
          <span>{e.total_units_in_window} total units</span>
          <span>{formatCents(e.total_spend_in_window_cents)} total spend</span>
          <span>Window: {new Date(e.window_start).toLocaleDateString()} — {new Date(e.window_end).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Orders timeline */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Qualifying Orders</h3>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {e.qualifying_orders?.map((o) => (
            <div key={o.order_id} className="px-5 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Order #{o.order_id}
                  </span>
                  <span className="ml-2 text-xs text-zinc-400">
                    {new Date(o.order_date).toLocaleDateString()}
                  </span>
                </div>
                <span className="text-sm font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                  {formatCents(o.order_total_cents)}
                </span>
              </div>
              <div className="mt-1 space-y-0.5">
                {o.items?.map((item, i) => (
                  <p key={i} className="text-xs text-zinc-400">
                    {item.quantity}x {item.product_title} @ {formatCents(item.unit_price_cents)}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Investigation Panel ──

interface InvestCustomer {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  retention_score: number | null;
  subscription_status: string | null;
  total_orders: number | null;
  ltv_cents: number | null;
  is_case_customer: boolean;
  is_linked: boolean;
}

interface InvestOrder {
  id: string;
  order_number: string;
  customer_id: string;
  total_price_cents: number | null;
  line_items: { title?: string; quantity?: number }[] | null;
  created_at: string;
}

interface InvestSubscription {
  id: string;
  customer_id: string;
  status: string;
  items: { title?: string }[] | null;
  next_billing_date: string | null;
  billing_interval: string | null;
}

interface InvestChargeback {
  id: string;
  customer_id: string;
  reason: string | null;
  amount_cents: number;
  status: string;
  initiated_at: string;
}

interface TriggeredRule {
  rule_name: string;
  rule_type: string;
  severity: string;
  details: string;
}

interface LinkSuggestion {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  match_reason: string;
}

function InvestigationPanel({ workspaceId, caseId }: { workspaceId: string; caseId: string }) {
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<InvestCustomer[]>([]);
  const [triggeredRules, setTriggeredRules] = useState<TriggeredRule[]>([]);
  const [orders, setOrders] = useState<InvestOrder[]>([]);
  const [subscriptions, setSubscriptions] = useState<InvestSubscription[]>([]);
  const [chargebacks, setChargebacks] = useState<InvestChargeback[]>([]);
  const [linkSuggestions, setLinkSuggestions] = useState<LinkSuggestion[]>([]);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [cancellingSubId, setCancellingSubId] = useState<string | null>(null);

  const handleCancelSub = async (subId: string) => {
    if (!confirm("Cancel this subscription for fraud? This will stop all billing via Appstle with reason 'fraud'.")) return;
    setCancellingSubId(subId);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/fraud-cases/${caseId}/cancel-subscription`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptionId: subId }),
      });
      if (res.ok) {
        setSubscriptions(prev => prev.filter(s => s.id !== subId));
      }
    } finally {
      setCancellingSubId(null);
    }
  };

  const loadData = async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/fraud-cases/${caseId}/investigate`);
    if (!res.ok) { setLoading(false); return; }
    const data = await res.json();
    setCustomers(data.customers || []);
    setTriggeredRules(data.triggered_rules || []);
    setOrders(data.orders || []);
    setSubscriptions(data.subscriptions || []);
    setChargebacks(data.chargebacks || []);
    setLinkSuggestions(data.link_suggestions || []);
    setLoading(false);
  };

  useEffect(() => { loadData(); }, [workspaceId, caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLink = async (primaryId: string, targetId: string) => {
    setLinkingId(targetId);
    await fetch(`/api/customers/${primaryId}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link_to: targetId }),
    });
    setLinkingId(null);
    loadData();
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
          <span className="text-sm text-zinc-400">Running investigation...</span>
        </div>
      </div>
    );
  }

  const RULE_SEV: Record<string, string> = {
    high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
    low: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };

  const primaryCustomer = customers.find(c => c.is_case_customer);

  return (
    <div className="space-y-4">
      {/* Triggered Rules */}
      <div className={`rounded-lg border p-5 ${triggeredRules.length > 0 ? "border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"}`}>
        <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Rules Triggered</h3>
        {triggeredRules.length > 0 ? (
          <div className="space-y-2">
            {triggeredRules.map((r, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${RULE_SEV[r.severity] || RULE_SEV.low}`}>
                  {r.severity}
                </span>
                <div>
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.rule_name}</span>
                  <p className="text-xs text-zinc-500">{r.details}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-400">No active fraud rules triggered for these accounts.</p>
        )}
      </div>

      {/* Customer Accounts */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Customer Accounts ({customers.length})</h3>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {customers.map((c) => (
            <div key={c.id} className="px-5 py-3">
              <div className="flex items-center gap-2">
                <Link href={`/dashboard/customers/${c.id}`} className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                  {`${c.first_name || ""} ${c.last_name || ""}`.trim() || c.email}
                </Link>
                {c.is_case_customer && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:bg-red-900/30 dark:text-red-400">flagged</span>
                )}
                {c.is_linked && (
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">linked</span>
                )}
              </div>
              <p className="text-xs text-zinc-500">{c.email}{c.phone ? ` · ${c.phone}` : ""}</p>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-zinc-400">
                <span>{c.total_orders || 0} orders</span>
                {c.ltv_cents != null && <span>LTV {formatCents(c.ltv_cents)}</span>}
                {c.retention_score != null && <span>Score: {c.retention_score}</span>}
                {c.subscription_status && c.subscription_status !== "none" && <span>Sub: {c.subscription_status}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Link Suggestions */}
      {linkSuggestions.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Link Suggestions</h3>
          <p className="mb-3 text-xs text-zinc-400">Linking expands the investigation to include the linked account&apos;s orders, subscriptions, and chargebacks.</p>
          <div className="space-y-2">
            {linkSuggestions.map((s) => (
              <div key={s.id} className="flex items-center gap-2 rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800/50">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-zinc-900 dark:text-zinc-100">{`${s.first_name || ""} ${s.last_name || ""}`.trim() || s.email}</p>
                  <p className="text-xs text-zinc-500">{s.email}</p>
                  <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">{s.match_reason}</span>
                </div>
                <button
                  onClick={() => primaryCustomer && handleLink(primaryCustomer.id, s.id)}
                  disabled={linkingId === s.id}
                  className="shrink-0 rounded-md border border-indigo-200 bg-white px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-900 dark:bg-zinc-900 dark:text-indigo-400"
                >
                  {linkingId === s.id ? "Linking..." : "Link"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active Subscriptions */}
      {subscriptions.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Active Subscriptions ({subscriptions.length})</h3>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {subscriptions.map((s) => {
              const owner = customers.find(c => c.id === s.customer_id);
              const items = (s.items as { title?: string }[] | null) || [];
              return (
                <div key={s.id} className="px-5 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {items.map(i => i.title || "Subscription").join(", ")}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {owner?.email || "Unknown"}
                        {owner?.is_linked && <span className="ml-1 rounded bg-blue-100 px-1 py-0.5 text-[10px] text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">linked</span>}
                      </p>
                      <div className="mt-1 flex gap-3 text-[11px] text-zinc-400">
                        {s.next_billing_date && <span>Next: {new Date(s.next_billing_date).toLocaleDateString()}</span>}
                        {s.billing_interval && <span>{s.billing_interval}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${s.status === "active" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"}`}>
                        {s.status}
                      </span>
                      <button
                        onClick={() => handleCancelSub(s.id)}
                        disabled={cancellingSubId === s.id}
                        className="shrink-0 rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-900/20"
                      >
                        {cancellingSubId === s.id ? "Cancelling..." : "Cancel"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Orders */}
      {orders.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Recent Orders ({orders.length})</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
                  <th className="px-5 py-2">Order</th>
                  <th className="px-5 py-2">Customer</th>
                  <th className="px-5 py-2">Items</th>
                  <th className="px-5 py-2">Total</th>
                  <th className="px-5 py-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {orders.slice(0, 20).map((o) => {
                  const owner = customers.find(c => c.id === o.customer_id);
                  const items = (o.line_items as { title?: string; quantity?: number }[] | null) || [];
                  return (
                    <tr key={o.id} className="border-b border-zinc-50 dark:border-zinc-800/50">
                      <td className="whitespace-nowrap px-5 py-2 font-medium text-zinc-900 dark:text-zinc-100">{o.order_number || o.id.slice(0, 8)}</td>
                      <td className="px-5 py-2 text-xs text-zinc-500">
                        {owner?.email || "—"}
                        {owner?.is_linked && <span className="ml-1 rounded bg-blue-100 px-1 py-0.5 text-[10px] text-blue-600">linked</span>}
                      </td>
                      <td className="px-5 py-2 text-xs text-zinc-400">
                        {items.slice(0, 2).map(i => `${i.quantity || 1}x ${(i.title || "").slice(0, 25)}`).join(", ")}
                        {items.length > 2 && ` +${items.length - 2}`}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2 tabular-nums text-zinc-600 dark:text-zinc-400">
                        {o.total_price_cents != null ? formatCents(o.total_price_cents) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2 text-xs text-zinc-400">{new Date(o.created_at).toLocaleDateString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Chargebacks */}
      {chargebacks.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Chargebacks ({chargebacks.length})</h3>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {chargebacks.map((cb) => {
              const owner = customers.find(c => c.id === cb.customer_id);
              return (
                <div key={cb.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{cb.reason || "Unknown"}</span>
                    <span className="ml-2 text-xs text-zinc-400">{owner?.email || ""}</span>
                    <p className="text-xs text-zinc-400">{new Date(cb.initiated_at).toLocaleDateString()}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-medium tabular-nums text-zinc-700 dark:text-zinc-300">{formatCents(cb.amount_cents)}</span>
                    <p className={`text-[10px] font-medium ${cb.status === "won" ? "text-green-600" : cb.status === "lost" ? "text-red-600" : "text-zinc-400"}`}>{cb.status}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
