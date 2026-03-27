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

  const fetchCase = async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/fraud-cases/${caseId}`);
    if (!res.ok) { router.push("/dashboard/fraud"); return; }
    const data = await res.json();
    setFraudCase(data.case);
    setHistory(data.history || []);
    setMembers(data.members || []);
    setReviewNotes(data.case.review_notes || "");
    setResolution(data.case.resolution || "");
    setDismissalReason(data.case.dismissal_reason || "");
    setAssignTo(data.case.assigned_to || "");
    setLoading(false);
  };

  useEffect(() => { fetchCase(); }, [caseId, workspace.id]);

  const updateCase = async (updates: Record<string, unknown>) => {
    setSaving(true);
    await fetch(`/api/workspaces/${workspace.id}/fraud-cases/${caseId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    await fetchCase();
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
            <SharedAddressEvidence evidence={evidence} workspaceId={workspace.id} />
          )}
          {fraudCase.rule_type === "high_velocity" && (
            <HighVelocityEvidence evidence={evidence} workspaceId={workspace.id} />
          )}

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

function SharedAddressEvidence({ evidence, workspaceId }: { evidence: Record<string, unknown>; workspaceId: string }) {
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

function HighVelocityEvidence({ evidence }: { evidence: Record<string, unknown>; workspaceId: string }) {
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
