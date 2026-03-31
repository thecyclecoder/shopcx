"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface JourneyOption {
  value: string;
  label: string;
  emoji?: string;
  nextStepKey?: string;
  rebuttalStepKey?: string;
  outcome?: string;
}

interface JourneyStep {
  key: string;
  type: string;
  question: string;
  subtitle?: string;
  placeholder?: string;
  options?: JourneyOption[];
  isTerminal?: boolean;
}

interface JourneyOutcome {
  key: string;
  label: string;
  action: { type: string; params: Record<string, unknown> };
}

interface JourneyConfig {
  steps?: JourneyStep[];
  outcomes?: JourneyOutcome[];
  branding?: { primaryColor?: string; accentColor?: string };
  messages?: Record<string, string>;
}

interface JourneyDef {
  id: string;
  slug: string;
  name: string;
  journey_type: string;
  is_active: boolean;
  channels: string[];
  match_patterns: string[];
  trigger_intent: string | null;
  description: string | null;
  priority: number;
  step_ticket_status: string;
  config: JourneyConfig;
  stats: { sent: number; completed: number; saved: number; cancelled: number };
  created_at: string;
}

const ALL_CHANNELS = ["email", "chat", "help_center", "meta_dm", "sms"] as const;
const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  chat: "Live Chat",
  help_center: "Help Center",
  meta_dm: "Meta DM",
  sms: "SMS",
};

const TYPE_COLORS: Record<string, string> = {
  cancellation: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  win_back: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  pause: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  product_swap: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  account_linking: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  discount_signup: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
  return_request: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  address_change: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  custom: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

export default function JourneysSettingsPage() {
  const workspace = useWorkspace();
  const [journeys, setJourneys] = useState<JourneyDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [selected, setSelected] = useState<JourneyDef | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/journeys`);
    const data = await res.json();
    if (Array.isArray(data)) setJourneys(data);
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { load(); }, [load]);

  async function seedCancellation() {
    setSeeding(true);
    const { CANCELLATION_JOURNEY_CONFIG } = await import("@/lib/journey-seed");
    await fetch(`/api/workspaces/${workspace.id}/journeys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "cancellation-flow",
        name: "Cancellation Flow",
        journey_type: "cancellation",
        config: CANCELLATION_JOURNEY_CONFIG,
        channels: ["email", "chat", "help_center", "meta_dm", "sms"],
        trigger_intent: "cancellation",
        description: "Guided cancellation flow with retention offers",
        match_patterns: ["cancel", "cancellation", "unsubscribe", "stop subscription"],
      }),
    });
    setSeeding(false);
    load();
  }

  async function toggleActive(id: string, is_active: boolean) {
    await fetch(`/api/workspaces/${workspace.id}/journeys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active }),
    });
    setJourneys((prev) => prev.map((j) => (j.id === id ? { ...j, is_active } : j)));
    if (selected?.id === id) setSelected((s) => s ? { ...s, is_active } : s);
  }

  async function deleteJourney(id: string) {
    if (!confirm("Delete this journey? Active sessions will stop working.")) return;
    await fetch(`/api/workspaces/${workspace.id}/journeys/${id}`, { method: "DELETE" });
    if (selected?.id === id) setSelected(null);
    load();
  }

  const hasCancellation = journeys.some((j) => j.journey_type === "cancellation");

  if (selected) {
    return (
      <JourneyDetail
        journey={selected}
        workspaceId={workspace.id}
        onBack={() => { setSelected(null); load(); }}
        onToggle={(active) => toggleActive(selected.id, active)}
        onDelete={() => deleteJourney(selected.id)}
      />
    );
  }

  return (
    <div className="p-4 sm:p-8 overflow-x-hidden">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Journeys</h1>
      <p className="mt-2 text-sm text-zinc-500">
        Customer-facing retention flows. Channels determine execution: live chat uses inline forms, all others send a CTA email linking to a branded mini-site.
      </p>

      <div className="mt-6 flex gap-2">
        {!hasCancellation && (
          <button
            onClick={seedCancellation}
            disabled={seeding}
            className="rounded-md bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
          >
            {seeding ? "Creating..." : "Create Cancellation Flow"}
          </button>
        )}
      </div>

      {loading ? (
        <p className="mt-8 text-sm text-zinc-400">Loading...</p>
      ) : journeys.length === 0 ? (
        <div className="mt-8 rounded-lg border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm text-zinc-400">No journeys yet. Create a cancellation flow to get started.</p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {journeys.map((j) => {
            const saveRate = j.stats.completed > 0 ? Math.round((j.stats.saved / j.stats.completed) * 100) : 0;
            return (
              <div
                key={j.id}
                onClick={() => setSelected(j)}
                className="cursor-pointer rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{j.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_COLORS[j.journey_type] || TYPE_COLORS.custom}`}>
                      {j.journey_type.replace(/_/g, " ")}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${j.is_active ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"}`}>
                      {j.is_active ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <svg className="h-4 w-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>

                {j.description && (
                  <p className="mt-1.5 text-xs text-zinc-400">{j.description}</p>
                )}

                {/* Channel pills */}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {(j.channels || []).map((ch) => (
                    <span key={ch} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {CHANNEL_LABELS[ch] || ch}
                    </span>
                  ))}
                </div>

                {/* Stats */}
                <div className="mt-4 grid grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-zinc-400">Sent</p>
                    <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{j.stats.sent}</p>
                  </div>
                  <div>
                    <p className="text-xs text-zinc-400">Completed</p>
                    <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{j.stats.completed}</p>
                  </div>
                  <div>
                    <p className="text-xs text-zinc-400">Saved</p>
                    <p className="text-lg font-semibold text-emerald-600">{j.stats.saved}</p>
                  </div>
                  <div>
                    <p className="text-xs text-zinc-400">Save Rate</p>
                    <p className={`text-lg font-semibold ${saveRate >= 30 ? "text-emerald-600" : saveRate >= 15 ? "text-amber-600" : "text-red-600"}`}>
                      {saveRate}%
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Journey Detail View ──

function JourneyDetail({
  journey: initial,
  workspaceId,
  onBack,
  onToggle,
  onDelete,
}: {
  journey: JourneyDef;
  workspaceId: string;
  onBack: () => void;
  onToggle: (active: boolean) => void;
  onDelete: () => void;
}) {
  const [j, setJ] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Editable fields
  const [name, setName] = useState(j.name);
  const [description, setDescription] = useState(j.description || "");
  const [channels, setChannels] = useState<string[]>(j.channels || []);
  const [matchPatterns, setMatchPatterns] = useState((j.match_patterns || []).join(", "));
  const [priority, setPriority] = useState(j.priority);
  const [stepTicketStatus, setStepTicketStatus] = useState(j.step_ticket_status || "open");

  // Step editing
  const [editingStep, setEditingStep] = useState<string | null>(null);
  const [editQuestion, setEditQuestion] = useState("");
  const [editSubtitle, setEditSubtitle] = useState("");

  function markDirty() { setDirty(true); }

  function toggleChannel(ch: string) {
    setChannels((prev) => prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]);
    markDirty();
  }

  async function save() {
    setSaving(true);
    const patterns = matchPatterns.split(",").map((s) => s.trim()).filter(Boolean);
    const body: Record<string, unknown> = { name, description, channels, match_patterns: patterns, priority, step_ticket_status: stepTicketStatus, config: j.config };

    const res = await fetch(`/api/workspaces/${workspaceId}/journeys/${j.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const updated = await res.json();
      setJ(updated);
      setDirty(false);
    }
    setSaving(false);
  }

  function startEditStep(step: JourneyStep) {
    setEditingStep(step.key);
    setEditQuestion(step.question);
    setEditSubtitle(step.subtitle || "");
  }

  function saveStepEdit(stepKey: string) {
    const steps = [...(j.config.steps || [])];
    const idx = steps.findIndex((s) => s.key === stepKey);
    if (idx >= 0) {
      steps[idx] = { ...steps[idx], question: editQuestion, subtitle: editSubtitle || undefined };
      setJ({ ...j, config: { ...j.config, steps } });
      markDirty();
    }
    setEditingStep(null);
  }

  function updateOptionLabel(stepKey: string, optionValue: string, newLabel: string) {
    const steps = [...(j.config.steps || [])];
    const idx = steps.findIndex((s) => s.key === stepKey);
    if (idx >= 0 && steps[idx].options) {
      steps[idx] = {
        ...steps[idx],
        options: steps[idx].options!.map((o) =>
          o.value === optionValue ? { ...o, label: newLabel } : o
        ),
      };
      setJ({ ...j, config: { ...j.config, steps } });
      markDirty();
    }
  }

  const steps = j.config.steps || [];
  const outcomes = j.config.outcomes || [];
  const nonTerminalSteps = steps.filter((s) => !s.isTerminal);

  return (
    <div className="p-4 sm:p-8 overflow-x-hidden">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1">
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); markDirty(); }}
            className="w-full bg-transparent text-2xl font-bold text-zinc-900 outline-none dark:text-zinc-100"
          />
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${TYPE_COLORS[j.journey_type] || TYPE_COLORS.custom}`}>
          {j.journey_type.replace(/_/g, " ")}
        </span>
      </div>

      {/* Actions bar */}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => onToggle(!j.is_active)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            j.is_active
              ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400"
              : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400"
          }`}
        >
          {j.is_active ? "Active" : "Inactive"}
        </button>
        {dirty && (
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        )}
        <div className="flex-1" />
        <button onClick={onDelete} className="text-sm text-red-500 hover:underline">
          Delete Journey
        </button>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Left: Flow visualization */}
        <div className="space-y-6">
          {/* Description */}
          <div>
            <label className="text-xs font-medium text-zinc-500">Description</label>
            <textarea
              value={description}
              onChange={(e) => { setDescription(e.target.value); markDirty(); }}
              rows={2}
              className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              placeholder="Describe what this journey does..."
            />
          </div>

          {/* Step Flow */}
          {nonTerminalSteps.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Flow</h3>
              <div className="mt-3 space-y-3">
                {nonTerminalSteps.map((step, idx) => (
                  <StepCard
                    key={step.key}
                    step={step}
                    index={idx}
                    editing={editingStep === step.key}
                    editQuestion={editQuestion}
                    editSubtitle={editSubtitle}
                    onEditQuestion={setEditQuestion}
                    onEditSubtitle={setEditSubtitle}
                    onStartEdit={() => startEditStep(step)}
                    onSaveEdit={() => saveStepEdit(step.key)}
                    onCancelEdit={() => setEditingStep(null)}
                    onUpdateOptionLabel={(optVal, newLabel) => updateOptionLabel(step.key, optVal, newLabel)}
                    outcomes={outcomes}
                  />
                ))}
              </div>
            </div>
          )}

          {/* No steps (code-driven journey) */}
          {nonTerminalSteps.length === 0 && (
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-6 text-center dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-sm text-zinc-500">
                This is a code-driven journey. The flow is handled programmatically based on customer data and responses.
              </p>
              {j.journey_type === "account_linking" && (
                <p className="mt-2 text-xs text-zinc-400">
                  Detects unlinked profiles by name match, presents a checklist to confirm, then links selected accounts.
                </p>
              )}
              {j.journey_type === "discount_signup" && (
                <p className="mt-2 text-xs text-zinc-400">
                  Checks marketing status, collects email/SMS opt-in, assigns a coupon based on VIP tier, optionally applies to active subscription.
                </p>
              )}
            </div>
          )}

          {/* Outcomes */}
          {outcomes.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Outcomes</h3>
              <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                    <tr>
                      <th className="px-3 py-2 text-xs font-medium text-zinc-500">Outcome</th>
                      <th className="px-3 py-2 text-xs font-medium text-zinc-500">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {outcomes.map((o) => (
                      <tr key={o.key} className="bg-white dark:bg-zinc-900">
                        <td className="px-3 py-2 text-zinc-900 dark:text-zinc-100">{o.label}</td>
                        <td className="px-3 py-2">
                          <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                            {o.action.type}
                          </code>
                          {Object.keys(o.action.params || {}).length > 0 && (
                            <span className="ml-2 text-xs text-zinc-400">
                              {Object.entries(o.action.params).map(([k, v]) => `${k}: ${v}`).join(", ")}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Right: Configuration */}
        <div className="space-y-5">
          {/* Channels */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Channels</h4>
            <p className="mt-1 text-[11px] text-zinc-400">Chat = inline forms. Others = CTA email to mini-site.</p>
            <div className="mt-3 space-y-2">
              {ALL_CHANNELS.map((ch) => (
                <label key={ch} className="flex items-center gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={channels.includes(ch)}
                    onChange={() => toggleChannel(ch)}
                    className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-zinc-700 dark:text-zinc-300">{CHANNEL_LABELS[ch]}</span>
                  {ch === "chat" && <span className="text-[10px] text-zinc-400">(inline forms)</span>}
                  {ch !== "chat" && <span className="text-[10px] text-zinc-400">(mini-site)</span>}
                </label>
              ))}
            </div>
          </div>

          {/* Match Patterns */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Match Patterns</h4>
            <p className="mt-1 text-[11px] text-zinc-400">Keywords that trigger this journey (comma-separated)</p>
            <textarea
              value={matchPatterns}
              onChange={(e) => { setMatchPatterns(e.target.value); markDirty(); }}
              rows={3}
              className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              placeholder="cancel, unsubscribe, stop..."
            />
          </div>

          {/* Priority */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Priority</h4>
            <p className="mt-1 text-[11px] text-zinc-400">Higher = runs first when multiple journeys match</p>
            <input
              type="number"
              value={priority}
              onChange={(e) => { setPriority(Number(e.target.value)); markDirty(); }}
              className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>

          {/* Step Ticket Status */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Ticket Status on Step</h4>
            <p className="mt-1 text-[11px] text-zinc-400">Status to set when the journey sends a step to the customer</p>
            <select
              value={stepTicketStatus}
              onChange={(e) => { setStepTicketStatus(e.target.value); markDirty(); }}
              className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="closed">Closed</option>
            </select>
          </div>

          {/* Metadata */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Info</h4>
            <div className="mt-2 space-y-1.5 text-xs text-zinc-500">
              <div className="flex justify-between">
                <span>Slug</span>
                <code className="rounded bg-zinc-100 px-1 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{j.slug}</code>
              </div>
              {j.trigger_intent && (
                <div className="flex justify-between">
                  <span>Trigger Intent</span>
                  <code className="rounded bg-zinc-100 px-1 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{j.trigger_intent}</code>
                </div>
              )}
              <div className="flex justify-between">
                <span>Created</span>
                <span>{new Date(j.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Step Card ──

function StepCard({
  step,
  index,
  editing,
  editQuestion,
  editSubtitle,
  onEditQuestion,
  onEditSubtitle,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onUpdateOptionLabel,
  outcomes,
}: {
  step: JourneyStep;
  index: number;
  editing: boolean;
  editQuestion: string;
  editSubtitle: string;
  onEditQuestion: (v: string) => void;
  onEditSubtitle: (v: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onUpdateOptionLabel: (optVal: string, newLabel: string) => void;
  outcomes: JourneyOutcome[];
}) {
  const stepTypeIcon: Record<string, string> = {
    single_choice: "list",
    confirmation: "check-circle",
    radio: "circle-dot",
    checklist: "check-square",
    text_input: "type",
    confirm: "thumbs-up",
  };

  const typeLabel = step.type === "single_choice" ? "Choice"
    : step.type === "confirmation" ? "Confirm"
    : step.type.replace(/_/g, " ");

  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      {/* Step header */}
      <div className="flex items-center gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
          {index + 1}
        </span>
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          {typeLabel}
        </span>
        <code className="ml-auto rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-400 dark:bg-zinc-800">
          {step.key}
        </code>
        {!editing && (
          <button onClick={onStartEdit} className="text-xs text-indigo-500 hover:underline">Edit</button>
        )}
      </div>

      {/* Question */}
      <div className="px-4 py-3">
        {editing ? (
          <div className="space-y-2">
            <input
              value={editQuestion}
              onChange={(e) => onEditQuestion(e.target.value)}
              className="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-sm font-medium text-zinc-900 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <input
              value={editSubtitle}
              onChange={(e) => onEditSubtitle(e.target.value)}
              placeholder="Subtitle (optional)"
              className="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-600 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
            />
            <div className="flex gap-2">
              <button onClick={onSaveEdit} className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500">
                Apply
              </button>
              <button onClick={onCancelEdit} className="text-xs text-zinc-400 hover:text-zinc-600">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{step.question}</p>
            {step.subtitle && <p className="mt-0.5 text-xs text-zinc-400">{step.subtitle}</p>}
          </>
        )}
      </div>

      {/* Options */}
      {step.options && step.options.length > 0 && (
        <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <div className="space-y-1.5">
            {step.options.map((opt) => {
              const outcome = opt.outcome ? outcomes.find((o) => o.key === opt.outcome) : null;
              const targetStep = opt.rebuttalStepKey || opt.nextStepKey;
              return (
                <div key={opt.value} className="flex items-center gap-2 text-sm">
                  {opt.emoji && <span className="w-5 text-center text-sm">{opt.emoji}</span>}
                  <EditableLabel
                    value={opt.label}
                    onChange={(v) => onUpdateOptionLabel(opt.value, v)}
                  />
                  <span className="ml-auto flex items-center gap-1.5 text-[10px]">
                    {outcome && (
                      <span className={`rounded px-1 py-0.5 font-medium ${
                        opt.outcome?.startsWith("saved_")
                          ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                          : "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                      }`}>
                        {outcome.label}
                      </span>
                    )}
                    {targetStep && !outcome && (
                      <span className="text-zinc-400">
                        &rarr; {targetStep}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline editable label ──

function EditableLabel({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);

  if (editing) {
    return (
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => { onChange(val); setEditing(false); }}
        onKeyDown={(e) => { if (e.key === "Enter") { onChange(val); setEditing(false); } if (e.key === "Escape") { setVal(value); setEditing(false); } }}
        className="rounded border border-indigo-300 bg-white px-1.5 py-0.5 text-sm text-zinc-900 outline-none dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
    );
  }

  return (
    <span
      onClick={() => setEditing(true)}
      className="cursor-text rounded px-1 text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      title="Click to edit"
    >
      {value}
    </span>
  );
}
