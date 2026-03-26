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
            <p className="mt-1 text-xs text-zinc-500">Connect Resend, Shopify, Stripe, and more</p>
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
            <p className="mt-1 text-xs text-zinc-500">Automate ticket tagging, assignment, replies, and more</p>
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
            <p className="mt-1 text-xs text-zinc-500">Automated multi-step responses to order tracking, cancellations, and more</p>
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
            <p className="mt-1 text-xs text-zinc-500">Auto-tag tickets based on message content patterns</p>
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
            <p className="mt-1 text-xs text-zinc-500">Manage saved views and sidebar hierarchy</p>
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
            <p className="mt-1 text-xs text-zinc-500">Manage ticket tags used across your workspace</p>
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
            <p className="mt-1 text-xs text-zinc-500">Upload CSV files for subscriptions and other data</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <AutoCloseReplyEditor workspaceId={workspace.id} />

        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Workspace</h2>
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-zinc-500">Name</label>
              <p className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">{workspace.name}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-500">Your Role</label>
              <p className="mt-1 text-sm capitalize text-zinc-900 dark:text-zinc-100">
                {workspace.role.replace("_", " ")}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-500">Workspace ID</label>
              <p className="mt-1 font-mono text-xs text-zinc-400">{workspace.id}</p>
            </div>
          </div>
        </div>
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
      <p className="mt-1 text-xs text-zinc-500">Message sent when a customer confirms with &ldquo;thanks&rdquo; or similar after a workflow reply.</p>
      <textarea
        rows={2}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        className="mt-3 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      <div className="mt-2 flex items-center gap-2">
        <button onClick={handleSave} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500">
          Save
        </button>
        {saved && <span className="text-xs text-emerald-600">Saved!</span>}
      </div>
    </div>
  );
}
