"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface PlaybookStep {
  id: string;
  step_order: number;
  type: string;
  name: string;
  instructions: string | null;
  data_access: string[];
  resolved_condition: string | null;
  config: Record<string, unknown>;
  skippable: boolean;
}

interface PlaybookException {
  id: string;
  tier: number;
  name: string;
  conditions: Record<string, unknown>;
  resolution_type: string;
  instructions: string | null;
  auto_grant: boolean;
  auto_grant_trigger: string | null;
}

interface PlaybookPolicy {
  id: string;
  name: string;
  description: string | null;
  conditions: Record<string, unknown>;
  ai_talking_points: string | null;
}

interface Playbook {
  id: string;
  name: string;
  description: string | null;
  trigger_intents: string[];
  trigger_patterns: string[];
  priority: number;
  is_active: boolean;
  exception_limit: number;
  stand_firm_max: number;
  policies: PlaybookPolicy[];
  exceptions: PlaybookException[];
  steps: PlaybookStep[];
}

const STEP_TYPES = [
  { value: "identify_order", label: "Identify Order" },
  { value: "identify_subscription", label: "Identify Subscription" },
  { value: "check_other_subscriptions", label: "Check Other Subscriptions" },
  { value: "apply_policy", label: "Apply Policy" },
  { value: "offer_exception", label: "Offer Exception" },
  { value: "initiate_return", label: "Initiate Return" },
  { value: "explain", label: "Explain / Inform" },
  { value: "stand_firm", label: "Stand Firm" },
  { value: "cancel_subscription", label: "Cancel Subscription" },
  { value: "issue_store_credit", label: "Issue Store Credit" },
  { value: "custom", label: "Custom" },
];

const RESOLUTION_TYPES = [
  { value: "store_credit_return", label: "Store Credit (with return)" },
  { value: "refund_return", label: "Refund (with return)" },
  { value: "store_credit_no_return", label: "Store Credit (no return)" },
  { value: "refund_no_return", label: "Refund (no return)" },
];

function StepIcon({ type }: { type: string }) {
  const icons: Record<string, string> = {
    identify_order: "1", identify_subscription: "2", check_other_subscriptions: "3",
    apply_policy: "P", offer_exception: "E", initiate_return: "R",
    explain: "i", stand_firm: "!", cancel_subscription: "X",
    issue_store_credit: "$", custom: "*",
  };
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
      {icons[type] || "?"}
    </span>
  );
}

export default function PlaybooksSettingsPage() {
  const workspace = useWorkspace();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/playbooks`);
      if (res.ok) {
        const data = await res.json();
        setPlaybooks(data.playbooks || []);
      }
    } catch {}
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toggleActive = async (pb: Playbook) => {
    await fetch(`/api/workspaces/${workspace.id}/playbooks`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playbook_id: pb.id, is_active: !pb.is_active }),
    });
    await fetchData();
  };

  if (loading) {
    return <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6"><p className="text-sm text-zinc-400">Loading playbooks...</p></div>;
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Playbooks</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Structured decision trees that guide AI and agents through complex customer issues.
        </p>
      </div>

      <div className="space-y-4">
        {playbooks.map(pb => (
          <div key={pb.id} className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            {/* Header */}
            <div className="flex items-center gap-3 p-5">
              <button
                onClick={() => setExpanded(expanded === pb.id ? null : pb.id)}
                className="flex-1 text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{pb.name}</h3>
                      <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-mono text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400">
                        P{pb.priority}
                      </span>
                    </div>
                    {pb.description && <p className="mt-0.5 text-xs text-zinc-500 truncate">{pb.description}</p>}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {pb.trigger_intents.slice(0, 3).map(i => (
                        <span key={i} className="rounded bg-cyan-100 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300">{i}</span>
                      ))}
                      {pb.trigger_intents.length > 3 && (
                        <span className="text-[10px] text-zinc-400">+{pb.trigger_intents.length - 3} more</span>
                      )}
                    </div>
                  </div>
                  <svg className={`h-4 w-4 text-zinc-400 transition-transform ${expanded === pb.id ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </button>
              <button
                onClick={() => toggleActive(pb)}
                className={`relative h-5 w-9 rounded-full transition-colors ${pb.is_active ? "bg-indigo-500" : "bg-zinc-300 dark:bg-zinc-600"}`}
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${pb.is_active ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>

            {/* Expanded detail */}
            {expanded === pb.id && (
              <div className="border-t border-zinc-100 p-5 dark:border-zinc-800 space-y-4">
                {/* Stats row */}
                <div className="flex gap-4 text-xs text-zinc-500">
                  <span>{pb.steps.length} steps</span>
                  <span>{pb.policies.length} {pb.policies.length === 1 ? "policy" : "policies"}</span>
                  <span>{pb.exceptions.length} exceptions</span>
                  <span>Exception limit: {pb.exception_limit}/ticket</span>
                  <span>Stand firm max: {pb.stand_firm_max}</span>
                </div>

                {/* Trigger patterns */}
                {pb.trigger_patterns.length > 0 && (
                  <div>
                    <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-1">Trigger Patterns</h4>
                    <div className="flex flex-wrap gap-1">
                      {pb.trigger_patterns.map(p => (
                        <span key={p} className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900 dark:text-amber-300">&ldquo;{p}&rdquo;</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Policies */}
                {pb.policies.length > 0 && (
                  <div>
                    <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Policies</h4>
                    {pb.policies.map(pol => (
                      <div key={pol.id} className="rounded-md border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-800/50 mb-2">
                        <div className="font-medium text-sm text-zinc-900 dark:text-zinc-100">{pol.name}</div>
                        {pol.description && <p className="text-xs text-zinc-500 mt-0.5">{pol.description}</p>}
                        <div className="mt-1 text-[10px] text-zinc-400 font-mono">
                          Conditions: {JSON.stringify(pol.conditions)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Exceptions */}
                {pb.exceptions.length > 0 && (
                  <div>
                    <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Exceptions</h4>
                    {pb.exceptions.map(ex => (
                      <div key={ex.id} className={`rounded-md border p-3 mb-2 ${ex.auto_grant ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950" : "border-zinc-100 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/50"}`}>
                        <div className="flex items-center gap-2">
                          {ex.auto_grant ? (
                            <span className="rounded bg-emerald-200 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-800 dark:text-emerald-300">AUTO</span>
                          ) : (
                            <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400">Tier {ex.tier}</span>
                          )}
                          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{ex.name}</span>
                          <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
                            {RESOLUTION_TYPES.find(r => r.value === ex.resolution_type)?.label || ex.resolution_type}
                          </span>
                        </div>
                        {ex.instructions && <p className="text-xs text-zinc-500 mt-1">{ex.instructions}</p>}
                        {!ex.auto_grant && (
                          <div className="mt-1 text-[10px] text-zinc-400 font-mono">
                            Conditions: {JSON.stringify(ex.conditions)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Steps */}
                <div>
                  <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Steps</h4>
                  <div className="space-y-2">
                    {pb.steps.map((s, i) => (
                      <div key={s.id} className="flex items-start gap-3 rounded-md border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-800/50">
                        <StepIcon type={s.type} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{s.name}</span>
                            <span className="rounded bg-zinc-200 px-1 py-0.5 text-[10px] font-mono text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">{s.type}</span>
                            {s.skippable && <span className="text-[10px] text-zinc-400">skippable</span>}
                          </div>
                          {s.instructions && <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{s.instructions}</p>}
                        </div>
                        <span className="text-xs text-zinc-400 tabular-nums">{i + 1}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {playbooks.length === 0 && (
          <div className="text-center py-12 text-sm text-zinc-400">
            No playbooks configured yet.
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="mt-6 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/50 p-5 dark:border-zinc-700 dark:bg-zinc-900/50">
        <h3 className="mb-2 text-sm font-semibold text-zinc-600 dark:text-zinc-400">How playbooks work</h3>
        <div className="space-y-2 text-xs text-zinc-500">
          <div className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            <p><span className="font-medium">Trigger:</span> When AI classifies an intent that matches a playbook&apos;s trigger intents or patterns, the playbook activates.</p>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            <p><span className="font-medium">Steps:</span> AI follows each step in order — investigating, explaining policy, offering exceptions. Steps can be skipped if already answered.</p>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            <p><span className="font-medium">Exceptions:</span> Tiered offers based on customer LTV/history. Exception limit prevents gaming (default: 1 per ticket).</p>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            <p><span className="font-medium">Stand firm:</span> If customer rejects all offers, AI acknowledges frustration but holds position. After max attempts, leaves offer on the table and stops.</p>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            <p><span className="font-medium">Priority:</span> Higher priority playbooks run first. Only one active per ticket, extras queued.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
