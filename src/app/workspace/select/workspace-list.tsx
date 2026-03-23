"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { selectWorkspace } from "./actions";
import type { WorkspaceWithRole } from "@/lib/types/workspace";

export default function WorkspaceList({
  workspaces,
  autoSelect,
}: {
  workspaces: WorkspaceWithRole[];
  autoSelect?: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    if (autoSelect && workspaces.length === 1) {
      selectWorkspace(workspaces[0].id).then(() => router.push("/dashboard"));
    }
  }, [autoSelect, workspaces, router]);

  if (autoSelect) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-zinc-500">Loading workspace...</p>
      </div>
    );
  }

  const handleSelect = async (workspaceId: string) => {
    await selectWorkspace(workspaceId);
    router.push("/dashboard");
  };

  return (
    <div className="space-y-2">
      {workspaces.map((ws) => (
        <button
          key={ws.id}
          onClick={() => handleSelect(ws.id)}
          className="flex w-full items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50/50 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:border-indigo-600 dark:hover:bg-zinc-700"
        >
          <div>
            <p className="font-medium text-zinc-900 dark:text-zinc-100">{ws.name}</p>
            <p className="text-xs text-zinc-500 capitalize">{ws.role.replace("_", " ")}</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      ))}
    </div>
  );
}
