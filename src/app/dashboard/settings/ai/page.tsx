"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

type Tab = "personalities" | "channels" | "ai-workflows";

interface KBArticle {
  id: string;
  title: string;
  content: string;
  category: string;
  active: boolean;
  product_name: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

interface Macro {
  id: string;
  name: string;
  body_text: string;
  body_html: string | null;
  category: string | null;
  tags: string[];
  active: boolean;
  usage_count: number;
  gorgias_id: number | null;
  created_at: string;
}

interface Personality {
  id: string;
  name: string;
  description: string | null;
  tone: string;
  style_instructions: string;
  sign_off: string | null;
  greeting: string | null;
  emoji_usage: string;
}

interface ChannelConfig {
  id: string | null;
  channel: string;
  personality_id: string | null;
  enabled: boolean;
  sandbox: boolean;
  instructions: string;
  max_response_length: number | null;
  confidence_threshold: number;
  auto_resolve: boolean;
  ai_personalities: { name: string; tone: string } | null;
}

interface AIWorkflow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_intent: string;
  match_patterns: string[];
  match_categories: string[];
  response_source: string;
  preferred_macro_id: string | null;
  post_response_workflow_id: string | null;
  macros: { id: string; name: string } | null;
  workflows: { id: string; name: string } | null;
}

const CATEGORIES = ["product", "policy", "shipping", "billing", "general"];
const CATEGORY_COLORS: Record<string, string> = {
  product: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  policy: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  shipping: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  billing: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  subscription: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  general: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  chat: "Live Chat",
  sms: "SMS",
  meta_dm: "Social DMs",
  help_center: "Help Center",
  social_comments: "Social Comments",
};

export default function AISettingsPage() {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<Tab>("personalities");

  // Knowledge Base state
  const [articles, setArticles] = useState<KBArticle[]>([]);
  const [editingArticle, setEditingArticle] = useState<Partial<KBArticle> | null>(null);

  // Macros state
  const [macros, setMacros] = useState<Macro[]>([]);
  const [editingMacro, setEditingMacro] = useState<Partial<Macro> | null>(null);
  const [macroSearchQuery, setMacroSearchQuery] = useState("");

  // Personalities state
  const [personalities, setPersonalities] = useState<Personality[]>([]);
  const [editingPersonality, setEditingPersonality] = useState<Partial<Personality> | null>(null);

  // Channel config state
  const [channels, setChannels] = useState<ChannelConfig[]>([]);

  // AI Workflows state
  const [aiWorkflows, setAIWorkflows] = useState<AIWorkflow[]>([]);
  const [editingWorkflow, setEditingWorkflow] = useState<Partial<AIWorkflow> | null>(null);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadTab(tab);
  }, [tab, workspace.id]);

  async function loadTab(t: Tab) {
    const base = `/api/workspaces/${workspace.id}`;
    if (t === "personalities") {
      const res = await fetch(`${base}/ai-personalities`);
      setPersonalities(await res.json());
    } else if (t === "channels") {
      const res = await fetch(`${base}/ai-config`);
      setChannels(await res.json());
      const pRes = await fetch(`${base}/ai-personalities`);
      setPersonalities(await pRes.json());
    } else if (t === "ai-workflows") {
      const res = await fetch(`${base}/ai-workflows`);
      setAIWorkflows(await res.json());
    }
  }

  // ── Personalities CRUD ──
  async function savePersonality() {
    if (!editingPersonality?.name) return;
    setSaving(true);
    const base = `/api/workspaces/${workspace.id}/ai-personalities`;

    if (editingPersonality.id) {
      await fetch(`${base}/${editingPersonality.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingPersonality),
      });
    } else {
      await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingPersonality),
      });
    }
    setEditingPersonality(null);
    setSaving(false);
    loadTab("personalities");
  }

  async function deletePersonality(id: string) {
    if (!confirm("Delete this personality?")) return;
    await fetch(`/api/workspaces/${workspace.id}/ai-personalities/${id}`, { method: "DELETE" });
    loadTab("personalities");
  }

  // ── Channel config ──
  async function saveChannel(config: ChannelConfig) {
    await fetch(`/api/workspaces/${workspace.id}/ai-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    loadTab("channels");
  }

  // ── AI Workflows ──
  async function saveAIWorkflow() {
    if (!editingWorkflow?.name || !editingWorkflow?.trigger_intent) return;
    setSaving(true);
    const base = `/api/workspaces/${workspace.id}/ai-workflows`;

    if (editingWorkflow.id) {
      await fetch(`${base}/${editingWorkflow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingWorkflow),
      });
    } else {
      await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingWorkflow),
      });
    }
    setEditingWorkflow(null);
    setSaving(false);
    loadTab("ai-workflows");
  }

  async function deleteAIWorkflow(id: string) {
    if (!confirm("Delete this AI workflow?")) return;
    await fetch(`/api/workspaces/${workspace.id}/ai-workflows/${id}`, { method: "DELETE" });
    loadTab("ai-workflows");
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: "personalities", label: "Personalities" },
    { key: "channels", label: "Channels" },
    { key: "ai-workflows", label: "AI Workflows" },
  ];

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">AI Agent</h1>
      <p className="mt-2 text-sm text-zinc-500">Configure your AI-powered customer support agent.</p>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 rounded-lg border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-800 dark:bg-zinc-900">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {/* ── Personalities Tab ── */}
        {tab === "personalities" && (
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">AI Personalities ({personalities.length})</h2>
              <button
                onClick={() => setEditingPersonality({ name: "", tone: "friendly", style_instructions: "", emoji_usage: "minimal" })}
                className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
              >
                Add Personality
              </button>
            </div>

            {editingPersonality && (
              <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-950">
                <h3 className="text-sm font-medium text-violet-900 dark:text-violet-100">
                  {editingPersonality.id ? "Edit Personality" : "New Personality"}
                </h3>
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={editingPersonality.name || ""}
                      onChange={(e) => setEditingPersonality({ ...editingPersonality, name: e.target.value })}
                      placeholder="Name (e.g. 'Friendly Emma')"
                      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    />
                    <select
                      value={editingPersonality.tone || "friendly"}
                      onChange={(e) => setEditingPersonality({ ...editingPersonality, tone: e.target.value })}
                      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      <option value="friendly">Friendly</option>
                      <option value="professional">Professional</option>
                      <option value="casual">Casual</option>
                      <option value="empathetic">Empathetic</option>
                      <option value="enthusiastic">Enthusiastic</option>
                    </select>
                  </div>
                  <input
                    type="text"
                    value={editingPersonality.description || ""}
                    onChange={(e) => setEditingPersonality({ ...editingPersonality, description: e.target.value })}
                    placeholder="Description (optional)"
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                  <textarea
                    value={editingPersonality.style_instructions || ""}
                    onChange={(e) => setEditingPersonality({ ...editingPersonality, style_instructions: e.target.value })}
                    placeholder="Style instructions (e.g. 'Use short sentences. Be warm and approachable.')"
                    rows={3}
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                  <div className="grid grid-cols-3 gap-3">
                    <input
                      type="text"
                      value={editingPersonality.greeting || ""}
                      onChange={(e) => setEditingPersonality({ ...editingPersonality, greeting: e.target.value })}
                      placeholder="Greeting (e.g. 'Hi {{name}}!')"
                      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    />
                    <input
                      type="text"
                      value={editingPersonality.sign_off || ""}
                      onChange={(e) => setEditingPersonality({ ...editingPersonality, sign_off: e.target.value })}
                      placeholder="Sign-off (e.g. 'Best, The SF Team')"
                      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    />
                    <select
                      value={editingPersonality.emoji_usage || "minimal"}
                      onChange={(e) => setEditingPersonality({ ...editingPersonality, emoji_usage: e.target.value })}
                      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      <option value="none">No Emojis</option>
                      <option value="minimal">Minimal</option>
                      <option value="moderate">Moderate</option>
                      <option value="heavy">Heavy</option>
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={savePersonality} disabled={saving} className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button onClick={() => setEditingPersonality(null)} className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800">
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {personalities.length === 0 && (
                <p className="p-4 text-sm text-zinc-400">No personalities yet. Create your first AI personality.</p>
              )}
              {personalities.map((p) => (
                <div key={p.id} className="flex items-center justify-between p-4">
                  <div>
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.name}</span>
                    <span className="ml-2 text-sm capitalize text-zinc-500">{p.tone}</span>
                    {p.sign_off && <span className="ml-2 text-sm text-zinc-400">— {p.sign_off}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setEditingPersonality(p)} className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">Edit</button>
                    <button onClick={() => deletePersonality(p.id)} className="text-sm text-red-500 hover:underline">Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Channels Tab ── */}
        {tab === "channels" && (
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Channel Configuration</h2>
            <p className="mt-1 text-sm text-zinc-500">Configure AI behavior per channel. Each channel has its own sandbox mode.</p>

            <div className="mt-4 space-y-4">
              {channels.map((ch) => (
                <div key={ch.channel} className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{CHANNEL_LABELS[ch.channel] || ch.channel}</h3>
                    <div className="flex items-center gap-3">
                      {ch.sandbox && ch.enabled && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-sm font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Sandbox</span>
                      )}
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={ch.enabled}
                          onChange={(e) => saveChannel({ ...ch, enabled: e.target.checked })}
                          className="rounded"
                        />
                        Enabled
                      </label>
                    </div>
                  </div>

                  {ch.enabled && (
                    <div className="mt-4 space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-medium text-zinc-500">Personality</label>
                          <select
                            value={ch.personality_id || ""}
                            onChange={(e) => saveChannel({ ...ch, personality_id: e.target.value || null })}
                            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                          >
                            <option value="">Default</option>
                            {personalities.map((p) => (
                              <option key={p.id} value={p.id}>{p.name} ({p.tone})</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-zinc-500">Confidence Threshold</label>
                          <input
                            type="number"
                            value={ch.confidence_threshold}
                            onChange={(e) => saveChannel({ ...ch, confidence_threshold: parseFloat(e.target.value) })}
                            min={0.5}
                            max={1}
                            step={0.05}
                            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-zinc-500">Channel Instructions</label>
                        <textarea
                          value={ch.instructions}
                          onChange={(e) => setChannels((prev) => prev.map((c) => (c.channel === ch.channel ? { ...c, instructions: e.target.value } : c)))}
                          onBlur={() => saveChannel(ch)}
                          placeholder={ch.channel === "chat" ? "Keep messages short and concise (2-3 sentences max)." : ch.channel === "email" ? "Can use longer, more detailed responses." : "Channel-specific instructions..."}
                          rows={3}
                          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="block text-sm font-medium text-zinc-500">Max Length</label>
                          <input
                            type="number"
                            value={ch.max_response_length || ""}
                            onChange={(e) => saveChannel({ ...ch, max_response_length: e.target.value ? parseInt(e.target.value) : null })}
                            placeholder="No limit"
                            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                          />
                        </div>
                        <label className="flex items-center gap-2 pt-6 text-sm text-zinc-700 dark:text-zinc-300">
                          <input
                            type="checkbox"
                            checked={ch.sandbox}
                            onChange={(e) => saveChannel({ ...ch, sandbox: e.target.checked })}
                            className="rounded"
                          />
                          Sandbox Mode
                        </label>
                        <label className="flex items-center gap-2 pt-6 text-sm text-zinc-700 dark:text-zinc-300">
                          <input
                            type="checkbox"
                            checked={ch.auto_resolve}
                            onChange={(e) => saveChannel({ ...ch, auto_resolve: e.target.checked })}
                            className="rounded"
                          />
                          Auto-resolve
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── AI Workflows Tab ── */}
        {tab === "ai-workflows" && (
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">AI Workflows ({aiWorkflows.length})</h2>
              <button
                onClick={() => setEditingWorkflow({ name: "", trigger_intent: "", match_patterns: [], match_categories: [], response_source: "either", enabled: false })}
                className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
              >
                Add AI Workflow
              </button>
            </div>

            <p className="mt-2 text-sm text-zinc-500">
              AI workflows scope what the AI agent can do. When the AI recognizes an intent, it follows the workflow to find the right macro or KB article, personalize it, and optionally trigger a smart tag workflow for actions.
            </p>

            {editingWorkflow && (
              <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-950">
                <h3 className="text-sm font-medium text-violet-900 dark:text-violet-100">
                  {editingWorkflow.id ? "Edit AI Workflow" : "New AI Workflow"}
                </h3>
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={editingWorkflow.name || ""}
                      onChange={(e) => setEditingWorkflow({ ...editingWorkflow, name: e.target.value })}
                      placeholder="Workflow name"
                      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    />
                    <input
                      type="text"
                      value={editingWorkflow.trigger_intent || ""}
                      onChange={(e) => setEditingWorkflow({ ...editingWorkflow, trigger_intent: e.target.value })}
                      placeholder="Trigger intent (e.g. 'order_tracking')"
                      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    />
                  </div>
                  <input
                    type="text"
                    value={editingWorkflow.description || ""}
                    onChange={(e) => setEditingWorkflow({ ...editingWorkflow, description: e.target.value })}
                    placeholder="Description"
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-zinc-500">Match Patterns (comma-separated)</label>
                      <input
                        type="text"
                        value={(editingWorkflow.match_patterns || []).join(", ")}
                        onChange={(e) => setEditingWorkflow({ ...editingWorkflow, match_patterns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                        placeholder="where is my order, track my package"
                        className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-zinc-500">Response Source</label>
                      <select
                        value={editingWorkflow.response_source || "either"}
                        onChange={(e) => setEditingWorkflow({ ...editingWorkflow, response_source: e.target.value })}
                        className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                      >
                        <option value="either">Macro or KB Article</option>
                        <option value="macro">Macro Only</option>
                        <option value="kb">KB Article Only</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={saveAIWorkflow} disabled={saving} className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button onClick={() => setEditingWorkflow(null)} className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800">
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {aiWorkflows.length === 0 && (
                <p className="p-4 text-sm text-zinc-400">No AI workflows yet. Create workflows to scope how the AI agent handles different intents.</p>
              )}
              {aiWorkflows.map((w) => (
                <div key={w.id} className="flex items-center justify-between p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{w.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${w.enabled ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"}`}>
                        {w.enabled ? "Active" : "Disabled"}
                      </span>
                      <span className="rounded bg-violet-100 px-2 py-0.5 text-sm text-violet-600 dark:bg-violet-900/30 dark:text-violet-400">{w.trigger_intent}</span>
                    </div>
                    {w.description && <p className="mt-1 text-sm text-zinc-500">{w.description}</p>}
                    <div className="mt-1 flex gap-2 text-sm text-zinc-400">
                      <span>Source: {w.response_source}</span>
                      {w.macros && <span>| Macro: {w.macros.name}</span>}
                      {w.workflows && <span>| Post-workflow: {w.workflows.name}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setEditingWorkflow(w)} className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">Edit</button>
                    <button onClick={() => deleteAIWorkflow(w.id)} className="text-sm text-red-500 hover:underline">Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
