"use client";

import { useState, useEffect, useRef } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  created_at: string;
}

const TYPE_ICONS: Record<string, string> = {
  macro_suggestion: "M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z",
  pattern_review: "M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z",
  knowledge_gap: "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25",
  fraud_alert: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z",
  system: "M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function NotificationBell() {
  const workspace = useWorkspace();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchNotifications = () => {
      fetch(`/api/workspaces/${workspace.id}/notifications`)
        .then(r => r.json())
        .then(d => {
          if (d.notifications) setNotifications(d.notifications);
          if (d.unread_count != null) setUnreadCount(d.unread_count);
        })
        .catch(() => {});
    };

    fetchNotifications();
    const interval = setInterval(fetchNotifications, 60000);
    return () => clearInterval(interval);
  }, [workspace.id]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  const markAsRead = async (id: string) => {
    await fetch(`/api/workspaces/${workspace.id}/notifications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
  };

  const markAllRead = async () => {
    await fetch(`/api/workspaces/${workspace.id}/notifications`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read_all" }),
    });
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);
  };

  const handleClick = (n: Notification) => {
    if (!n.read) markAsRead(n.id);
    setIsOpen(false);
    if (n.link) {
      const target = n.link;
      setTimeout(() => { window.location.assign(target); }, 0);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-700">
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Notifications</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-zinc-400">
                You&apos;re all caught up
              </div>
            ) : (
              // Sort fraud alerts first, then by read status and date
              [...notifications].sort((a, b) => {
                if (a.type === "fraud_alert" && b.type !== "fraud_alert") return -1;
                if (b.type === "fraud_alert" && a.type !== "fraud_alert") return 1;
                return 0;
              }).map(n => (
                <button
                  key={n.id}
                  onClick={() => handleClick(n)}
                  className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-700 ${
                    !n.read && n.type === "fraud_alert"
                      ? "bg-red-50/50 dark:bg-red-950/20"
                      : !n.read
                      ? "bg-indigo-50/50 dark:bg-indigo-950/30"
                      : ""
                  }`}
                >
                  {!n.read && n.type === "fraud_alert" && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500" />}
                  {!n.read && n.type !== "fraud_alert" && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-indigo-500" />}
                  {n.read && <span className="mt-1.5 h-2 w-2 shrink-0" />}
                  <svg className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={TYPE_ICONS[n.type] || TYPE_ICONS.system} />
                  </svg>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{n.title}</p>
                    {n.body && <p className="mt-0.5 text-xs text-zinc-500 line-clamp-2">{n.body}</p>}
                    <div className="mt-1 flex items-center gap-2">
                      <p className="text-xs text-zinc-400">{timeAgo(n.created_at)}</p>
                      {n.type === "knowledge_gap" && (
                        <span
                          className="text-xs text-purple-600 hover:underline dark:text-purple-400"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!n.read) markAsRead(n.id);
                            setIsOpen(false);
                            const query = encodeURIComponent(n.body || n.title);
                            window.location.assign(`/dashboard/knowledge-base?generate=${query}`);
                          }}
                        >
                          Generate Article
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
