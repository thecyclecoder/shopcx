"use client";

import { useEffect, useState, useRef } from "react";
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
            <label className="block text-sm font-medium text-zinc-500">Email</label>
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
            <label className="block text-sm font-medium text-zinc-500">Role</label>
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
              <MemberRow
                key={member.id}
                member={member}
                workspaceId={workspace.id}
                canManage={canManage}
                onRemove={() => setMembers(prev => prev.filter(m => m.user_id !== member.user_id))}
                onUpdate={(updated) => setMembers(prev => prev.map(m => m.id === updated.id ? updated : m))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MemberRow({
  member,
  workspaceId,
  canManage,
  onRemove,
  onUpdate,
}: {
  member: WorkspaceMember;
  workspaceId: string;
  canManage: boolean;
  onRemove: () => void;
  onUpdate: (m: WorkspaceMember) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [nameValue, setNameValue] = useState(member.display_name || "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const saveName = async () => {
    setSaving(true);
    await fetch(`/api/workspaces/${workspaceId}/members`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: member.user_id, display_name: nameValue.trim() }),
    });
    onUpdate({ ...member, display_name: nameValue.trim() || undefined });
    setEditing(false);
    setSaving(false);
  };

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditing(false); }}
              placeholder="Display name"
              className="w-48 rounded border border-indigo-300 bg-white px-2 py-1 text-sm text-zinc-900 outline-none dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <button onClick={saveName} disabled={saving} className="text-xs font-medium text-indigo-600 hover:underline">
              {saving ? "..." : "Save"}
            </button>
            <button onClick={() => setEditing(false)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {member.display_name || member.email}
            </p>
            <button
              onClick={() => { setNameValue(member.display_name || ""); setEditing(true); }}
              className="rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-400 hover:border-indigo-300 hover:text-indigo-500 dark:border-zinc-700"
            >
              edit name
            </button>
          </div>
        )}
        {!editing && member.display_name && (
          <p className="text-xs text-zinc-400">{member.email}</p>
        )}
        {!editing && !member.display_name && (
          <p className="text-[11px] text-zinc-300 dark:text-zinc-600">No display name set</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium capitalize text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {member.role.replace("_", " ")}
        </span>
        {canManage && member.role !== "owner" && (
          <button
            onClick={async () => {
              if (!confirm(`Remove ${member.display_name || member.email} from this workspace?`)) return;
              const res = await fetch(`/api/workspaces/${workspaceId}/members`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user_id: member.user_id }),
              });
              if (res.ok) onRemove();
            }}
            className="text-xs text-red-500 hover:underline"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
