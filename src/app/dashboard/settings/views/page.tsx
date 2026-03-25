"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface TicketView {
  id: string;
  name: string;
  filters: Record<string, string>;
  parent_id: string | null;
  sort_order: number;
}

export default function ViewsPage() {
  const workspace = useWorkspace();
  const [views, setViews] = useState<TicketView[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<TicketView | null>(null);
  const [members, setMembers] = useState<{ user_id: string; display_name: string | null; email: string | null }[]>([]);
  const [tags, setTags] = useState<string[]>([]);

  if (!["owner", "admin"].includes(workspace.role)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-sm text-zinc-400">You don&apos;t have permission to view this page.</p>
      </div>
    );
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/ticket-views`).then(r => r.json()).then(d => { if (Array.isArray(d)) setViews(d); }).finally(() => setLoading(false));
    fetch(`/api/workspaces/${workspace.id}/members`).then(r => r.json()).then(d => { if (Array.isArray(d)) setMembers(d); });
    fetch(`/api/workspaces/${workspace.id}/tags`).then(r => r.json()).then(d => { if (Array.isArray(d)) setTags(d); });
  }, [workspace.id]);

  const topLevel = views.filter(v => !v.parent_id);
  const childrenOf = (id: string) => views.filter(v => v.parent_id === id);

  const handleSave = async () => {
    if (!editing) return;
    const isNew = !editing.id;
    const url = isNew
      ? `/api/workspaces/${workspace.id}/ticket-views`
      : `/api/workspaces/${workspace.id}/ticket-views/${editing.id}`;

    const res = await fetch(url, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing),
    });

    if (res.ok) {
      const saved = await res.json();
      if (isNew) {
        setViews(prev => [...prev, saved]);
      } else {
        setViews(prev => prev.map(v => v.id === saved.id ? saved : v));
      }
      setEditing(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this view? Children will also be removed.")) return;
    await fetch(`/api/workspaces/${workspace.id}/ticket-views/${id}`, { method: "DELETE" });
    setViews(prev => prev.filter(v => v.id !== id && v.parent_id !== id));
  };

  const createNew = () => {
    setEditing({
      id: "",
      name: "",
      filters: {},
      parent_id: null,
      sort_order: views.length,
    });
  };

  if (loading) return <div className="p-8 text-sm text-zinc-400">Loading...</div>;

  const ViewRow = ({ view, depth }: { view: TicketView; depth: number }) => {
    const kids = childrenOf(view.id);
    const hasFilters = Object.keys(view.filters || {}).length > 0;
    return (
      <>
        <div className="flex items-center justify-between px-4 py-2.5">
          <div className="flex items-center gap-2" style={{ paddingLeft: depth * 20 }}>
            {kids.length > 0 && <span className="text-[10px] text-zinc-400">&#9662;</span>}
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{view.name}</span>
            {hasFilters && (
              <div className="flex gap-1">
                {Object.entries(view.filters).map(([k, v]) => (
                  <span key={k} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] text-zinc-500 dark:bg-zinc-800">
                    {k}: {v}
                  </span>
                ))}
              </div>
            )}
            {!hasFilters && <span className="text-[9px] text-zinc-400">(folder)</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setEditing(view)} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">Edit</button>
            <button onClick={() => handleDelete(view.id)} className="text-xs text-red-500 hover:underline">Delete</button>
          </div>
        </div>
        {kids.map(child => <ViewRow key={child.id} view={child} depth={depth + 1} />)}
      </>
    );
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Ticket Views</h1>
          <p className="mt-1 text-sm text-zinc-500">Manage saved views and their hierarchy in the sidebar.</p>
        </div>
        <button onClick={createNew} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
          New View
        </button>
      </div>

      {/* View tree */}
      {!editing && (
        <div className="mt-6">
          {views.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-400">No views yet. Create one or save filters from the ticket queue.</p>
          ) : (
            <div className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {topLevel.map(view => <ViewRow key={view.id} view={view} depth={0} />)}
            </div>
          )}
        </div>
      )}

      {/* Editor */}
      {editing && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {editing.id ? "Edit View" : "New View"}
          </h2>

          <div className="mt-4 space-y-4">
            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-zinc-500">Name</label>
              <input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g. Open, Billing Issues, VIP"
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </div>

            {/* Parent */}
            <div>
              <label className="block text-xs font-medium text-zinc-500">Parent View</label>
              <select
                value={editing.parent_id || ""}
                onChange={(e) => setEditing({ ...editing, parent_id: e.target.value || null })}
                className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              >
                <option value="">None (top level)</option>
                {views.filter(v => v.id !== editing.id && !v.parent_id).map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
                {/* Also allow nesting under children (double nest) */}
                {views.filter(v => v.id !== editing.id && v.parent_id).map(v => {
                  const parent = views.find(p => p.id === v.parent_id);
                  return (
                    <option key={v.id} value={v.id}>{parent?.name} &gt; {v.name}</option>
                  );
                })}
              </select>
            </div>

            {/* Filters */}
            <div>
              <label className="block text-xs font-medium text-zinc-500">Filters (leave empty for folder-only)</label>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-zinc-400">Status</label>
                  <select
                    value={editing.filters.status || ""}
                    onChange={(e) => {
                      const f = { ...editing.filters };
                      if (e.target.value) f.status = e.target.value; else delete f.status;
                      setEditing({ ...editing, filters: f });
                    }}
                    className="mt-0.5 block w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  >
                    <option value="">Any</option>
                    <option value="open">Open</option>
                    <option value="pending">Pending</option>

                    <option value="closed">Closed</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-400">Channel</label>
                  <select
                    value={editing.filters.channel || ""}
                    onChange={(e) => {
                      const f = { ...editing.filters };
                      if (e.target.value) f.channel = e.target.value; else delete f.channel;
                      setEditing({ ...editing, filters: f });
                    }}
                    className="mt-0.5 block w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  >
                    <option value="">Any</option>
                    <option value="email">Email</option>
                    <option value="chat">Chat</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-400">Assigned To</label>
                  <select
                    value={editing.filters.assigned_to || ""}
                    onChange={(e) => {
                      const f = { ...editing.filters };
                      if (e.target.value) f.assigned_to = e.target.value; else delete f.assigned_to;
                      setEditing({ ...editing, filters: f });
                    }}
                    className="mt-0.5 block w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  >
                    <option value="">Anyone</option>
                    {members.map(m => (
                      <option key={m.user_id} value={m.user_id}>{m.display_name || m.email}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-400">Tag</label>
                  <select
                    value={editing.filters.tag || ""}
                    onChange={(e) => {
                      const f = { ...editing.filters };
                      if (e.target.value) f.tag = e.target.value; else delete f.tag;
                      setEditing({ ...editing, filters: f });
                    }}
                    className="mt-0.5 block w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  >
                    <option value="">Any</option>
                    {tags.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] text-zinc-400">Search (subject)</label>
                  <input
                    value={editing.filters.search || ""}
                    onChange={(e) => {
                      const f = { ...editing.filters };
                      if (e.target.value) f.search = e.target.value; else delete f.search;
                      setEditing({ ...editing, filters: f });
                    }}
                    placeholder="Optional subject search..."
                    className="mt-0.5 block w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  />
                </div>
              </div>
            </div>

            {/* Sort order */}
            <div>
              <label className="block text-xs font-medium text-zinc-500">Sort Order</label>
              <input
                type="number"
                value={editing.sort_order}
                onChange={(e) => setEditing({ ...editing, sort_order: parseInt(e.target.value) || 0 })}
                className="mt-1 w-20 rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              <p className="mt-0.5 text-[10px] text-zinc-400">Lower numbers appear first</p>
            </div>
          </div>

          <div className="mt-6 flex gap-2">
            <button onClick={handleSave} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
              {editing.id ? "Save Changes" : "Create View"}
            </button>
            <button onClick={() => setEditing(null)} className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
