"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface JourneyDef {
  id: string;
  slug: string;
  name: string;
  journey_type: string;
  is_active: boolean;
  config: Record<string, unknown>;
  stats: { sent: number; completed: number; saved: number; cancelled: number };
  created_at: string;
}

const TYPE_COLORS: Record<string, string> = {
  cancellation: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  win_back: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  pause: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  product_swap: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  custom: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

export default function JourneysSettingsPage() {
  const workspace = useWorkspace();
  const [journeys, setJourneys] = useState<JourneyDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);

  async function load() {
    const res = await fetch(`/api/workspaces/${workspace.id}/journeys`);
    const data = await res.json();
    if (Array.isArray(data)) setJourneys(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, [workspace.id]);

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
  }

  async function deleteJourney(id: string) {
    if (!confirm("Delete this journey? Active sessions will stop working.")) return;
    await fetch(`/api/workspaces/${workspace.id}/journeys/${id}`, { method: "DELETE" });
    load();
  }

  const hasCancellation = journeys.some((j) => j.journey_type === "cancellation");

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Journeys</h1>
      <p className="mt-2 text-sm text-zinc-500">Customer-facing retention flows. Send tokenized links that guide customers through structured decisions.</p>

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
              <div key={j.id} className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{j.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${TYPE_COLORS[j.journey_type] || TYPE_COLORS.custom}`}>
                      {j.journey_type.replace("_", " ")}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${j.is_active ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"}`}>
                      {j.is_active ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleActive(j.id, !j.is_active)}
                      className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                    >
                      {j.is_active ? "Disable" : "Enable"}
                    </button>
                    <button
                      onClick={() => deleteJourney(j.id)}
                      className="text-sm text-red-500 hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {/* Stats */}
                <div className="mt-4 grid grid-cols-4 gap-4">
                  <div>
                    <p className="text-sm text-zinc-400">Sent</p>
                    <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{j.stats.sent}</p>
                  </div>
                  <div>
                    <p className="text-sm text-zinc-400">Completed</p>
                    <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{j.stats.completed}</p>
                  </div>
                  <div>
                    <p className="text-sm text-zinc-400">Saved</p>
                    <p className="text-lg font-semibold text-emerald-600">{j.stats.saved}</p>
                  </div>
                  <div>
                    <p className="text-sm text-zinc-400">Save Rate</p>
                    <p className={`text-lg font-semibold ${saveRate >= 30 ? "text-emerald-600" : saveRate >= 15 ? "text-amber-600" : "text-red-600"}`}>
                      {saveRate}%
                    </p>
                  </div>
                </div>

                <p className="mt-3 text-sm text-zinc-400">
                  Slug: <code className="rounded bg-zinc-100 px-1 text-sm dark:bg-zinc-800">{j.slug}</code>
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
