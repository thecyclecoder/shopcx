"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

export default function SettingsPage() {
  const workspace = useWorkspace();

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Settings</h1>
      <p className="mt-2 text-sm text-zinc-500">Manage your workspace configuration.</p>

      <div className="mt-8 max-w-xl space-y-4">
        <Link
          href="/dashboard/settings/integrations"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Integrations</h2>
            <p className="mt-1 text-sm text-zinc-500">Connect Resend, Shopify, Stripe, and more</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/rules"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Rules</h2>
            <p className="mt-1 text-sm text-zinc-500">Automate ticket tagging, assignment, replies, and more</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/journeys"
          className="flex items-center justify-between rounded-lg border border-cyan-200 bg-cyan-50 p-5 transition-colors hover:border-cyan-300 dark:border-cyan-800 dark:bg-cyan-950 dark:hover:border-cyan-700"
        >
          <div>
            <h2 className="text-sm font-medium text-cyan-900 dark:text-cyan-100">Journeys</h2>
            <p className="mt-1 text-sm text-cyan-600 dark:text-cyan-400">Customer-facing retention flows — cancellation, win-back, pause, and more</p>
          </div>
          <svg className="h-5 w-5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/ai"
          className="flex items-center justify-between rounded-lg border border-violet-200 bg-violet-50 p-5 transition-colors hover:border-violet-300 dark:border-violet-800 dark:bg-violet-950 dark:hover:border-violet-700"
        >
          <div>
            <h2 className="text-sm font-medium text-violet-900 dark:text-violet-100">AI Agent</h2>
            <p className="mt-1 text-sm text-violet-600 dark:text-violet-400">Knowledge base, macros, personalities, channel config, and AI workflows</p>
          </div>
          <svg className="h-5 w-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/macros"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Macros</h2>
            <p className="mt-1 text-sm text-zinc-500">Saved responses for common customer inquiries</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/workflows"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Workflows</h2>
            <p className="mt-1 text-sm text-zinc-500">Automated multi-step responses to order tracking, cancellations, and more</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/patterns"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Smart Patterns</h2>
            <p className="mt-1 text-sm text-zinc-500">Auto-tag tickets based on message content patterns</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/views"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Ticket Views</h2>
            <p className="mt-1 text-sm text-zinc-500">Manage saved views and sidebar hierarchy</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/tags"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Tags</h2>
            <p className="mt-1 text-sm text-zinc-500">Manage ticket tags used across your workspace</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/import"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Import Data</h2>
            <p className="mt-1 text-sm text-zinc-500">Upload CSV files for subscriptions and other data</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <ResponseDelayEditor workspaceId={workspace.id} />
        <AutoCloseReplyEditor workspaceId={workspace.id} />

        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Workspace</h2>
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-sm font-medium text-zinc-500">Name</label>
              <p className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">{workspace.name}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-500">Your Role</label>
              <p className="mt-1 text-sm capitalize text-zinc-900 dark:text-zinc-100">
                {workspace.role.replace("_", " ")}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-500">Workspace ID</label>
              <p className="mt-1 font-mono text-sm text-zinc-400">{workspace.id}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResponseDelayEditor({ workspaceId }: { workspaceId: string }) {
  const [delays, setDelays] = useState<Record<string, number>>({ email: 60, chat: 5, sms: 10, meta_dm: 10 });
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/integrations`)
      .then(r => r.json())
      .then(d => { if (d.response_delays) setDelays(d.response_delays); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const handleSave = async () => {
    await fetch(`/api/workspaces/${workspaceId}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_delays: delays }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return null;

  const channels = [
    { key: "email", label: "Email" },
    { key: "chat", label: "Live Chat" },
    { key: "sms", label: "SMS" },
    { key: "meta_dm", label: "Social DMs" },
  ];

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Response Delay</h2>
      <p className="mt-1 text-sm text-zinc-500">How long workflows and AI wait before sending auto-replies. Prevents instant robotic-feeling responses.</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {channels.map(ch => (
          <div key={ch.key}>
            <label className="block text-sm text-zinc-500">{ch.label}</label>
            <div className="mt-1 flex items-center gap-1.5">
              <input
                type="number"
                value={delays[ch.key] || 0}
                onChange={(e) => setDelays({ ...delays, [ch.key]: parseInt(e.target.value) || 0 })}
                className="w-20 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              <span className="text-sm text-zinc-400">seconds</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={handleSave} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">Save</button>
        {saved && <span className="text-sm text-emerald-600">Saved!</span>}
      </div>
    </div>
  );
}

function AutoCloseReplyEditor({ workspaceId }: { workspaceId: string }) {
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/integrations`)
      .then(r => r.json())
      .then(d => { setMessage(d.auto_close_reply || "You're welcome! If you need anything else, we're always here to help."); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const handleSave = async () => {
    await fetch(`/api/workspaces/${workspaceId}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_close_reply: message }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return null;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Auto-Close Reply</h2>
      <p className="mt-1 text-sm text-zinc-500">Message sent when a customer confirms with &ldquo;thanks&rdquo; or similar after a workflow reply.</p>
      <textarea
        rows={2}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        className="mt-3 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      <div className="mt-2 flex items-center gap-2">
        <button onClick={handleSave} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
          Save
        </button>
        {saved && <span className="text-sm text-emerald-600">Saved!</span>}
      </div>
    </div>
  );
}
