"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

interface AIAnalysis {
  risk_level: string;
  summary: string;
  indicators: string[];
  recommended_actions: string[];
  analyzed_at: string;
}

interface FraudCaseDetail {
  id: string;
  rule_type: string;
  status: string;
  severity: string;
  title: string;
  summary: string | null;
  ai_analysis: AIAnalysis | null;
  evidence: Record<string, unknown>;
  customer_ids: string[];
  order_ids: string[];
  orders_held: boolean;
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

  // AI analysis
  const [aiAnalysis, setAiAnalysis] = useState<AIAnalysis | null>(null);
  const [analyzingAi, setAnalyzingAi] = useState(false);

  // Confirm fraud wizard
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardLoading, setWizardLoading] = useState(false);
  const [wizardAmplifierOrders, setWizardAmplifierOrders] = useState<{ order_id: string; order_number: string; amplifier_order_id: string | null; amplifier_status: string | null; amplifier_shipped_at: string | null; at_amplifier: boolean; shipped: boolean; cancellable: boolean; amplifier_url: string | null }[]>([]);
  const [wizardSubResults, setWizardSubResults] = useState<{ subscription_id: string; shopify_contract_id: string; success: boolean; error?: string }[]>([]);
  const [wizardOrderResults, setWizardOrderResults] = useState<{ order_id: string; order_number: string; success: boolean; error?: string }[]>([]);
  const [wizardBanResults, setWizardBanResults] = useState<{ customer_id: string; success: boolean }[]>([]);
  const [wizardComplete, setWizardComplete] = useState(false);

  const applyData = (data: { case: FraudCaseDetail; history: HistoryEntry[]; members: Member[] }) => {
    setFraudCase(data.case);
    setHistory(data.history || []);
    setMembers(data.members || []);
    setReviewNotes(data.case.review_notes || "");
    setResolution(data.case.resolution || "");
    setDismissalReason(data.case.dismissal_reason || "");
    setAssignTo(data.case.assigned_to || "");
    setAiAnalysis(data.case.ai_analysis || null);
    setLoading(false);
  };

  const runAiAnalysis = async () => {
    setAnalyzingAi(true);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/fraud-cases/${caseId}/analyze`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setAiAnalysis(data.ai_analysis);
      }
    } finally {
      setAnalyzingAi(false);
    }
  };

  // Auto-run AI analysis if not cached
  useEffect(() => {
    if (fraudCase && !fraudCase.ai_analysis && !aiAnalysis && !analyzingAi) {
      runAiAnalysis();
    }
  }, [fraudCase?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wizard step handlers
  const wizardCallStep = async (stepName: string, body?: Record<string, unknown>) => {
    setWizardLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/fraud-cases/${caseId}/confirm-fraud`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: stepName, ...body }),
      });
      return res.ok ? await res.json() : null;
    } finally {
      setWizardLoading(false);
    }
  };

  const startWizard = async () => {
    setWizardOpen(true);
    setWizardStep(0);
    setWizardComplete(false);
    setWizardSubResults([]);
    setWizardOrderResults([]);
    setWizardBanResults([]);
    // Step 0: check amplifier
    setWizardLoading(true);
    const data = await wizardCallStep("check_amplifier");
    if (data) setWizardAmplifierOrders(data.orders || []);
    setWizardLoading(false);
  };

  const wizardCancelSubs = async () => {
    const data = await wizardCallStep("cancel_subscriptions");
    if (data) setWizardSubResults(data.results || []);
    setWizardStep(2);
  };

  const wizardCancelOrders = async () => {
    const data = await wizardCallStep("cancel_refund_orders");
    if (data) setWizardOrderResults(data.results || []);
    setWizardStep(3);
  };

  const wizardBanCustomer = async () => {
    const data = await wizardCallStep("ban_customer");
    if (data) setWizardBanResults(data.results || []);
    setWizardStep(4);
  };

  const wizardFinish = async () => {
    await wizardCallStep("complete", { review_notes: reviewNotes, resolution });
    setWizardComplete(true);
    refreshCase();
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
        <button
          onClick={async () => {
            if (!confirm("Delete this fraud case? This cannot be undone.")) return;
            const res = await fetch(`/api/workspaces/${workspace.id}/fraud-cases/${caseId}`, { method: "DELETE" });
            if (res.ok) router.push("/dashboard/fraud");
          }}
          className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
        >
          Delete Case
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main content */}
        <div className="space-y-6 lg:col-span-2">
          {/* AI Analysis (cached) */}
          <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 px-5 py-4 dark:border-indigo-800 dark:bg-indigo-950/30">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase text-indigo-500">AI Analysis</p>
              <button
                onClick={runAiAnalysis}
                disabled={analyzingAi}
                className="rounded-md border border-indigo-200 bg-white px-2 py-1 text-[10px] font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-400"
              >
                {analyzingAi ? "Analyzing..." : "Re-analyze"}
              </button>
            </div>
            {analyzingAi && !aiAnalysis ? (
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600" />
                <span className="text-sm text-indigo-500">Running AI analysis...</span>
              </div>
            ) : aiAnalysis ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${aiAnalysis.risk_level === "high" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" : aiAnalysis.risk_level === "medium" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"}`}>
                    Risk: {aiAnalysis.risk_level}
                  </span>
                  {aiAnalysis.analyzed_at && (
                    <span className="text-[10px] text-indigo-400">Analyzed {new Date(aiAnalysis.analyzed_at).toLocaleString()}</span>
                  )}
                </div>
                <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{aiAnalysis.summary}</p>
                {aiAnalysis.indicators?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-indigo-600 dark:text-indigo-400">Suspicious indicators:</p>
                    <ul className="mt-1 space-y-0.5">
                      {aiAnalysis.indicators.map((ind, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                          <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-red-400" />
                          {ind}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {aiAnalysis.recommended_actions?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-indigo-600 dark:text-indigo-400">Recommended actions:</p>
                    <ul className="mt-1 space-y-0.5">
                      {aiAnalysis.recommended_actions.map((act, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                          <span className="mt-0.5 text-indigo-400">&#8250;</span>
                          {act}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : fraudCase.summary ? (
              <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{fraudCase.summary}</p>
            ) : (
              <p className="text-sm text-zinc-400">No analysis available.</p>
            )}
          </div>

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
          {fraudCase.rule_type === "address_distance" && (
            <AddressDistanceEvidence evidence={evidence} />
          )}
          {fraudCase.rule_type === "name_mismatch" && (
            <NameMismatchEvidence evidence={evidence} />
          )}

          {/* Orders Held */}
          {fraudCase.orders_held && fraudCase.order_ids?.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-5 dark:border-amber-800 dark:bg-amber-950/30">
              <div className="mb-3 flex items-center gap-2">
                <svg className="h-5 w-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
                <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">Orders Held ({fraudCase.order_ids.length})</h3>
                <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                  Held for Review
                </span>
              </div>
              <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">
                These orders are tagged &quot;suspicious&quot; in Shopify and won&apos;t be fulfilled until this case is reviewed. Dismissing the case will remove the tag and release the orders.
              </p>
              <div className="space-y-1.5">
                {fraudCase.order_ids.map((oid) => (
                  <div key={oid} className="flex items-center gap-2 rounded-md border border-amber-200 bg-white px-3 py-2 dark:border-amber-800 dark:bg-amber-950/50">
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Order #{oid}</span>
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">suspicious</span>
                  </div>
                ))}
              </div>
            </div>
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
                  onClick={() => startWizard()}
                  disabled={saving}
                  className="w-full rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  Confirmed Fraud
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

      {/* ═══ CONFIRMED FRAUD WIZARD MODAL ═══ */}
      {wizardOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="relative w-full max-w-lg rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            {/* Close button */}
            {!wizardComplete && (
              <button onClick={() => setWizardOpen(false)} className="absolute right-3 top-3 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}

            {/* Progress bar */}
            <div className="border-b border-zinc-100 px-6 pt-5 pb-4 dark:border-zinc-800">
              <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                {wizardComplete ? "Case Resolved" : "Confirmed Fraud Actions"}
              </h2>
              {!wizardComplete && (
                <div className="mt-3 flex gap-1.5">
                  {["Amplifier Check", "Cancel Subs", "Cancel Orders", "Ban Customer", "Complete"].map((label, i) => (
                    <div key={label} className="flex-1">
                      <div className={`h-1.5 rounded-full transition-colors ${i <= wizardStep ? "bg-red-500" : "bg-zinc-200 dark:bg-zinc-700"}`} />
                      <p className={`mt-1 text-[9px] font-medium ${i === wizardStep ? "text-red-600 dark:text-red-400" : i < wizardStep ? "text-green-600 dark:text-green-400" : "text-zinc-400"}`}>{label}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
              {/* Step 0: Amplifier Check */}
              {wizardStep === 0 && !wizardComplete && (
                <div className="space-y-3">
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">Checking order fulfillment status...</p>
                  {wizardLoading ? (
                    <div className="flex items-center gap-2 py-4">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-red-600" />
                      <span className="text-sm text-zinc-500">Checking Amplifier...</span>
                    </div>
                  ) : wizardAmplifierOrders.length === 0 ? (
                    <div className="rounded-md bg-green-50 p-3 text-sm text-green-700 dark:bg-green-900/20 dark:text-green-400">
                      <span className="mr-1">&#10003;</span> No orders at Amplifier. Safe to proceed.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {wizardAmplifierOrders.map(o => (
                        <div key={o.order_id} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Order #{o.order_number}</span>
                            {!o.at_amplifier ? (
                              <span className="rounded bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">Not at 3PL</span>
                            ) : o.shipped ? (
                              <span className="rounded bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">Already shipped</span>
                            ) : o.cancellable ? (
                              <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Cancellable at Amplifier</span>
                            ) : (
                              <span className="rounded bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600">Status: {o.amplifier_status || "unknown"}</span>
                            )}
                          </div>
                          {o.at_amplifier && o.amplifier_url && (
                            <a href={o.amplifier_url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-indigo-600 hover:underline dark:text-indigo-400">
                              Open in Amplifier &#8599;
                            </a>
                          )}
                          {o.cancellable && (
                            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Cancel this order at Amplifier before proceeding.</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {!wizardLoading && (
                    <button
                      onClick={() => { setWizardStep(1); wizardCancelSubs(); }}
                      className="mt-2 w-full rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
                    >
                      Continue to Cancel Subscriptions
                    </button>
                  )}
                </div>
              )}

              {/* Step 1: Cancel Subscriptions */}
              {wizardStep === 1 && !wizardComplete && (
                <div className="space-y-3">
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">Cancelling all active subscriptions...</p>
                  {wizardLoading ? (
                    <div className="flex items-center gap-2 py-4">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-red-600" />
                      <span className="text-sm text-zinc-500">Cancelling subscriptions via Appstle...</span>
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-500">Processing...</p>
                  )}
                </div>
              )}

              {/* Step 2: Cancel/Refund Orders */}
              {wizardStep === 2 && !wizardComplete && (
                <div className="space-y-3">
                  <p className="mb-1 text-xs font-semibold uppercase text-green-500">Subscriptions Cancelled</p>
                  {wizardSubResults.length === 0 ? (
                    <p className="text-sm text-zinc-400">No active subscriptions found.</p>
                  ) : (
                    <div className="space-y-1">
                      {wizardSubResults.map(r => (
                        <div key={r.subscription_id} className="flex items-center gap-2 text-sm">
                          <span className={r.success ? "text-green-600" : "text-red-500"}>{r.success ? "&#10003;" : "&#10007;"}</span>
                          <span className="text-zinc-700 dark:text-zinc-300">Subscription {r.shopify_contract_id}</span>
                          {r.error && <span className="text-xs text-red-400">({r.error})</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={wizardCancelOrders}
                    disabled={wizardLoading}
                    className="mt-2 w-full rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {wizardLoading ? "Cancelling orders..." : "Cancel & Refund Orders"}
                  </button>
                </div>
              )}

              {/* Step 3: Ban Customer */}
              {wizardStep === 3 && !wizardComplete && (
                <div className="space-y-3">
                  <p className="mb-1 text-xs font-semibold uppercase text-green-500">Orders Cancelled & Refunded</p>
                  {wizardOrderResults.length === 0 ? (
                    <p className="text-sm text-zinc-400">No orders to cancel.</p>
                  ) : (
                    <div className="space-y-1">
                      {wizardOrderResults.map(r => (
                        <div key={r.order_id} className="flex items-center gap-2 text-sm">
                          <span className={r.success ? "text-green-600" : "text-red-500"}>{r.success ? "&#10003;" : "&#10007;"}</span>
                          <span className="text-zinc-700 dark:text-zinc-300">Order #{r.order_number}</span>
                          {r.error && <span className="text-xs text-red-400">({r.error})</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={wizardBanCustomer}
                    disabled={wizardLoading}
                    className="mt-2 w-full rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {wizardLoading ? "Banning customer..." : "Ban Customer from Portal"}
                  </button>
                </div>
              )}

              {/* Step 4: Complete */}
              {wizardStep === 4 && !wizardComplete && (
                <div className="space-y-3">
                  <p className="mb-1 text-xs font-semibold uppercase text-green-500">Customer Banned</p>
                  {wizardBanResults.map(r => (
                    <div key={r.customer_id} className="flex items-center gap-2 text-sm">
                      <span className={r.success ? "text-green-600" : "text-red-500"}>{r.success ? "&#10003;" : "&#10007;"}</span>
                      <span className="text-zinc-700 dark:text-zinc-300">Customer banned from self-service portal</span>
                    </div>
                  ))}
                  <button
                    onClick={wizardFinish}
                    disabled={wizardLoading}
                    className="mt-2 w-full rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {wizardLoading ? "Completing..." : "Mark Case as Confirmed Fraud"}
                  </button>
                </div>
              )}

              {/* Success state */}
              {wizardComplete && (
                <div className="py-6 text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                    <svg className="h-8 w-8 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">Fraud case resolved!</h3>
                  <p className="mt-2 text-sm text-zinc-500">You protected the business. All actions have been completed.</p>
                  <div className="mt-4 space-y-1 text-left">
                    {wizardSubResults.length > 0 && (
                      <p className="text-sm text-zinc-600 dark:text-zinc-400"><span className="text-green-600">&#10003;</span> {wizardSubResults.filter(r => r.success).length} subscription(s) cancelled</p>
                    )}
                    {wizardOrderResults.length > 0 && (
                      <p className="text-sm text-zinc-600 dark:text-zinc-400"><span className="text-green-600">&#10003;</span> {wizardOrderResults.filter(r => r.success).length} order(s) cancelled & refunded</p>
                    )}
                    {wizardBanResults.length > 0 && (
                      <p className="text-sm text-zinc-600 dark:text-zinc-400"><span className="text-green-600">&#10003;</span> Customer banned from portal</p>
                    )}
                    <p className="text-sm text-zinc-600 dark:text-zinc-400"><span className="text-green-600">&#10003;</span> Case marked as confirmed fraud</p>
                  </div>
                  <button
                    onClick={() => setWizardOpen(false)}
                    className="mt-6 rounded-md bg-zinc-900 px-6 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
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

function AddressDistanceEvidence({ evidence }: { evidence: Record<string, unknown> }) {
  const e = evidence as {
    billing_zip: string;
    shipping_zip: string;
    billing_address: string;
    shipping_address: string;
    distance_miles: number;
    threshold_miles: number;
    order_id: string;
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Address Distance Mismatch</h3>
      <div className="space-y-2 text-sm">
        <DetailRow label="Billing" value={`${e.billing_address} (${e.billing_zip})`} />
        <DetailRow label="Shipping" value={`${e.shipping_address} (${e.shipping_zip})`} />
        <DetailRow label="Distance" value={`${e.distance_miles} miles`} />
        <DetailRow label="Threshold" value={`${e.threshold_miles} miles`} />
        <DetailRow label="Order" value={`#${e.order_id}`} />
      </div>
    </div>
  );
}

function NameMismatchEvidence({ evidence }: { evidence: Record<string, unknown> }) {
  const e = evidence as {
    billing_name: string;
    customer_name: string;
    last_names_match: boolean;
    order_id: string;
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Name Mismatch</h3>
      <div className="space-y-2 text-sm">
        <DetailRow label="Billing Name" value={e.billing_name} />
        <DetailRow label="Customer Name" value={e.customer_name} />
        <DetailRow label="Last Names Match" value={e.last_names_match ? "Yes" : "No"} />
        <DetailRow label="Order" value={`#${e.order_id}`} />
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
  line_items: { title?: string; quantity?: number; price?: string }[] | null;
  billing_address: Record<string, string> | null;
  shipping_address: Record<string, string> | null;
  payment_details: { credit_card_number?: string; credit_card_company?: string; gateway?: string } | null;
  amplifier_order_id: string | null;
  amplifier_status: string | null;
  amplifier_shipped_at: string | null;
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

      {/* Recent Orders (Enhanced) */}
      {orders.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Orders ({orders.length})</h3>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {orders.slice(0, 20).map((o) => {
              const owner = customers.find(c => c.id === o.customer_id);
              const items = (o.line_items as { title?: string; quantity?: number; price?: string }[] | null) || [];
              const billing = o.billing_address as Record<string, string> | null;
              const shipping = o.shipping_address as Record<string, string> | null;
              const payment = o.payment_details as { credit_card_number?: string; credit_card_company?: string; gateway?: string } | null;

              // Fraud indicators
              const billingName = billing ? `${billing.first_name || ""} ${billing.last_name || ""}`.trim() : "";
              const custName = owner ? `${owner.first_name || ""} ${owner.last_name || ""}`.trim() : "";
              const nameMismatch = billingName && custName && billingName.toLowerCase() !== custName.toLowerCase();
              const billingZip = billing?.zip || "";
              const shippingZip = shipping?.zip || "";
              const zipMismatch = billingZip && shippingZip && billingZip !== shippingZip;
              const emailDomain = owner?.email?.split("@")[1] || "";
              const susEmail = owner?.email?.includes("+") || /^[a-z]{10,}[0-9]+@/.test(owner?.email || "");
              const isGibberish = (name: string) => /^[a-z]{1,2}[a-z]{8,}$/i.test(name.replace(/\s/g, "")) && !/[aeiou]{2,}/i.test(name);
              const gibberishName = isGibberish(billingName) || isGibberish(custName);

              return (
                <div key={o.id} className="px-5 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">#{o.order_number || o.id.slice(0, 8)}</span>
                      <span className="text-xs text-zinc-400">{new Date(o.created_at).toLocaleDateString()}</span>
                      <span className="text-sm font-medium tabular-nums text-zinc-600 dark:text-zinc-400">
                        {o.total_price_cents != null ? formatCents(o.total_price_cents) : "—"}
                      </span>
                      {owner?.is_linked && <span className="rounded bg-blue-100 px-1 py-0.5 text-[10px] text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">linked</span>}
                    </div>
                    {o.amplifier_order_id && (
                      <a href={`https://my.amplifier.com/orders/${o.amplifier_order_id}`} target="_blank" rel="noopener noreferrer" className="text-[10px] text-indigo-600 hover:underline dark:text-indigo-400">
                        Amplifier{o.amplifier_shipped_at ? " (shipped)" : ""}
                      </a>
                    )}
                  </div>

                  {/* Line items */}
                  <div className="mt-1 space-y-0.5">
                    {items.map((item, i) => (
                      <p key={i} className="text-xs text-zinc-500">{item.quantity || 1}x {item.title || "Item"}{item.price ? ` @ $${item.price}` : ""}</p>
                    ))}
                  </div>

                  {/* Address + Payment row */}
                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
                    {billing && (
                      <div>
                        <span className="font-medium text-zinc-500">Billing:</span>{" "}
                        <span className={nameMismatch || gibberishName ? "rounded bg-red-100 px-1 text-red-700 dark:bg-red-900/30 dark:text-red-400" : "text-zinc-400"}>
                          {billingName || "—"}
                        </span>
                        <span className={`ml-1 ${zipMismatch ? "rounded bg-red-100 px-1 text-red-700 dark:bg-red-900/30 dark:text-red-400" : "text-zinc-400"}`}>
                          {billing.city ? `${billing.city}, ${billing.province || ""} ${billingZip}` : billingZip}
                        </span>
                      </div>
                    )}
                    {shipping && (
                      <div>
                        <span className="font-medium text-zinc-500">Shipping:</span>{" "}
                        <span className="text-zinc-400">
                          {shipping.city ? `${shipping.city}, ${shipping.province || ""} ${shipping.zip || ""}` : shipping.address1 || "—"}
                        </span>
                      </div>
                    )}
                    {payment && (
                      <div>
                        <span className="font-medium text-zinc-500">Payment:</span>{" "}
                        <span className="text-zinc-400">{payment.credit_card_company || ""} {payment.credit_card_number || ""}</span>
                      </div>
                    )}
                  </div>

                  {/* Fraud indicator badges */}
                  {(nameMismatch || zipMismatch || susEmail || gibberishName) && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {nameMismatch && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">Name mismatch</span>}
                      {zipMismatch && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">ZIP mismatch</span>}
                      {gibberishName && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">Gibberish name</span>}
                      {susEmail && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Suspicious email</span>}
                    </div>
                  )}
                </div>
              );
            })}
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
