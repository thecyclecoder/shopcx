"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import type { WorkspaceMember, WorkspaceRole } from "@/lib/types/workspace";

const ROLE_OPTIONS: { value: WorkspaceRole; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "agent", label: "Agent" },
  { value: "social", label: "Social" },
  { value: "marketing", label: "Marketing" },
  { value: "read_only", label: "Read Only" },
];

export default function TeamPage() {
  const workspace = useWorkspace();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("agent");
  const [inviting, setInviting] = useState(false);
  const [message, setMessage] = useState("");

  const canManage = ["owner", "admin"].includes(workspace.role);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/members`)
      .then((res) => res.json())
      .then((data) => {
        setMembers(data);
        setLoading(false);
      });
  }, [workspace.id]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;

    setInviting(true);
    setMessage("");

    const res = await fetch(`/api/workspaces/${workspace.id}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
    });

    const data = await res.json();

    if (res.ok) {
      const emailNote = data.email_sent ? " (email sent)" : " (email not sent — configure Resend in Settings > Integrations)";
      setMessage(`Invite created for ${inviteEmail}${emailNote}`);
      setInviteEmail("");
    } else {
      setMessage(data.error || "Failed to send invite");
    }
    setInviting(false);
  };

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Team</h1>
      <p className="mt-2 text-sm text-zinc-500">Manage workspace members and invites.</p>

      {/* Invite form */}
      {canManage && (
        <form onSubmit={handleInvite} className="mt-6 flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-zinc-500">Email</label>
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="teammate@company.com"
              required
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-500">Role</label>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
              className="mt-1 block rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={inviting}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          >
            {inviting ? "Sending..." : "Invite"}
          </button>
        </form>
      )}

      {message && (
        <p className="mt-3 text-sm text-indigo-600 dark:text-indigo-400">{message}</p>
      )}

      {/* Members list */}
      <div className="mt-8">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Members</h2>
        {loading ? (
          <p className="mt-4 text-sm text-zinc-400">Loading...</p>
        ) : (
          <div className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {members.map((member) => (
              <div key={member.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {member.display_name || member.email}
                  </p>
                  {member.display_name && (
                    <p className="text-xs text-zinc-400">{member.email}</p>
                  )}
                </div>
                <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium capitalize text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {member.role.replace("_", " ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
