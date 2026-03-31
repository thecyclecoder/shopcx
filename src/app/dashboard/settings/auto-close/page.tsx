"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

export default function AutoClosePage() {
  const workspace = useWorkspace();
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/integrations`)
      .then(r => r.json())
      .then(d => { setMessage(d.auto_close_reply || "You're welcome! If you need anything else, we're always here to help."); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspace.id]);

  const handleSave = async () => {
    await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_close_reply: message }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  if (loading) return <div className="p-6"><div className="animate-pulse h-40 bg-zinc-100 dark:bg-zinc-800 rounded-xl" /></div>;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Auto-Close Reply</h1>
      <p className="mt-2 text-sm text-zinc-500">Message sent when a customer confirms with "thanks" or similar after a workflow reply.</p>

      <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <textarea
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <div className="mt-4 flex items-center gap-2">
          <button onClick={handleSave} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">Save</button>
          {saved && <span className="text-sm text-emerald-600 font-medium">Saved!</span>}
        </div>
      </div>
    </div>
  );
}
