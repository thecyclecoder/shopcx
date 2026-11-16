"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { selectWorkspace } from "@/app/workspace/select/actions";
import type { WorkspaceWithRole } from "@/lib/types/workspace";

// The sidebar's workspace name block (src/app/dashboard/sidebar.tsx) becomes this switcher. With a
// single workspace it renders exactly as the old static block (no menu). With more than one, the
// name block becomes a button opening a small menu — same zinc/indigo styling as
// src/app/workspace/select/workspace-list.tsx — listing every workspace the user belongs to with
// its role, the current one checked. Selecting a workspace runs the existing selectWorkspace server
// action, then navigates to the target's dashboard and refreshes.
export default function WorkspaceSwitcher({
  current,
  workspaces,
}: {
  current: WorkspaceWithRole;
  workspaces: WorkspaceWithRole[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleSelect = async (workspaceId: string) => {
    if (workspaceId === current.id) { setOpen(false); return; }
    setSwitching(true);
    try {
      await selectWorkspace(workspaceId);
      // workspace-feature-access (M1) gates whether a workspace exposes the full dashboard. Until
      // that feature ships there is no per-workspace dashboard flag, so every workspace lands on
      // /dashboard; wire the tickets-only fallback here once the feature exposes the flag.
      router.push("/dashboard");
      router.refresh();
    } finally {
      setSwitching(false);
      setOpen(false);
    }
  };

  const roleLabel = (role: string) => role.replace("_", " ");

  // Single workspace: render exactly as the old static block (no menu, not a button).
  if (workspaces.length <= 1) {
    return (
      <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {current.name}
        </p>
        <p className="text-sm capitalize text-zinc-400">{roleLabel(current.role)}</p>
      </div>
    );
  }

  return (
    <div ref={menuRef} className="relative border-b border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={switching}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-5 py-3 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {current.name}
          </span>
          <span className="block text-sm capitalize text-zinc-400">{roleLabel(current.role)}</span>
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute inset-x-2 top-full z-50 mt-1 space-y-1 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
        >
          {workspaces.map((ws) => {
            const isCurrent = ws.id === current.id;
            return (
              <button
                key={ws.id}
                type="button"
                role="menuitem"
                disabled={switching}
                onClick={() => handleSelect(ws.id)}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50/50 dark:hover:border-indigo-600 dark:hover:bg-zinc-700"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {ws.name}
                  </span>
                  <span className="block text-sm capitalize text-zinc-500">{roleLabel(ws.role)}</span>
                </span>
                {isCurrent && (
                  <svg className="h-4 w-4 shrink-0 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
          <Link
            href="/workspace/new"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-lg border-t border-zinc-100 px-3 py-2 pt-3 text-sm font-medium text-indigo-600 transition-colors hover:bg-indigo-50/50 dark:border-zinc-700 dark:text-indigo-400 dark:hover:bg-zinc-700"
          >
            <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Create workspace
          </Link>
        </div>
      )}
    </div>
  );
}
