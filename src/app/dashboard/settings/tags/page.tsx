"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

export default function TagsPage() {
  const workspace = useWorkspace();
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  if (!["owner", "admin"].includes(workspace.role)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-sm text-zinc-400">You don&apos;t have permission to view this page.</p>
      </div>
    );
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/tags`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setTags(data); })
      .finally(() => setLoading(false));
  }, [workspace.id]);

  const handleDelete = async (tag: string) => {
    if (!confirm(`Delete the tag "${tag}"? This will remove it from all tickets that have it.`)) return;
    setDeleting(tag);

    const res = await fetch(`/api/workspaces/${workspace.id}/tags`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag }),
    });

    if (res.ok) {
      setTags((prev) => prev.filter((t) => t !== tag));
    }
    setDeleting(null);
  };

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Tags</h1>
      <p className="mt-2 text-sm text-zinc-500">Manage tags used across your tickets.</p>

      <div className="mt-8 max-w-xl">
        {loading ? (
          <p className="text-sm text-zinc-400">Loading...</p>
        ) : tags.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-400">No tags yet. Tags are created when you add them to tickets.</p>
        ) : (
          <div className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {tags.map((tag) => (
              <div key={tag} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-indigo-50 px-2 py-0.5 text-sm font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                    {tag}
                  </span>
                </div>
                <button
                  onClick={() => handleDelete(tag)}
                  disabled={deleting === tag}
                  className="text-sm text-red-500 hover:underline disabled:opacity-50"
                >
                  {deleting === tag ? "Deleting..." : "Delete"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
