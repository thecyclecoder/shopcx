"use client";

import { useWorkspace } from "@/lib/workspace-context";

export default function SettingsPage() {
  const workspace = useWorkspace();
  const canEdit = ["owner", "admin"].includes(workspace.role);

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Settings</h1>
      <p className="mt-2 text-sm text-zinc-500">Manage your workspace configuration.</p>

      <div className="mt-8 max-w-xl space-y-6">
        {/* Workspace info */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Workspace</h2>
          <div className="mt-4 space-y-4">
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

        {/* Integrations placeholder */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Integrations</h2>
          <div className="mt-4 space-y-3">
            {[
              { name: "Shopify", status: "Not connected", phase: 2 },
              { name: "Stripe", status: "Not connected", phase: 7 },
              { name: "Meta", status: "Not connected", phase: 6 },
            ].map((integration) => (
              <div key={integration.name} className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-900 dark:text-zinc-100">{integration.name}</p>
                  <p className="text-xs text-zinc-400">{integration.status}</p>
                </div>
                <button
                  disabled={!canEdit}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Connect
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
