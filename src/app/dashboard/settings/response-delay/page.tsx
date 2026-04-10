"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

export default function ResponseDelayPage() {
  const workspace = useWorkspace();
  const [delays, setDelays] = useState<Record<string, number>>({ email: 60, chat: 5, sms: 10, meta_dm: 10, social_comments: 10 });
  const [skipForMembers, setSkipForMembers] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/integrations`)
      .then(r => r.json())
      .then(d => {
        if (d.response_delays) {
          setSkipForMembers(!!d.response_delays.skip_delay_for_members);
          setDelays(d.response_delays);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspace.id]);

  const handleSave = async () => {
    await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_delays: { ...delays, skip_delay_for_members: skipForMembers } }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const channels = [
    { key: "email", label: "Email" },
    { key: "chat", label: "Live Chat" },
    { key: "sms", label: "SMS" },
    { key: "meta_dm", label: "Social DMs" },
    { key: "social_comments", label: "Social Comments" },
  ];

  if (loading) return <div className="p-6"><div className="animate-pulse h-40 bg-zinc-100 dark:bg-zinc-800 rounded-xl" /></div>;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Response Delay</h1>
      <p className="mt-2 text-sm text-zinc-500">How long workflows and AI wait before sending auto-replies. Prevents instant robotic-feeling responses.</p>

      <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="grid grid-cols-2 gap-4">
          {channels.map(ch => (
            <div key={ch.key}>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">{ch.label}</label>
              <div className="mt-1 flex items-center gap-1.5">
                <input
                  type="number"
                  value={delays[ch.key] || 0}
                  onChange={(e) => setDelays({ ...delays, [ch.key]: parseInt(e.target.value) || 0 })}
                  className="w-20 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <span className="text-sm text-zinc-400">seconds</span>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={skipForMembers}
              onChange={(e) => setSkipForMembers(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800"
            />
            <div>
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Skip delays for workspace members</span>
              <p className="text-xs text-zinc-400">Send responses instantly when the customer is also a team member. Useful for testing.</p>
            </div>
          </label>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button onClick={handleSave} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">Save</button>
          {saved && <span className="text-sm text-emerald-600 font-medium">Saved!</span>}
        </div>
      </div>
    </div>
  );
}
