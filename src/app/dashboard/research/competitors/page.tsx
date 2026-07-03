"use client";

// Research › Competitors — the owner-facing, read-only competitor set surface
// (docs/brain/specs/research-sidebar-competitors.md, Phase 1: shell only). Phase 2 fills the
// product filter + table by reading GET /api/ads/competitors. Owner-gated the same way the
// sibling acquisition page is: the API returns 403 for non-owners and the client renders the
// forbidden fallback. Until the API wires in (Phase 2), gate on the workspace role directly so
// hitting this URL as a non-owner shows the same "owner-only" message.

import { useWorkspace } from "@/lib/workspace-context";

export default function ResearchCompetitorsPage() {
  const workspace = useWorkspace();

  if (workspace.role !== "owner") {
    return (
      <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
        <h1 className="mb-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Competitors</h1>
        <p className="text-sm text-zinc-500">This surface is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Competitors</h1>
      <p className="mb-6 text-sm text-zinc-500">
        The competitor set discovered and approved on this workspace. Read-only — discovery and
        approval stay on the Acquisition Research Hub.
      </p>
      <div className="rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
        Table coming in Phase 2.
      </div>
    </div>
  );
}
