"use client";

// Agents → Org Chart (the visual employee/team tree). Lives on its own submenu route;
// the Message Board (/dashboard/agents) opens on the inbox. Reuses the same brain-driven
// /api/developer/agents payload + the shared <OrgTree>. Owner-gated like the rest of the hub.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { OrgTree, type OrgChart } from "@/components/agents/org-tree";

export default function OrgChartPage() {
  const workspace = useWorkspace();
  const [org, setOrg] = useState<OrgChart | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  const load = useCallback(
    () =>
      fetch("/api/developer/agents")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: OrgChart) => {
          setOrg(d);
          setErr(false);
        })
        .catch(() => setErr(true))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    if (workspace.role !== "owner") return;
    load();
  }, [workspace.role, load]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Org Chart</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Org Chart</h1>
        <Link href="/dashboard/agents" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          Message Board →
        </Link>
      </div>
      {loading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : err || !org ? (
        <p className="text-sm text-red-600 dark:text-red-400">Couldn&apos;t load the org chart.</p>
      ) : (
        <OrgTree org={org} />
      )}
    </div>
  );
}
