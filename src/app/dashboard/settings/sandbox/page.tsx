"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

export default function SandboxSettingsPage() {
  const workspace = useWorkspace();
  const [sandboxMode, setSandboxMode] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/integrations`)
      .then(r => r.json())
      .then(data => {
        setSandboxMode(data.sandbox_mode ?? true);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspace.id]);

  const handleToggle = async () => {
    const newVal = !sandboxMode;
    setSandboxMode(newVal);
    setSaving(true);
    await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sandbox_mode: newVal }),
    });
    setSaving(false);
  };

  if (loading) return <div className="p-8 text-center text-zinc-400">Loading...</div>;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Sandbox Mode</h1>
        <p className="mt-1 text-sm text-zinc-500">Control whether AI replies are sent to customers or held for review</p>
      </div>

      <div className={`rounded-lg border p-6 ${sandboxMode ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950" : "border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950"}`}>
        <div className="flex items-center justify-between">
          <div>
            <p className={`text-lg font-semibold ${sandboxMode ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
              {sandboxMode ? "Sandbox" : "Live"}
            </p>
            <p className={`mt-1 text-sm ${sandboxMode ? "text-amber-600/80 dark:text-amber-400/70" : "text-emerald-600/80 dark:text-emerald-400/70"}`}>
              {sandboxMode
                ? "AI drafts appear as internal notes. Agents must approve before sending to customers."
                : "All ticket replies are sent directly to customers."}
            </p>
          </div>
          <button
            onClick={handleToggle}
            disabled={saving}
            className={`shrink-0 rounded-md px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
              sandboxMode
                ? "bg-emerald-600 text-white hover:bg-emerald-500"
                : "bg-amber-600 text-white hover:bg-amber-500"
            }`}
          >
            {sandboxMode ? "Go Live" : "Enable Sandbox"}
          </button>
        </div>
      </div>
    </div>
  );
}
