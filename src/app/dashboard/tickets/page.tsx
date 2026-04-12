"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface TicketRow {
  id: string;
  status: string;
  subject: string | null;
  channel: string;
  assigned_to: string | null;
  assigned_name: string | null;
  escalated_to: string | null;
  auto_reply_at: string | null;
  last_customer_reply_at: string | null;
  customer_email: string | null;
  customer_name: string | null;
  snoozed_until: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface Member {
  user_id: string;
  display_name: string | null;
  email: string | null;
}

const STATUS_OPTIONS = ["all", "open", "pending", "closed", "archived"] as const;
const CHANNEL_OPTIONS = ["all", "email", "chat", "portal", "social_comments", "meta_dm", "sms"] as const;

const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  closed: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  archived: "bg-zinc-50 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-500",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] || STATUS_COLORS.closed;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-sm font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const PAGE_SIZE = 25;

export default function TicketsPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewId = searchParams.get("view");
  const urlStatus = searchParams.get("status");
  const urlEscalationMine = searchParams.get("escalation_mine");

  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [snoozedFilter, setSnoozedFilter] = useState(false);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [viewName, setViewName] = useState("");
  const [viewParentId, setViewParentId] = useState("");
  const [existingViews, setExistingViews] = useState<{ id: string; name: string; parent_id: string | null }[]>([]);
  const [savingView, setSavingView] = useState(false);
  const [activeViewName, setActiveViewName] = useState<string | null>(null);

  const [members, setMembers] = useState<Member[]>([]);
  const [showNewTicket, setShowNewTicket] = useState(false);
  const [newTicketEmail, setNewTicketEmail] = useState("");
  const [newTicketSubject, setNewTicketSubject] = useState("");
  const [newTicketMessage, setNewTicketMessage] = useState("");
  const [creating, setCreating] = useState(false);

  // Bulk selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAssignDropdown, setShowAssignDropdown] = useState(false);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [newBulkTag, setNewBulkTag] = useState("");
  const lastClickedIndex = useRef<number | null>(null);
  const isAdmin = workspace.role === "owner" || workspace.role === "admin";

  // Clear view when filters change manually
  const clearView = () => {
    if (viewId) {
      router.replace("/dashboard/tickets");
    }
    setActiveViewName(null);
  };

  // Apply URL params (from sidebar escalation links)
  useEffect(() => {
    if (urlStatus && !viewId) setStatusFilter(urlStatus);
  }, [urlStatus, viewId]);

  // Load view filters when viewId changes, or reset when cleared
  const [viewLoaded, setViewLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (!viewId) {
      // Reset all filters when clicking "Tickets" (no view)
      if (viewLoaded) {
        setStatusFilter("all");
        setChannelFilter("all");
        setAssigneeFilter("");
        setTagFilter([]);
        setSearch("");
        setOffset(0);
      }
      setActiveViewName(null);
      setViewLoaded(null);
      return;
    }
    fetch(`/api/workspaces/${workspace.id}/ticket-views`)
      .then(r => r.json())
      .then((views) => {
        if (!Array.isArray(views)) return;
        const view = views.find((v: { id: string }) => v.id === viewId);
        if (view) {
          const f = view.filters as Record<string, string>;
          setStatusFilter(f.status || "all");
          setChannelFilter(f.channel || "all");
          setAssigneeFilter(f.assigned_to || "");
          setTagFilter(f.tag ? f.tag.split(",").map((t: string) => t.trim()) : []);
          setSearch(f.search || "");
          setOffset(0);
          setActiveViewName(view.name);
          setViewLoaded(viewId);
        }
      });
  }, [viewId, workspace.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch members + tags
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/members`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setMembers(data); })
      .catch(() => {});
    fetch(`/api/workspaces/${workspace.id}/tags`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setAvailableTags(data); })
      .catch(() => {});
  }, [workspace.id]);

  const fetchTickets = useCallback(async (silent = false) => {
    // Don't fetch until view filters are loaded (prevents flash of unfiltered results)
    if (viewId && viewLoaded !== viewId) return;
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({
        sort: "updated_at",
        order: "desc",
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (channelFilter !== "all") params.set("channel", channelFilter);
      if (assigneeFilter) params.set("assigned_to", assigneeFilter);
      if (tagFilter.length > 0) params.set("tag", tagFilter.join(","));
      if (snoozedFilter) params.set("snoozed", "true");
      if (search) params.set("search", search);
      if (urlEscalationMine) params.set("escalation_mine", "true");

      const res = await fetch(`/api/tickets?${params}`);
      const data = await res.json();
      if (res.ok) {
        setTickets(data.tickets);
        setTotal(data.total);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [statusFilter, channelFilter, assigneeFilter, tagFilter, snoozedFilter, search, offset, urlEscalationMine, viewId, viewLoaded]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  // Auto-refresh every 10 seconds (silent — no loading flash)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchTickets(true);
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchTickets]);

  // Escape to clear selection
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selected.size > 0) {
        setSelected(new Set());
        setShowAssignDropdown(false);
        setShowTagDropdown(false);
        setShowStatusDropdown(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected.size]);

  // Auto-dismiss bulk message
  useEffect(() => {
    if (bulkMessage) {
      const timer = setTimeout(() => setBulkMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [bulkMessage]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setOffset(0);
    fetchTickets();
  };

  const handleCreateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTicketSubject.trim() || !newTicketMessage.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_email: newTicketEmail || undefined,
          subject: newTicketSubject,
          message: newTicketMessage,
        }),
      });
      if (res.ok) {
        const ticket = await res.json();
        setShowNewTicket(false);
        setNewTicketEmail("");
        setNewTicketSubject("");
        setNewTicketMessage("");
        router.push(`/dashboard/tickets/${ticket.id}`);
      }
    } finally {
      setCreating(false);
    }
  };

  // Bulk action handler
  const executeBulkAction = async (action: string, value?: string) => {
    if (selected.size === 0) return;
    setBulkLoading(true);
    setShowAssignDropdown(false);
    setShowTagDropdown(false);
    setShowStatusDropdown(false);
    try {
      const res = await fetch("/api/tickets/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket_ids: Array.from(selected),
          action,
          value,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const actionLabels: Record<string, string> = {
          close: "closed",
          assign: "assigned",
          set_status: `set to ${value}`,
          add_tag: `tagged "${value}"`,
          remove_tag: `untagged "${value}"`,
          delete: "deleted",
        };
        setBulkMessage(`${data.updated} ticket${data.updated !== 1 ? "s" : ""} ${actionLabels[action] || action}`);
        setSelected(new Set());
        lastClickedIndex.current = null;
        fetchTickets();
      } else {
        setBulkMessage(data.error || "Bulk action failed");
      }
    } catch {
      setBulkMessage("Bulk action failed");
    } finally {
      setBulkLoading(false);
    }
  };

  // Selection helpers
  const toggleSelect = (id: string, index: number, shiftKey: boolean) => {
    const next = new Set(selected);
    if (shiftKey && lastClickedIndex.current !== null) {
      const start = Math.min(lastClickedIndex.current, index);
      const end = Math.max(lastClickedIndex.current, index);
      for (let i = start; i <= end; i++) {
        next.add(tickets[i].id);
      }
    } else {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    }
    lastClickedIndex.current = index;
    setSelected(next);
  };

  const toggleSelectAll = () => {
    if (selected.size === tickets.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(tickets.map(t => t.id)));
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="px-4 py-6 sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Tickets</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {total} ticket{total !== 1 ? "s" : ""} in this workspace.
          </p>
        </div>
        <button
          onClick={() => setShowNewTicket(true)}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
        >
          New Ticket
        </button>
      </div>

      {/* New Ticket Modal */}
      {showNewTicket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Create Ticket</h2>
            <form onSubmit={handleCreateTicket} className="mt-4 space-y-3">
              <div>
                <label className="block text-sm font-medium text-zinc-500">Customer Email</label>
                <input
                  type="email"
                  value={newTicketEmail}
                  onChange={(e) => setNewTicketEmail(e.target.value)}
                  placeholder="customer@example.com"
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-500">Subject *</label>
                <input
                  type="text"
                  required
                  value={newTicketSubject}
                  onChange={(e) => setNewTicketSubject(e.target.value)}
                  placeholder="Issue summary"
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-500">Message *</label>
                <textarea
                  required
                  rows={4}
                  value={newTicketMessage}
                  onChange={(e) => setNewTicketMessage(e.target.value)}
                  placeholder="Describe the issue..."
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewTicket(false)}
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                >
                  {creating ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Delete Tickets</h2>
            <p className="mt-2 text-sm text-zinc-500">
              Are you sure you want to delete {selected.size} ticket{selected.size !== 1 ? "s" : ""}? This action cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowDeleteConfirm(false); executeBulkAction("delete"); }}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Message Toast */}
      {bulkMessage && (
        <div className="fixed right-8 top-8 z-50 rounded-lg border border-zinc-200 bg-white px-4 py-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{bulkMessage}</p>
        </div>
      )}

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium text-zinc-500">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setOffset(0); clearView(); }}
            className="mt-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-500">Channel</label>
          <select
            value={channelFilter}
            onChange={(e) => { setChannelFilter(e.target.value); setOffset(0); clearView(); }}
            className="mt-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          >
            {CHANNEL_OPTIONS.map((c) => (
              <option key={c} value={c}>{c === "all" ? "All Channels" : { email: "Email", chat: "Live Chat", portal: "Portal", social_comments: "Social Comments", meta_dm: "Social DMs", sms: "SMS" }[c] || c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-500">Assigned To</label>
          <select
            value={assigneeFilter}
            onChange={(e) => { setAssigneeFilter(e.target.value); setOffset(0); clearView(); }}
            className="mt-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          >
            <option value="">Anyone</option>
            <option value="__ai_agent">AI Agent</option>
            <option value="__workflow">Workflow</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>{m.display_name || m.email}</option>
            ))}
          </select>
        </div>
        {availableTags.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-zinc-500">Tags</label>
            <div className="mt-1 flex flex-wrap items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800">
              {tagFilter.map(t => (
                <span key={t} className="inline-flex items-center gap-0.5 rounded bg-indigo-50 px-1.5 py-0.5 text-sm font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                  {t}
                  <button onClick={() => { setTagFilter(tagFilter.filter(x => x !== t)); setOffset(0); clearView(); }} className="text-indigo-400 hover:text-indigo-600">x</button>
                </span>
              ))}
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value && !tagFilter.includes(e.target.value)) {
                    setTagFilter([...tagFilter, e.target.value]);
                    setOffset(0);
                    clearView();
                  }
                  e.target.value = "";
                }}
                className="min-w-[80px] flex-1 border-none bg-transparent text-sm text-zinc-500 outline-none dark:text-zinc-400"
              >
                <option value="">{tagFilter.length === 0 ? "All tags" : "+ add"}</option>
                {availableTags.filter(t => !tagFilter.includes(t)).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-zinc-500">Snoozed</label>
          <button
            onClick={() => { setSnoozedFilter(!snoozedFilter); setOffset(0); clearView(); }}
            className={`mt-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
              snoozedFilter
                ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-400"
                : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            <svg className="inline-block h-4 w-4 mr-1 -mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Snoozed
          </button>
        </div>
        <form onSubmit={handleSearch} className="flex-1">
          <label className="block text-sm font-medium text-zinc-500">Search</label>
          <div className="relative mt-1">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              type="text"
              placeholder="Search by subject..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="block w-full rounded-md border border-zinc-300 bg-white py-2 pl-10 pr-3 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>
        </form>
      </div>

      {/* Active view name + Save as View */}
      <div className="mt-3 flex items-center gap-3">
        {activeViewName && (
          <span className="rounded bg-indigo-50 px-2 py-0.5 text-sm font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
            View: {activeViewName}
          </span>
        )}
        {(statusFilter !== "all" || channelFilter !== "all" || assigneeFilter || tagFilter.length > 0 || search) && !viewId && (
          <div className="flex items-center gap-1.5">
            {savingView ? (
              <form onSubmit={async (e) => {
                e.preventDefault();
                if (!viewName.trim()) return;
                const filters: Record<string, string> = {};
                if (statusFilter !== "all") filters.status = statusFilter;
                if (channelFilter !== "all") filters.channel = channelFilter;
                if (assigneeFilter) filters.assigned_to = assigneeFilter;
                if (tagFilter.length > 0) filters.tag = tagFilter.join(",");
                if (search) filters.search = search;
                const res = await fetch(`/api/workspaces/${workspace.id}/ticket-views`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: viewName, filters, parent_id: viewParentId || null }),
                });
                if (res.ok) {
                  setSavingView(false);
                  setViewName("");
                  window.location.reload(); // Reload to refresh sidebar
                }
              }} className="flex items-center gap-1.5">
                <input
                  value={viewName}
                  onChange={(e) => setViewName(e.target.value)}
                  placeholder="View name..."
                  autoFocus
                  className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
                <select
                  value={viewParentId}
                  onChange={(e) => setViewParentId(e.target.value)}
                  className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                >
                  <option value="">No parent (top level)</option>
                  {existingViews.filter(v => !v.parent_id).map(v => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                <button type="submit" className="rounded bg-indigo-600 px-2 py-0.5 text-sm font-medium text-white hover:bg-indigo-500">Save</button>
                <button type="button" onClick={() => setSavingView(false)} className="text-sm text-zinc-400">Cancel</button>
              </form>
            ) : (
              <button onClick={() => {
                setSavingView(true);
                fetch(`/api/workspaces/${workspace.id}/ticket-views`).then(r => r.json()).then(d => {
                  if (Array.isArray(d)) setExistingViews(d);
                });
              }} className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
                Save as View
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bulk Action Bar */}
      {selected.size > 0 && (
        <div className="sticky top-0 z-30 mt-4 flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 shadow-sm dark:border-indigo-800 dark:bg-indigo-950/50">
          <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
            {selected.size} selected
          </span>
          <div className="mx-2 h-4 w-px bg-indigo-200 dark:bg-indigo-800" />
          <button
            onClick={() => executeBulkAction("close")}
            disabled={bulkLoading}
            className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
          >
            Close
          </button>

          {/* Assign Dropdown */}
          <div className="relative">
            <button
              onClick={() => { setShowAssignDropdown(!showAssignDropdown); setShowTagDropdown(false); setShowStatusDropdown(false); }}
              disabled={bulkLoading}
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              Assign &#9662;
            </button>
            {showAssignDropdown && (
              <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                {members.map(m => (
                  <button
                    key={m.user_id}
                    onClick={() => executeBulkAction("assign", m.user_id)}
                    className="block w-full px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                  >
                    {m.display_name || m.email}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Tag Dropdown */}
          <div className="relative">
            <button
              onClick={() => { setShowTagDropdown(!showTagDropdown); setShowAssignDropdown(false); setShowStatusDropdown(false); }}
              disabled={bulkLoading}
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              Tag &#9662;
            </button>
            {showTagDropdown && (
              <div className="absolute left-0 top-full z-40 mt-1 w-56 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                <div className="border-b border-zinc-100 px-3 py-1.5 dark:border-zinc-700">
                  <form onSubmit={(e) => { e.preventDefault(); if (newBulkTag.trim()) { executeBulkAction("add_tag", newBulkTag.trim()); setNewBulkTag(""); } }}>
                    <input
                      value={newBulkTag}
                      onChange={(e) => setNewBulkTag(e.target.value)}
                      placeholder="New tag..."
                      autoFocus
                      className="w-full border-none bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
                    />
                  </form>
                </div>
                {availableTags.map(tag => (
                  <button
                    key={tag}
                    onClick={() => executeBulkAction("add_tag", tag)}
                    className="block w-full px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                  >
                    + {tag}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Status Dropdown */}
          <div className="relative">
            <button
              onClick={() => { setShowStatusDropdown(!showStatusDropdown); setShowAssignDropdown(false); setShowTagDropdown(false); }}
              disabled={bulkLoading}
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              Status &#9662;
            </button>
            {showStatusDropdown && (
              <div className="absolute left-0 top-full z-40 mt-1 w-36 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                {(["open", "pending", "closed"] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => executeBulkAction("set_status", s)}
                    className="block w-full px-3 py-1.5 text-left text-sm capitalize text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {selected.size >= 2 && (
            <button
              onClick={async () => {
                const ids = Array.from(selected);
                if (!confirm(`Merge ${ids.length} tickets? Messages will be combined into the oldest ticket chronologically. Newer tickets will be archived.`)) return;
                setBulkLoading(true);
                try {
                  const res = await fetch("/api/tickets/merge", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ticket_ids: ids }),
                  });
                  const data = await res.json();
                  if (res.ok) {
                    setBulkMessage(`Merged ${data.merged_count} ticket${data.merged_count > 1 ? "s" : ""} (${data.messages_moved} messages moved)`);
                    setSelected(new Set());
                    fetchTickets();
                  } else {
                    setBulkMessage(data.error || "Merge failed");
                  }
                } catch { setBulkMessage("Merge failed"); }
                setBulkLoading(false);
              }}
              disabled={bulkLoading}
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-violet-600 shadow-sm transition-colors hover:bg-violet-50 disabled:opacity-50 dark:bg-zinc-800 dark:text-violet-400 dark:hover:bg-zinc-700"
            >
              Merge
            </button>
          )}

          {isAdmin && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={bulkLoading}
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-red-600 shadow-sm transition-colors hover:bg-red-50 disabled:opacity-50 dark:bg-zinc-800 dark:text-red-400 dark:hover:bg-zinc-700"
            >
              Delete
            </button>
          )}

          <button
            onClick={() => { setSelected(new Set()); lastClickedIndex.current = null; }}
            className="ml-auto text-sm text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className={`${selected.size > 0 ? "mt-2" : "mt-6"} overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900`}>
        <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
          <thead>
            <tr className="text-left text-sm font-medium uppercase tracking-wider text-zinc-500">
              <th className="px-3 py-3 w-10">
                <input
                  type="checkbox"
                  checked={tickets.length > 0 && selected.size === tickets.length}
                  onChange={toggleSelectAll}
                  className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-600"
                />
              </th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Channel</th>
              <th className="px-4 py-3">Assigned To</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Last Reply</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-zinc-400">Loading...</td>
              </tr>
            ) : tickets.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-zinc-400">
                  No tickets found.
                </td>
              </tr>
            ) : (
              tickets.map((t, idx) => (
                <tr
                  key={t.id}
                  className={`cursor-pointer transition-colors ${
                    selected.has(t.id)
                      ? "bg-indigo-50 dark:bg-indigo-950/30"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <td className="px-3 py-3 text-sm" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => {}}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(t.id, idx, e.shiftKey);
                      }}
                      className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-600"
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm" onClick={() => router.push(`/dashboard/tickets/${t.id}`)}>
                    <div className="flex items-center gap-1">
                      <StatusBadge status={t.status} />
                      {t.auto_reply_at && new Date(t.auto_reply_at) > new Date() && (
                        <span className="rounded bg-violet-50 px-1 py-0.5 text-sm font-medium text-violet-500 dark:bg-violet-900/30 dark:text-violet-400">
                          Auto {new Date(t.auto_reply_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        </span>
                      )}
                      {t.snoozed_until && new Date(t.snoozed_until) > new Date() && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-indigo-50 px-1 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          {new Date(t.snoozed_until).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      )}
                      {t.escalated_to && (
                        <svg className="h-3.5 w-3.5 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M3 6a3 3 0 013-3h10l-4 4 4 4H6a3 3 0 01-3-3V6z" clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                  </td>
                  <td className="max-w-xs px-4 py-3 text-sm" onClick={() => router.push(`/dashboard/tickets/${t.id}`)}>
                    <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{t.subject || "(no subject)"}</p>
                    {t.tags?.length > 0 && (
                      <div className="mt-0.5 flex gap-1">
                        {t.tags.slice(0, 3).map((tag) => {
                          const isSmart = tag.startsWith("smart:");
                          return (
                            <span key={tag} className={`rounded px-1.5 py-0.5 text-sm font-medium ${
                              isSmart
                                ? "bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400"
                                : "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400"
                            }`}>{tag}</span>
                          );
                        })}
                        {t.tags.length > 3 && <span className="text-sm text-zinc-400">+{t.tags.length - 3}</span>}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-500" onClick={() => router.push(`/dashboard/tickets/${t.id}`)}>
                    {t.customer_name || t.customer_email || "--"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm capitalize text-zinc-500" onClick={() => router.push(`/dashboard/tickets/${t.id}`)}>
                    {t.channel}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-500" onClick={() => router.push(`/dashboard/tickets/${t.id}`)}>
                    {t.assigned_name || "--"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-500" onClick={() => router.push(`/dashboard/tickets/${t.id}`)}>
                    {formatDate(t.created_at)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-zinc-500" onClick={() => router.push(`/dashboard/tickets/${t.id}`)}>
                    {t.last_customer_reply_at ? formatDate(t.last_customer_reply_at) : "--"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-zinc-500">
            Showing {offset + 1}--{Math.min(offset + PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Previous
            </button>
            <span className="flex items-center px-2 text-sm text-zinc-500">
              Page {currentPage} of {totalPages}
            </span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
