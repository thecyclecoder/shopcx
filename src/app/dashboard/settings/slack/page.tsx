"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWorkspace } from "@/lib/workspace-context";

const EVENT_TYPES = [
  { key: "escalation", label: "Escalation", description: "When a ticket is escalated to a human agent" },
  { key: "new_ticket", label: "New Ticket", description: "When a new ticket is created" },
  { key: "chargeback", label: "Chargeback", description: "When a new chargeback is received" },
  { key: "fraud_case", label: "Fraud Case", description: "When a fraud case is detected" },
  { key: "dunning_failed", label: "Dunning Failed", description: "When dunning exhausts all payment methods" },
  { key: "csat_negative", label: "Negative CSAT", description: "When a customer gives a negative CSAT score" },
  { key: "cancel_completed", label: "Cancellation", description: "When a customer completes a subscription cancellation" },
];

interface Rule {
  event_type: string;
  channel_id: string | null;
  channel_name: string | null;
  dm_assigned_agent: boolean;
  dm_admins: boolean;
  enabled: boolean;
}

interface Channel {
  id: string;
  name: string;
  is_private?: boolean;
}

function ChannelPicker({ channels, value, onChange }: {
  channels: Channel[];
  value: string | null;
  onChange: (channelId: string | null, channelName: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selected = channels.find((c) => c.id === value);
  const filtered = channels.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      >
        {selected ? (
          <span>{selected.is_private ? "🔒 " : "#"}{selected.name}</span>
        ) : (
          <span className="text-gray-400">Select channel...</span>
        )}
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
          <div className="p-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search channels..."
              autoFocus
              className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-sm bg-white focus:border-indigo-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            <button
              type="button"
              onClick={() => { onChange(null, null); setOpen(false); setSearch(""); }}
              className="w-full px-3 py-1.5 text-left text-sm text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-700"
            >
              None
            </button>
            {filtered.map((ch) => (
              <button
                key={ch.id}
                type="button"
                onClick={() => { onChange(ch.id, ch.name); setOpen(false); setSearch(""); }}
                className={`w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-zinc-700 ${
                  ch.id === value ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400" : "text-gray-700 dark:text-zinc-300"
                }`}
              >
                {ch.is_private ? "🔒 " : "#"}{ch.name}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-2 text-sm text-gray-400">No channels found</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SlackSettingsPage() {
  const workspace = useWorkspace();
  const workspaceId = workspace.id;
  const [rules, setRules] = useState<Rule[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadData = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [rulesRes, channelsRes] = await Promise.all([
        fetch(`/api/workspaces/${workspaceId}/slack-rules`).then((r) => r.json()),
        fetch("/api/slack/channels").then((r) => r.json()),
      ]);

      const existingRules: Rule[] = rulesRes.rules || [];
      // Ensure all event types have a rule
      const merged = EVENT_TYPES.map((et) => {
        const existing = existingRules.find((r) => r.event_type === et.key);
        return existing || {
          event_type: et.key,
          channel_id: null,
          channel_name: null,
          dm_assigned_agent: false,
          dm_admins: false,
          enabled: false,
        };
      });
      setRules(merged);
      setChannels(channelsRes.channels || []);
    } catch (e) {
      console.error("Failed to load Slack settings:", e);
    }
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => { loadData(); }, [loadData]);

  function updateRule(eventType: string, updates: Partial<Rule>) {
    setRules((prev) =>
      prev.map((r) => (r.event_type === eventType ? { ...r, ...updates } : r))
    );
    setSaved(false);
  }

  async function handleSave() {
    if (!workspaceId) return;
    setSaving(true);
    try {
      await fetch(`/api/workspaces/${workspaceId}/slack-rules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      console.error("Failed to save Slack rules:", e);
    }
    setSaving(false);
  }

  if (loading) {
    return (
      <div className="p-4 sm:p-6 max-w-4xl overflow-x-hidden">
        <h1 className="text-2xl font-bold mb-6">Slack Notifications</h1>
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-gray-100 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl overflow-x-hidden">
      <h1 className="text-2xl font-bold mb-2">Slack Notifications</h1>
      <p className="text-gray-500 mb-6">Configure which events send Slack messages and where they go.</p>

      <div className="space-y-4">
        {EVENT_TYPES.map((et) => {
          const rule = rules.find((r) => r.event_type === et.key)!;
          return (
            <div key={et.key} className="bg-white border border-gray-200 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-gray-900">{et.label}</h3>
                  <p className="text-sm text-gray-500">{et.description}</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => updateRule(et.key, { enabled: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500" />
                </label>
              </div>

              {rule.enabled && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3 pt-3 border-t border-gray-100">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Channel</label>
                    <ChannelPicker
                      channels={channels}
                      value={rule.channel_id}
                      onChange={(channelId, channelName) => {
                        updateRule(et.key, { channel_id: channelId, channel_name: channelName });
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`dm-agent-${et.key}`}
                      checked={rule.dm_assigned_agent}
                      onChange={(e) => updateRule(et.key, { dm_assigned_agent: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    <label htmlFor={`dm-agent-${et.key}`} className="text-sm text-gray-700">DM assigned agent</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`dm-admins-${et.key}`}
                      checked={rule.dm_admins}
                      onChange={(e) => updateRule(et.key, { dm_admins: e.target.checked })}
                      className="rounded border-gray-300"
                    />
                    <label htmlFor={`dm-admins-${et.key}`} className="text-sm text-gray-700">DM all admins</label>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2.5 bg-gray-900 text-white rounded-lg font-medium text-sm hover:bg-gray-800 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {saved && <span className="text-sm text-green-600 font-medium">Saved!</span>}
      </div>
    </div>
  );
}
