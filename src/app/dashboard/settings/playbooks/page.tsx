"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface SimStepResult {
  step_name: string;
  step_type: string;
  step_order: number;
  data_found: string;
  condition_result: string;
  ai_response: string;
  mock_customer_reply: string;
  warnings: string[];
  skipped: boolean;
}

interface SimResult {
  playbook_name: string;
  customer_name: string;
  customer_email: string;
  sentiment: string;
  initial_message: string;
  steps: SimStepResult[];
  ref: string | null;
}

interface CustomerOption {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

const SENTIMENTS = [
  { value: "angry", label: "Angry", color: "text-red-600 bg-red-50" },
  { value: "frustrated", label: "Frustrated", color: "text-amber-600 bg-amber-50" },
  { value: "confused", label: "Confused", color: "text-blue-600 bg-blue-50" },
  { value: "neutral", label: "Neutral", color: "text-zinc-600 bg-zinc-100" },
  { value: "polite", label: "Polite", color: "text-emerald-600 bg-emerald-50" },
];

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
  policy_id: string;
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

const AUTO_GRANT_TRIGGERS = [
  { value: "duplicate_charge", label: "Duplicate charge" },
  { value: "cancelled_but_charged", label: "Cancelled but charged" },
  { value: "never_delivered", label: "Never delivered" },
];

const DATA_ACCESS_OPTIONS = [
  "recent_orders", "subscriptions", "customer_events", "fulfillments", "payment_methods",
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

function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [input, setInput] = useState("");
  const add = () => {
    const trimmed = input.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInput("");
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-1">
        {value.map((v, i) => (
          <span key={i} className="inline-flex items-center gap-1 rounded bg-zinc-200 px-2 py-0.5 text-xs dark:bg-zinc-700 dark:text-zinc-300">
            {v}
            <button onClick={() => onChange(value.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-red-500">&times;</button>
          </span>
        ))}
      </div>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        onBlur={add}
        placeholder={placeholder}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
      />
    </div>
  );
}

function ConditionEditor({ value, onChange }: { value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const [raw, setRaw] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState("");

  useEffect(() => { setRaw(JSON.stringify(value, null, 2)); }, [value]);

  const handleBlur = () => {
    try {
      const parsed = JSON.parse(raw);
      setError("");
      onChange(parsed);
    } catch {
      setError("Invalid JSON");
    }
  };

  return (
    <div>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={handleBlur}
        rows={3}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-mono dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
      />
      {error && <p className="text-xs text-red-500 mt-0.5">{error}</p>}
      <p className="text-[10px] text-zinc-400 mt-0.5">
        Example: {`{ "days_since_fulfillment": { "<=": 30 } }`} or {`{ "or": [{ "ltv_cents": { ">=": 30000 } }] }`}
      </p>
    </div>
  );
}

function formatSimForLLM(sim: SimResult): string {
  const lines: string[] = [];
  lines.push(`# Playbook Simulation: ${sim.playbook_name}`);
  lines.push(`Customer: ${sim.customer_name} (${sim.customer_email})`);
  lines.push(`Sentiment: ${sim.sentiment}`);
  if (sim.ref) lines.push(`Ref: ${sim.ref.slice(0, 8)}`);
  lines.push(`\n## Initial Message\n"${sim.initial_message}"`);

  for (const s of sim.steps) {
    lines.push(`\n---\n## Step ${s.step_order + 1}: ${s.step_name} [${s.step_type}]${s.skipped ? " (SKIPPED)" : ""}`);
    lines.push(`\n**Data Found:**\n${s.data_found || "—"}`);
    lines.push(`\n**Condition Result:** ${s.condition_result || "—"}`);
    if (s.warnings.length > 0) {
      lines.push(`\n**Warnings:**`);
      for (const w of s.warnings) lines.push(`- ${w}`);
    }
    if (s.ai_response && !s.skipped) {
      lines.push(`\n**AI Response:**\n> ${s.ai_response}`);
    }
    if (s.mock_customer_reply) {
      lines.push(`\n**Mock Customer Reply (${sim.sentiment}):**\n> "${s.mock_customer_reply}"`);
    }
  }

  const totalWarnings = sim.steps.reduce((n, s) => n + s.warnings.length, 0);
  lines.push(`\n---\n## Summary`);
  lines.push(`- ${sim.steps.length} steps, ${sim.steps.filter(s => s.skipped).length} skipped`);
  lines.push(`- ${totalWarnings} warnings`);
  return lines.join("\n");
}

export default function PlaybooksSettingsPage() {
  const workspace = useWorkspace();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Playbook | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");

  // Sub-editor state
  const [editingStep, setEditingStep] = useState<PlaybookStep | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<PlaybookPolicy | null>(null);
  const [editingException, setEditingException] = useState<PlaybookException | null>(null);

  // Simulation state
  const [simModal, setSimModal] = useState<string | null>(null); // playbook ID
  const [simCustomers, setSimCustomers] = useState<CustomerOption[]>([]);
  const [simSearch, setSimSearch] = useState("");
  const [simCustomerId, setSimCustomerId] = useState("");
  const [simMessage, setSimMessage] = useState("");
  const [simSentiment, setSimSentiment] = useState("angry");
  const [simRunning, setSimRunning] = useState(false);
  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const simSearchTimer = useRef<NodeJS.Timeout | null>(null);

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

  const searchCustomers = useCallback(async (q: string) => {
    if (q.length < 2) { setSimCustomers([]); return; }
    try {
      const res = await fetch(`/api/customers?search=${encodeURIComponent(q)}&limit=10`);
      if (res.ok) {
        const data = await res.json();
        setSimCustomers((data.customers || []).map((c: CustomerOption & Record<string, unknown>) => ({
          id: c.id, email: c.email, first_name: c.first_name, last_name: c.last_name,
        })));
      }
    } catch {}
  }, []);

  const handleSimSearchChange = (q: string) => {
    setSimSearch(q);
    if (simSearchTimer.current) clearTimeout(simSearchTimer.current);
    simSearchTimer.current = setTimeout(() => searchCustomers(q), 300);
  };

  const openSimModal = (pbId: string) => {
    setSimModal(pbId);
    setSimResult(null);
    setSimCustomerId("");
    setSimSearch("");
    setSimMessage("");
    setSimSentiment("angry");
    setSimCustomers([]);
  };

  const runSimulation = async () => {
    if (!simModal || !simCustomerId || !simMessage) return;
    setSimRunning(true);
    setSimResult(null);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/playbooks/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playbook_id: simModal,
          customer_id: simCustomerId,
          message: simMessage,
          sentiment: simSentiment,
        }),
      });
      if (res.ok) {
        setSimResult(await res.json());
      }
    } catch {}
    setSimRunning(false);
  };

  const toggleActive = async (pb: Playbook) => {
    await fetch(`/api/workspaces/${workspace.id}/playbooks`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playbook_id: pb.id, is_active: !pb.is_active }),
    });
    await fetchData();
  };

  const startEdit = (pb: Playbook) => {
    setEditing(pb.id);
    setExpanded(pb.id);
    setDraft(JSON.parse(JSON.stringify(pb)));
    setEditingStep(null);
    setEditingPolicy(null);
    setEditingException(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraft(null);
    setEditingStep(null);
    setEditingPolicy(null);
    setEditingException(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    const isNew = draft.id.startsWith("new_");

    if (isNew) {
      // Create playbook first, then save children
      const res = await fetch(`/api/workspaces/${workspace.id}/playbooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          description: draft.description,
          trigger_intents: draft.trigger_intents,
          trigger_patterns: draft.trigger_patterns,
          priority: draft.priority,
          is_active: draft.is_active,
          exception_limit: draft.exception_limit,
          stand_firm_max: draft.stand_firm_max,
        }),
      });
      if (res.ok) {
        const { id } = await res.json();
        // Now save children
        await fetch(`/api/workspaces/${workspace.id}/playbooks`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            playbook_id: id,
            steps: draft.steps,
            policies: draft.policies,
            exceptions: draft.exceptions,
          }),
        });
      }
    } else {
      await fetch(`/api/workspaces/${workspace.id}/playbooks`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playbook_id: draft.id,
          name: draft.name,
          description: draft.description,
          trigger_intents: draft.trigger_intents,
          trigger_patterns: draft.trigger_patterns,
          priority: draft.priority,
          exception_limit: draft.exception_limit,
          stand_firm_max: draft.stand_firm_max,
          steps: draft.steps,
          policies: draft.policies,
          exceptions: draft.exceptions,
        }),
      });
    }

    setSaving(false);
    setSaved(draft.id);
    setTimeout(() => setSaved(""), 2000);
    cancelEdit();
    await fetchData();
  };

  const deletePlaybook = async (id: string) => {
    if (!confirm("Delete this playbook? This cannot be undone.")) return;
    await fetch(`/api/workspaces/${workspace.id}/playbooks?id=${id}`, { method: "DELETE" });
    await fetchData();
  };

  const addPlaybook = () => {
    const newPb: Playbook = {
      id: "new_" + Date.now(),
      name: "",
      description: null,
      trigger_intents: [],
      trigger_patterns: [],
      priority: playbooks.length,
      is_active: true,
      exception_limit: 1,
      stand_firm_max: 3,
      policies: [],
      exceptions: [],
      steps: [],
    };
    startEdit(newPb);
  };

  // --- Step helpers ---
  const addStep = () => {
    setEditingStep({
      id: "new_" + Date.now(),
      step_order: draft?.steps.length || 0,
      type: "explain",
      name: "",
      instructions: null,
      data_access: [],
      resolved_condition: null,
      config: {},
      skippable: true,
    });
  };

  const saveStep = () => {
    if (!draft || !editingStep || !editingStep.name) return;
    const isNew = !draft.steps.find(s => s.id === editingStep.id);
    const steps = isNew
      ? [...draft.steps, editingStep]
      : draft.steps.map(s => s.id === editingStep.id ? editingStep : s);
    setDraft({ ...draft, steps });
    setEditingStep(null);
  };

  const deleteStep = (id: string) => {
    if (!draft) return;
    setDraft({ ...draft, steps: draft.steps.filter(s => s.id !== id) });
  };

  const moveStep = (idx: number, dir: -1 | 1) => {
    if (!draft) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[idx], steps[swap]] = [steps[swap], steps[idx]];
    steps.forEach((s, i) => { s.step_order = i; });
    setDraft({ ...draft, steps });
  };

  // --- Policy helpers ---
  const addPolicy = () => {
    setEditingPolicy({
      id: "new_" + Date.now(),
      name: "",
      description: null,
      conditions: {},
      ai_talking_points: null,
    });
  };

  const savePolicy = () => {
    if (!draft || !editingPolicy || !editingPolicy.name) return;
    const isNew = !draft.policies.find(p => p.id === editingPolicy.id);
    const policies = isNew
      ? [...draft.policies, editingPolicy]
      : draft.policies.map(p => p.id === editingPolicy.id ? editingPolicy : p);
    setDraft({ ...draft, policies });
    setEditingPolicy(null);
  };

  const deletePolicy = (id: string) => {
    if (!draft) return;
    setDraft({
      ...draft,
      policies: draft.policies.filter(p => p.id !== id),
      exceptions: draft.exceptions.filter(e => e.policy_id !== id),
    });
  };

  // --- Exception helpers ---
  const addException = (policyId: string) => {
    setEditingException({
      id: "new_" + Date.now(),
      tier: (draft?.exceptions.filter(e => e.policy_id === policyId).length || 0) + 1,
      name: "",
      conditions: {},
      resolution_type: "store_credit_return",
      instructions: null,
      auto_grant: false,
      auto_grant_trigger: null,
      policy_id: policyId,
    });
  };

  const saveException = () => {
    if (!draft || !editingException || !editingException.name) return;
    const isNew = !draft.exceptions.find(e => e.id === editingException.id);
    const exceptions = isNew
      ? [...draft.exceptions, editingException]
      : draft.exceptions.map(e => e.id === editingException.id ? editingException : e);
    setDraft({ ...draft, exceptions });
    setEditingException(null);
  };

  const deleteException = (id: string) => {
    if (!draft) return;
    setDraft({ ...draft, exceptions: draft.exceptions.filter(e => e.id !== id) });
  };

  // --- Priority reorder ---
  const movePriority = (idx: number, dir: -1 | 1) => {
    const swap = idx + dir;
    if (swap < 0 || swap >= playbooks.length) return;
    const updated = [...playbooks];
    [updated[idx], updated[swap]] = [updated[swap], updated[idx]];
    // Re-assign priorities (index 0 = highest priority = largest number)
    updated.forEach((pb, i) => { pb.priority = updated.length - i; });
    setPlaybooks(updated);
    // Save priority updates
    Promise.all(updated.map(pb =>
      fetch(`/api/workspaces/${workspace.id}/playbooks`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playbook_id: pb.id, priority: pb.priority }),
      })
    ));
  };

  if (loading) {
    return <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6"><p className="text-sm text-zinc-400">Loading playbooks...</p></div>;
  }

  const isEditing = editing !== null;
  const pb_list = isEditing && draft && draft.id.startsWith("new_")
    ? [...playbooks, draft]
    : playbooks;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Playbooks</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Structured decision trees that guide AI and agents through complex customer issues.
          </p>
        </div>
        {!isEditing && (
          <button onClick={addPlaybook} className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600">
            Add Playbook
          </button>
        )}
      </div>

      <div className="space-y-4">
        {pb_list.map((pb, pbIdx) => {
          const isThisEditing = editing === pb.id;
          const d = isThisEditing ? draft! : pb;

          return (
            <div key={pb.id} className={`rounded-lg border bg-white dark:bg-zinc-900 ${isThisEditing ? "border-indigo-300 dark:border-indigo-700" : "border-zinc-200 dark:border-zinc-800"}`}>
              {/* Header */}
              <div className="flex items-center gap-3 p-5">
                {/* Priority reorder arrows (only in non-edit mode) */}
                {!isEditing && playbooks.length > 1 && (
                  <div className="flex flex-col gap-0.5">
                    <button onClick={() => movePriority(pbIdx, -1)} disabled={pbIdx === 0} className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-30">&#9650;</button>
                    <button onClick={() => movePriority(pbIdx, 1)} disabled={pbIdx === playbooks.length - 1} className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-30">&#9660;</button>
                  </div>
                )}
                <button
                  onClick={() => !isEditing && setExpanded(expanded === pb.id ? null : pb.id)}
                  className="flex-1 text-left"
                  disabled={isEditing && !isThisEditing}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{d.name || "(unnamed)"}</h3>
                        <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-mono text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400">
                          P{d.priority}
                        </span>
                        {saved === pb.id && <span className="text-xs text-green-600">Saved</span>}
                      </div>
                      {d.description && <p className="mt-0.5 text-xs text-zinc-500 truncate">{d.description}</p>}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {d.trigger_intents.slice(0, 3).map(i => (
                          <span key={i} className="rounded bg-cyan-100 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300">{i}</span>
                        ))}
                        {d.trigger_intents.length > 3 && (
                          <span className="text-[10px] text-zinc-400">+{d.trigger_intents.length - 3} more</span>
                        )}
                      </div>
                    </div>
                    {!isEditing && (
                      <svg className={`h-4 w-4 text-zinc-400 transition-transform ${expanded === pb.id ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    )}
                  </div>
                </button>
                {!isEditing && (
                  <div className="flex items-center gap-2">
                    <button onClick={() => openSimModal(pb.id)} className="text-xs text-violet-500 hover:text-violet-700">Simulate</button>
                    <button onClick={() => startEdit(pb)} className="text-xs text-indigo-500 hover:text-indigo-700">Edit</button>
                    <button onClick={() => deletePlaybook(pb.id)} className="text-xs text-red-400 hover:text-red-600">Delete</button>
                    <button
                      onClick={() => toggleActive(pb)}
                      className={`relative h-5 w-9 rounded-full transition-colors ${pb.is_active ? "bg-indigo-500" : "bg-zinc-300 dark:bg-zinc-600"}`}
                    >
                      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${pb.is_active ? "left-[18px]" : "left-0.5"}`} />
                    </button>
                  </div>
                )}
              </div>

              {/* ── EDIT MODE ── */}
              {isThisEditing && draft && (
                <div className="border-t border-indigo-200 p-5 dark:border-indigo-800 space-y-5">
                  {/* Basic fields */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 mb-1">Name</label>
                      <input
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                        placeholder="e.g. Unwanted Charge"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 mb-1">Description</label>
                      <input
                        value={draft.description || ""}
                        onChange={(e) => setDraft({ ...draft, description: e.target.value || null })}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                        placeholder="Admin-facing summary"
                      />
                    </div>
                  </div>

                  {/* Triggers */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 mb-1">Trigger Intents</label>
                      <TagInput
                        value={draft.trigger_intents}
                        onChange={(v) => setDraft({ ...draft, trigger_intents: v })}
                        placeholder="Add intent and press Enter"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 mb-1">Trigger Patterns</label>
                      <TagInput
                        value={draft.trigger_patterns}
                        onChange={(v) => setDraft({ ...draft, trigger_patterns: v })}
                        placeholder="Add pattern and press Enter"
                      />
                    </div>
                  </div>

                  {/* Settings row */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 mb-1">Exception limit per ticket</label>
                      <input
                        type="number"
                        min={0}
                        value={draft.exception_limit}
                        onChange={(e) => setDraft({ ...draft, exception_limit: parseInt(e.target.value) || 0 })}
                        className="w-24 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-zinc-500 mb-1">Stand firm max repetitions</label>
                      <input
                        type="number"
                        min={1}
                        value={draft.stand_firm_max}
                        onChange={(e) => setDraft({ ...draft, stand_firm_max: parseInt(e.target.value) || 3 })}
                        className="w-24 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                      />
                    </div>
                  </div>

                  {/* ── STEPS ── */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Steps</h4>
                      <button onClick={addStep} className="rounded bg-indigo-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-600">
                        Add Step
                      </button>
                    </div>
                    <div className="space-y-2">
                      {draft.steps.map((s, i) => (
                        <div key={s.id} className="flex items-start gap-3 rounded-md border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-800/50">
                          <div className="flex flex-col gap-0.5 pt-0.5">
                            <button onClick={() => moveStep(i, -1)} disabled={i === 0} className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-30">&#9650;</button>
                            <button onClick={() => moveStep(i, 1)} disabled={i === draft.steps.length - 1} className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-30">&#9660;</button>
                          </div>
                          <StepIcon type={s.type} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{s.name}</span>
                              <span className="rounded bg-zinc-200 px-1 py-0.5 text-[10px] font-mono text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">{s.type}</span>
                              {s.skippable && <span className="text-[10px] text-zinc-400">skippable</span>}
                            </div>
                            {s.instructions && <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{s.instructions}</p>}
                          </div>
                          <div className="flex items-center gap-1">
                            <button onClick={() => setEditingStep({ ...s })} className="text-xs text-indigo-500 hover:text-indigo-700">Edit</button>
                            <button onClick={() => deleteStep(s.id)} className="text-xs text-red-400 hover:text-red-600">Delete</button>
                          </div>
                          <span className="text-xs text-zinc-400 tabular-nums">{i + 1}</span>
                        </div>
                      ))}
                      {draft.steps.length === 0 && <p className="text-xs text-zinc-400 py-2 text-center">No steps yet.</p>}
                    </div>

                    {/* Step editor */}
                    {editingStep && (
                      <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950 space-y-3">
                        <h5 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                          {draft.steps.find(s => s.id === editingStep.id) ? "Edit Step" : "Add Step"}
                        </h5>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <label className="block text-xs font-medium text-zinc-500 mb-1">Name</label>
                            <input
                              value={editingStep.name}
                              onChange={(e) => setEditingStep({ ...editingStep, name: e.target.value })}
                              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                              placeholder="e.g. Identify the order"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-zinc-500 mb-1">Type</label>
                            <select
                              value={editingStep.type}
                              onChange={(e) => setEditingStep({ ...editingStep, type: e.target.value })}
                              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            >
                              {STEP_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                            </select>
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 mb-1">Instructions (AI guidance)</label>
                          <textarea
                            value={editingStep.instructions || ""}
                            onChange={(e) => setEditingStep({ ...editingStep, instructions: e.target.value || null })}
                            rows={3}
                            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            placeholder="What should the AI do at this step?"
                          />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <label className="block text-xs font-medium text-zinc-500 mb-1">Data to fetch</label>
                            <div className="flex flex-wrap gap-2">
                              {DATA_ACCESS_OPTIONS.map(opt => (
                                <label key={opt} className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                                  <input
                                    type="checkbox"
                                    checked={editingStep.data_access.includes(opt)}
                                    onChange={(e) => {
                                      const da = e.target.checked
                                        ? [...editingStep.data_access, opt]
                                        : editingStep.data_access.filter(d => d !== opt);
                                      setEditingStep({ ...editingStep, data_access: da });
                                    }}
                                    className="rounded border-zinc-300"
                                  />
                                  {opt}
                                </label>
                              ))}
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-zinc-500 mb-1">Resolved condition</label>
                            <input
                              value={editingStep.resolved_condition || ""}
                              onChange={(e) => setEditingStep({ ...editingStep, resolved_condition: e.target.value || null })}
                              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                              placeholder="e.g. order_identified"
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                            <input
                              type="checkbox"
                              checked={editingStep.skippable}
                              onChange={(e) => setEditingStep({ ...editingStep, skippable: e.target.checked })}
                              className="rounded border-zinc-300"
                            />
                            Skippable (AI can skip if already answered)
                          </label>
                        </div>
                        {(editingStep.type === "apply_policy" || editingStep.type === "offer_exception") && draft.policies.length > 0 && (
                          <div>
                            <label className="block text-xs font-medium text-zinc-500 mb-1">Linked policy</label>
                            <select
                              value={String((editingStep.config as Record<string, unknown>)?.policy_id || "")}
                              onChange={(e) => setEditingStep({ ...editingStep, config: { ...editingStep.config, policy_id: e.target.value || undefined } })}
                              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            >
                              <option value="">Select policy...</option>
                              {draft.policies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </div>
                        )}
                        <div className="flex gap-2">
                          <button onClick={saveStep} disabled={!editingStep.name} className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50">Save Step</button>
                          <button onClick={() => setEditingStep(null)} className="text-xs text-zinc-500 hover:text-zinc-700">Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ── POLICIES ── */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Policies</h4>
                      <button onClick={addPolicy} className="rounded bg-indigo-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-600">
                        Add Policy
                      </button>
                    </div>
                    <div className="space-y-2">
                      {draft.policies.map(pol => {
                        const polExceptions = draft.exceptions.filter(e => e.policy_id === pol.id);
                        return (
                          <div key={pol.id} className="rounded-md border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-800/50">
                            <div className="flex items-start justify-between">
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm text-zinc-900 dark:text-zinc-100">{pol.name}</div>
                                {pol.description && <p className="text-xs text-zinc-500 mt-0.5">{pol.description}</p>}
                                <div className="mt-1 text-[10px] text-zinc-400 font-mono">
                                  Conditions: {JSON.stringify(pol.conditions)}
                                </div>
                                {pol.ai_talking_points && <p className="text-[10px] text-zinc-400 mt-0.5">Talking points: {pol.ai_talking_points}</p>}
                              </div>
                              <div className="flex items-center gap-1 ml-2">
                                <button onClick={() => setEditingPolicy({ ...pol })} className="text-xs text-indigo-500 hover:text-indigo-700">Edit</button>
                                <button onClick={() => deletePolicy(pol.id)} className="text-xs text-red-400 hover:text-red-600">Delete</button>
                              </div>
                            </div>

                            {/* Exceptions under this policy */}
                            <div className="mt-2 pl-3 border-l-2 border-zinc-200 dark:border-zinc-700 space-y-1.5">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">Exceptions</span>
                                <button onClick={() => addException(pol.id)} className="text-[10px] text-indigo-500 hover:text-indigo-700">+ Add</button>
                              </div>
                              {polExceptions.map(ex => (
                                <div key={ex.id} className={`rounded-md border p-2 ${ex.auto_grant ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950" : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800"}`}>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      {ex.auto_grant ? (
                                        <span className="rounded bg-emerald-200 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-800 dark:text-emerald-300">AUTO: {ex.auto_grant_trigger}</span>
                                      ) : (
                                        <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400">Tier {ex.tier}</span>
                                      )}
                                      <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{ex.name}</span>
                                      <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
                                        {RESOLUTION_TYPES.find(r => r.value === ex.resolution_type)?.label || ex.resolution_type}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                      <button onClick={() => setEditingException({ ...ex })} className="text-[10px] text-indigo-500 hover:text-indigo-700">Edit</button>
                                      <button onClick={() => deleteException(ex.id)} className="text-[10px] text-red-400 hover:text-red-600">Delete</button>
                                    </div>
                                  </div>
                                  {ex.instructions && <p className="text-[10px] text-zinc-500 mt-1">{ex.instructions}</p>}
                                </div>
                              ))}
                              {polExceptions.length === 0 && <p className="text-[10px] text-zinc-400">No exceptions.</p>}
                            </div>
                          </div>
                        );
                      })}
                      {draft.policies.length === 0 && <p className="text-xs text-zinc-400 py-2 text-center">No policies yet.</p>}
                    </div>

                    {/* Policy editor */}
                    {editingPolicy && (
                      <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950 space-y-3">
                        <h5 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                          {draft.policies.find(p => p.id === editingPolicy.id) ? "Edit Policy" : "Add Policy"}
                        </h5>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 mb-1">Name</label>
                          <input
                            value={editingPolicy.name}
                            onChange={(e) => setEditingPolicy({ ...editingPolicy, name: e.target.value })}
                            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            placeholder="e.g. 30-Day Money Back Guarantee"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 mb-1">Description (AI reads this to explain to customer)</label>
                          <textarea
                            value={editingPolicy.description || ""}
                            onChange={(e) => setEditingPolicy({ ...editingPolicy, description: e.target.value || null })}
                            rows={2}
                            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 mb-1">Conditions (JSON)</label>
                          <ConditionEditor value={editingPolicy.conditions} onChange={(c) => setEditingPolicy({ ...editingPolicy, conditions: c })} />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 mb-1">AI talking points</label>
                          <textarea
                            value={editingPolicy.ai_talking_points || ""}
                            onChange={(e) => setEditingPolicy({ ...editingPolicy, ai_talking_points: e.target.value || null })}
                            rows={2}
                            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            placeholder="How to explain the policy without sounding robotic"
                          />
                        </div>
                        <div className="flex gap-2">
                          <button onClick={savePolicy} disabled={!editingPolicy.name} className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50">Save Policy</button>
                          <button onClick={() => setEditingPolicy(null)} className="text-xs text-zinc-500 hover:text-zinc-700">Cancel</button>
                        </div>
                      </div>
                    )}

                    {/* Exception editor */}
                    {editingException && (
                      <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950 space-y-3">
                        <h5 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                          {draft.exceptions.find(e => e.id === editingException.id) ? "Edit Exception" : "Add Exception"}
                        </h5>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <label className="block text-xs font-medium text-zinc-500 mb-1">Name</label>
                            <input
                              value={editingException.name}
                              onChange={(e) => setEditingException({ ...editingException, name: e.target.value })}
                              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                              placeholder="e.g. Return for Store Credit"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-zinc-500 mb-1">Resolution type</label>
                            <select
                              value={editingException.resolution_type}
                              onChange={(e) => setEditingException({ ...editingException, resolution_type: e.target.value })}
                              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            >
                              {RESOLUTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                            </select>
                          </div>
                        </div>
                        <div>
                          <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400 mb-2">
                            <input
                              type="checkbox"
                              checked={editingException.auto_grant}
                              onChange={(e) => setEditingException({ ...editingException, auto_grant: e.target.checked, auto_grant_trigger: e.target.checked ? "duplicate_charge" : null })}
                              className="rounded border-zinc-300"
                            />
                            Auto-grant (system error — no eligibility check)
                          </label>
                          {editingException.auto_grant && (
                            <select
                              value={editingException.auto_grant_trigger || ""}
                              onChange={(e) => setEditingException({ ...editingException, auto_grant_trigger: e.target.value || null })}
                              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            >
                              {AUTO_GRANT_TRIGGERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                            </select>
                          )}
                        </div>
                        {!editingException.auto_grant && (
                          <>
                            <div>
                              <label className="block text-xs font-medium text-zinc-500 mb-1">Tier</label>
                              <input
                                type="number"
                                min={1}
                                value={editingException.tier}
                                onChange={(e) => setEditingException({ ...editingException, tier: parseInt(e.target.value) || 1 })}
                                className="w-24 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-zinc-500 mb-1">Conditions (JSON)</label>
                              <ConditionEditor value={editingException.conditions} onChange={(c) => setEditingException({ ...editingException, conditions: c })} />
                            </div>
                          </>
                        )}
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 mb-1">AI instructions</label>
                          <textarea
                            value={editingException.instructions || ""}
                            onChange={(e) => setEditingException({ ...editingException, instructions: e.target.value || null })}
                            rows={2}
                            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            placeholder="How AI should present this offer"
                          />
                        </div>
                        <div className="flex gap-2">
                          <button onClick={saveException} disabled={!editingException.name} className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50">Save Exception</button>
                          <button onClick={() => setEditingException(null)} className="text-xs text-zinc-500 hover:text-zinc-700">Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Save / Cancel */}
                  <div className="flex items-center gap-3 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                    <button onClick={saveDraft} disabled={saving || !draft.name} className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
                      {saving ? "Saving..." : "Save Playbook"}
                    </button>
                    <button onClick={cancelEdit} className="text-sm text-zinc-500 hover:text-zinc-700">Cancel</button>
                  </div>
                </div>
              )}

              {/* ── READ-ONLY EXPANDED ── */}
              {!isThisEditing && expanded === pb.id && (
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
          );
        })}

        {playbooks.length === 0 && !isEditing && (
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

      {/* ── SIMULATION MODAL ── */}
      {simModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-12">
          <div className="w-full max-w-3xl rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-700">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Simulate Playbook</h2>
                <p className="text-xs text-zinc-500">Run a dry-run against real customer data to test your playbook configuration.</p>
              </div>
              <button onClick={() => { setSimModal(null); setSimResult(null); }} className="text-zinc-400 hover:text-zinc-600 text-xl leading-none">&times;</button>
            </div>

            {/* Input form */}
            <div className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-700 space-y-4">
              {/* Customer search */}
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1">Customer</label>
                {simCustomerId ? (
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-indigo-50 px-3 py-1.5 text-sm text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                      {simCustomers.find(c => c.id === simCustomerId)?.email || simCustomerId}
                    </span>
                    <button onClick={() => { setSimCustomerId(""); setSimSearch(""); }} className="text-xs text-red-400 hover:text-red-600">Change</button>
                  </div>
                ) : (
                  <div className="relative">
                    <input
                      value={simSearch}
                      onChange={(e) => handleSimSearchChange(e.target.value)}
                      placeholder="Search by name or email..."
                      className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    />
                    {simCustomers.length > 0 && (
                      <div className="absolute top-full left-0 right-0 z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                        {simCustomers.map(c => (
                          <button
                            key={c.id}
                            onClick={() => { setSimCustomerId(c.id); setSimSearch(""); }}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-700"
                          >
                            <span className="font-medium text-zinc-900 dark:text-zinc-100">
                              {c.first_name || ""} {c.last_name || ""}
                            </span>
                            <span className="ml-2 text-zinc-500">{c.email}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Message */}
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1">Customer message</label>
                <textarea
                  value={simMessage}
                  onChange={(e) => setSimMessage(e.target.value)}
                  rows={2}
                  placeholder="e.g. You charged me without permission, I never signed up for this"
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                />
              </div>

              {/* Sentiment */}
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1">Customer sentiment</label>
                <div className="flex gap-2">
                  {SENTIMENTS.map(s => (
                    <button
                      key={s.value}
                      onClick={() => setSimSentiment(s.value)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${simSentiment === s.value ? s.color + " ring-2 ring-offset-1 ring-current" : "text-zinc-400 bg-zinc-100 dark:bg-zinc-800"}`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Run button */}
              <button
                onClick={runSimulation}
                disabled={simRunning || !simCustomerId || !simMessage}
                className="rounded-md bg-violet-500 px-4 py-2 text-sm font-medium text-white hover:bg-violet-600 disabled:opacity-50"
              >
                {simRunning ? "Simulating..." : "Run Simulation"}
              </button>
            </div>

            {/* Results */}
            {simRunning && (
              <div className="px-6 py-8 text-center">
                <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
                <p className="mt-2 text-sm text-zinc-500">Running simulation with Sonnet... this takes 15-30 seconds.</p>
              </div>
            )}

            {simResult && (
              <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
                <div className="mb-4 rounded-md bg-zinc-50 p-3 dark:bg-zinc-800/50">
                  <div className="text-xs text-zinc-500">
                    <span className="font-medium">Playbook:</span> {simResult.playbook_name} |
                    <span className="ml-2 font-medium">Customer:</span> {simResult.customer_name} ({simResult.customer_email}) |
                    <span className="ml-2 font-medium">Sentiment:</span> {simResult.sentiment}
                  </div>
                  <div className="mt-1 rounded bg-zinc-200 px-2 py-1 text-xs dark:bg-zinc-700 dark:text-zinc-300">
                    &ldquo;{simResult.initial_message}&rdquo;
                  </div>
                </div>

                <div className="space-y-4">
                  {simResult.steps.map((s, i) => (
                    <div key={i} className={`rounded-lg border p-4 ${s.warnings.length > 0 ? "border-amber-200 dark:border-amber-800" : "border-zinc-200 dark:border-zinc-700"}`}>
                      {/* Step header */}
                      <div className="flex items-center gap-2 mb-3">
                        <StepIcon type={s.step_type} />
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                          Step {s.step_order + 1}: {s.step_name}
                        </span>
                        <span className="rounded bg-zinc-200 px-1 py-0.5 text-[10px] font-mono text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">{s.step_type}</span>
                        {s.skipped && <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-500">SKIPPED</span>}
                      </div>

                      {/* Data found */}
                      <div className="mb-2">
                        <div className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider mb-0.5">Data Found</div>
                        <pre className="whitespace-pre-wrap rounded bg-zinc-50 px-2 py-1.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{s.data_found || "—"}</pre>
                      </div>

                      {/* Condition result */}
                      <div className="mb-2">
                        <div className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider mb-0.5">Condition Result</div>
                        <div className="text-xs text-zinc-700 dark:text-zinc-300">{s.condition_result || "—"}</div>
                      </div>

                      {/* Warnings */}
                      {s.warnings.length > 0 && (
                        <div className="mb-2 space-y-1">
                          {s.warnings.map((w, wi) => (
                            <div key={wi} className="flex items-start gap-1.5 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                              <span className="shrink-0 mt-0.5">&#9888;</span>
                              <span>{w}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* AI response */}
                      {s.ai_response && !s.skipped && (
                        <div className="mb-2">
                          <div className="text-[10px] font-medium text-indigo-400 uppercase tracking-wider mb-0.5">AI Response</div>
                          <div className="rounded-md border-l-2 border-indigo-300 bg-indigo-50 px-3 py-2 text-sm text-zinc-800 dark:border-indigo-700 dark:bg-indigo-950 dark:text-zinc-200">
                            {s.ai_response}
                          </div>
                        </div>
                      )}

                      {/* Mock customer reply */}
                      {s.mock_customer_reply && (
                        <div>
                          <div className="text-[10px] font-medium text-violet-400 uppercase tracking-wider mb-0.5">Mock Customer Reply ({simResult.sentiment})</div>
                          <div className="rounded-md border-l-2 border-violet-300 bg-violet-50 px-3 py-2 text-sm text-zinc-800 dark:border-violet-700 dark:bg-violet-950 dark:text-zinc-200">
                            &ldquo;{s.mock_customer_reply}&rdquo;
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Summary + Actions */}
                <div className="mt-4 rounded-md bg-zinc-50 p-3 dark:bg-zinc-800/50">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-xs font-medium text-zinc-500 mb-1">Summary</div>
                      <div className="text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5">
                        <p>{simResult.steps.length} steps total, {simResult.steps.filter(s => s.skipped).length} skipped</p>
                        <p>{simResult.steps.reduce((n, s) => n + s.warnings.length, 0)} warnings found</p>
                        {simResult.ref && (
                          <p className="font-mono text-zinc-400">Ref: {simResult.ref.slice(0, 8)}</p>
                        )}
                        {simResult.steps.some(s => s.warnings.length > 0) && (
                          <p className="text-amber-600 dark:text-amber-400 font-medium mt-1">
                            Review warnings above to ensure your playbook handles this scenario correctly.
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          const text = formatSimForLLM(simResult);
                          navigator.clipboard.writeText(text);
                          alert("Copied to clipboard!");
                        }}
                        className="rounded-md bg-violet-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-600"
                      >
                        Copy for LLM
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
