"use client";

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
