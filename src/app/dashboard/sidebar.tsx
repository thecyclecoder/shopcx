"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { WorkspaceWithRole } from "@/lib/types/workspace";
import NotificationBell from "@/components/notification-bell";

interface TicketView {
  id: string;
  name: string;
  filters: Record<string, string>;
  parent_id: string | null;
  count: number | null;
}

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1" },
  { href: "/dashboard/tickets", label: "Tickets", icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" },
  { href: "/dashboard/customers", label: "Customers", icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" },
  { href: "/dashboard/subscriptions", label: "Subscriptions", icon: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" },
  { href: "/dashboard/fraud", label: "Fraud Monitor", icon: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" },
  { href: "/dashboard/chargebacks", label: "Chargebacks", icon: "M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" },
  { href: "/dashboard/reviews", label: "Reviews", icon: "M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" },
  { href: "/dashboard/knowledge-base", label: "Knowledge Base", icon: "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" },
  { href: "/dashboard/settings", label: "Settings", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
];

export default function Sidebar({
  workspace,
  user,
}: {
  workspace: WorkspaceWithRole;
  user: { id: string; email: string; name?: string };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ticketViews, setTicketViews] = useState<TicketView[]>([]);
  const [collapsedViews, setCollapsedViews] = useState<Set<string>>(new Set());
  const [ticketsExpanded, setTicketsExpanded] = useState(false);
  const [escalationCounts, setEscalationCounts] = useState<{ open: number; pending: number; closed: number }>({ open: 0, pending: 0, closed: 0 });
  const [fraudCount, setFraudCount] = useState<{ count: number; maxSeverity: string }>({ count: 0, maxSeverity: "low" });
  const [pendingReviewCount, setPendingReviewCount] = useState(0);

  // Close sidebar on route change (mobile), auto-expand tickets when on tickets page
  useEffect(() => {
    setOpen(false);
    if (pathname.startsWith("/dashboard/tickets")) setTicketsExpanded(true);
  }, [pathname]);

  // Load ticket views + counts — refetch on navigation + poll every 30s
  useEffect(() => {
    const fetchCounts = () => {
      fetch(`/api/workspaces/${workspace.id}/ticket-views`)
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) setTicketViews(d); })
        .catch(() => {});
      Promise.all([
        fetch(`/api/tickets?status=open&escalation_mine=true&limit=1`).then(r => r.json()),
        fetch(`/api/tickets?status=pending&escalation_mine=true&limit=1`).then(r => r.json()),
        fetch(`/api/tickets?status=closed&escalation_mine=true&limit=1`).then(r => r.json()),
      ]).then(([o, p, c]) => {
        setEscalationCounts({ open: o?.total || 0, pending: p?.total || 0, closed: c?.total || 0 });
      }).catch(() => {});
      // Fraud case count (admin/owner only)
      fetch(`/api/workspaces/${workspace.id}/fraud-cases?status=open&limit=1`)
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d) return;
          const count = d.total || 0;
          const cases = d.cases || [];
          const maxSeverity = cases.some((c: { severity: string }) => c.severity === "high") ? "high"
            : cases.some((c: { severity: string }) => c.severity === "medium") ? "medium" : "low";
          setFraudCount({ count, maxSeverity });
        })
        .catch(() => {});

      fetch(`/api/workspaces/${workspace.id}/reviews?status=pending&limit=1`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.stats?.pending != null) setPendingReviewCount(d.stats.pending); })
        .catch(() => {});
    };
    fetchCounts();
    const interval = setInterval(fetchCounts, 10000);
    return () => clearInterval(interval);
  }, [workspace.id, pathname]);

  // Prevent body scroll when sidebar is open on mobile
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  };

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
        <div className="flex items-center gap-2.5">
          <Image src="/logo.svg" alt="ShopCX.ai" width={28} height={28} />
          <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
            Shop<span className="text-indigo-500">CX</span>
            <span className="text-sm font-medium text-violet-400">.ai</span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          <NotificationBell />
          {/* Close button - mobile only */}
        <button
          onClick={() => setOpen(false)}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 md:hidden dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        </div>
      </div>

      {/* Workspace name */}
      <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {workspace.name}
        </p>
        <p className="text-sm capitalize text-zinc-400">
          {workspace.role.replace("_", " ")}
        </p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          const isTickets = item.href === "/dashboard/tickets";
          return (
            <div key={item.href}>
              {isTickets ? (
                <button
                  type="button"
                  onClick={() => setTicketsExpanded(prev => !prev)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                    isActive
                      ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                      : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  }`}
                >
                  <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                  </svg>
                  <span className="flex-1 text-left">{item.label}</span>
                  <span className={`text-zinc-400 transition-transform ${ticketsExpanded ? "rotate-90" : ""}`}>&#9656;</span>
                </button>
              ) : (
                <Link
                  href={item.href}
                  className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                    isActive
                      ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                      : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  }`}
                >
                  <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                  </svg>
                  <span className="flex-1">{item.label}</span>
                  {item.href === "/dashboard/reviews" && pendingReviewCount > 0 && (
                    <span className="rounded-full bg-yellow-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400">
                      {pendingReviewCount > 99 ? "99+" : pendingReviewCount}
                    </span>
                  )}
                  {item.href === "/dashboard/fraud" && fraudCount.count > 0 && (
                    <span className={`rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums ${
                      fraudCount.maxSeverity === "high"
                        ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                        : fraudCount.maxSeverity === "medium"
                        ? "bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400"
                        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500"
                    }`}>
                      {fraudCount.count > 99 ? "99+" : fraudCount.count}
                    </span>
                  )}
                </Link>
              )}
              {/* Escalations submenu */}
              {isTickets && ticketsExpanded && (() => {
                const totalEsc = escalationCounts.open + escalationCounts.pending + escalationCounts.closed;
                if (totalEsc === 0) return null;
                const escCollapsed = collapsedViews.has("__escalations");
                const escItems = [
                  { label: "Open", status: "open", count: escalationCounts.open },
                  { label: "Pending", status: "pending", count: escalationCounts.pending },
                  { label: "Closed", status: "closed", count: escalationCounts.closed },
                ].filter(e => e.count > 0);

                return (
                  <div className="ml-6 mt-1 space-y-0.5 border-l border-amber-200 pl-2 dark:border-amber-800">
                    <button
                      type="button"
                      onClick={() => {
                        setCollapsedViews(prev => {
                          const next = new Set(prev);
                          if (next.has("__escalations")) next.delete("__escalations"); else next.add("__escalations");
                          return next;
                        });
                      }}
                      className="flex w-full items-center justify-between px-2 py-1 text-sm font-medium text-amber-600 dark:text-amber-400"
                    >
                      <span>
                        <span className={`mr-1 inline-block transition-transform ${escCollapsed ? "" : "rotate-90"}`}>&#9656;</span>
                        Escalations
                      </span>
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-sm font-medium tabular-nums text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
                        {totalEsc > 99 ? "99+" : totalEsc}
                      </span>
                    </button>
                    {!escCollapsed && (
                      <div className="ml-3 space-y-0.5 border-l border-amber-200 pl-2 dark:border-amber-800">
                        {escItems.map(e => (
                          <Link
                            key={e.status}
                            href={`/dashboard/tickets?status=${e.status}&escalation_mine=true`}
                            className="flex items-center justify-between rounded px-2 py-1 text-sm text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/20"
                          >
                            <span>{e.label}</span>
                            <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-sm tabular-nums text-amber-500 dark:bg-amber-900/20">
                              {e.count > 99 ? "99+" : e.count}
                            </span>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Ticket views submenu (nested) */}
              {isTickets && ticketsExpanded && ticketViews.length > 0 && (() => {
                const topLevel = ticketViews.filter(v => !v.parent_id);
                const children = (parentId: string) => ticketViews.filter(v => v.parent_id === parentId);
                const grandChildren = (parentId: string) => ticketViews.filter(v => v.parent_id === parentId);
                const currentViewId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("view") : null;

                const toggleCollapse = (id: string) => {
                  setCollapsedViews(prev => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id); else next.add(id);
                    return next;
                  });
                };

                const ViewLink = ({ view, indent }: { view: TicketView; indent: number }) => {
                  const hasFilters = Object.keys(view.filters || {}).length > 0;
                  const viewHref = hasFilters ? `/dashboard/tickets?view=${view.id}` : "#";
                  const isViewActive = pathname === "/dashboard/tickets" && currentViewId === view.id;
                  const subs = indent === 0 ? children(view.id) : grandChildren(view.id);
                  const isFolder = subs.length > 0;
                  const isCollapsed = collapsedViews.has(view.id);
                  const countLabel = view.count != null
                    ? view.count > 99 ? "99+" : String(view.count)
                    : null;

                  return (
                    <div>
                      {hasFilters ? (
                        <div className={`flex items-center rounded text-sm transition-colors ${
                          isViewActive
                            ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                            : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                        }`}>
                          {isFolder && (
                            <button
                              type="button"
                              onClick={(e) => { e.preventDefault(); toggleCollapse(view.id); }}
                              className="shrink-0 px-1 py-1 text-zinc-400 hover:text-zinc-600"
                            >
                              <span className={`inline-block transition-transform ${isCollapsed ? "" : "rotate-90"}`}>&#9656;</span>
                            </button>
                          )}
                          <Link href={viewHref} className={`flex flex-1 items-center justify-between py-1 ${isFolder ? "pr-2" : "px-2"}`}>
                            <span>{view.name}</span>
                            {countLabel && (
                              <span className={`ml-1 rounded-full px-1.5 py-0.5 text-sm font-medium tabular-nums ${
                                isViewActive
                                  ? "bg-indigo-100 text-indigo-600 dark:bg-indigo-900 dark:text-indigo-300"
                                  : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
                              }`}>
                                {countLabel}
                              </span>
                            )}
                          </Link>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => isFolder && toggleCollapse(view.id)}
                          className="flex w-full items-center px-2 py-1 text-sm font-medium text-zinc-400 dark:text-zinc-500"
                        >
                          {isFolder && (
                            <span className={`mr-1 inline-block transition-transform ${isCollapsed ? "" : "rotate-90"}`}>&#9656;</span>
                          )}
                          {view.name}
                        </button>
                      )}
                      {isFolder && !isCollapsed && indent < 2 && (
                        <div className="ml-3 mt-0.5 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                          {subs.map(sub => <ViewLink key={sub.id} view={sub} indent={indent + 1} />)}
                        </div>
                      )}
                    </div>
                  );
                };

                return (
                  <div className="ml-6 mt-0.5 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                    {topLevel.map(view => <ViewLink key={view.id} view={view} indent={0} />)}
                  </div>
                );
              })()}
              {/* View All link — always visible when tickets expanded */}
              {isTickets && ticketsExpanded && (
                <div className="ml-6 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                  <Link
                    href="/dashboard/tickets"
                    className={`flex items-center px-2 py-1 text-sm transition-colors ${
                      pathname === "/dashboard/tickets" && !new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("view") && !new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("escalation_mine")
                        ? "font-medium text-indigo-600 dark:text-indigo-400"
                        : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                    }`}
                  >
                    View All
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* User footer */}
      <div className="border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {user.name || user.email}
            </p>
            {user.name && (
              <p className="truncate text-sm text-zinc-400">{user.email}</p>
            )}
          </div>
          <button
            onClick={handleSignOut}
            className="ml-2 rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            title="Sign out"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile header bar */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center gap-3 border-b border-zinc-200 bg-white/80 px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] backdrop-blur-md md:hidden dark:border-zinc-800 dark:bg-zinc-900/80">
        <button
          onClick={() => setOpen(true)}
          className="rounded p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
        <Image src="/logo.svg" alt="ShopCX.ai" width={24} height={24} />
        <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
          Shop<span className="text-indigo-500">CX</span>
          <span className="text-sm font-medium text-violet-400">.ai</span>
        </span>
      </div>

      {/* Desktop sidebar - always visible */}
      <aside className="hidden w-60 flex-col border-r border-zinc-200 bg-white md:flex dark:border-zinc-800 dark:bg-zinc-900">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar - overlay */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setOpen(false)}
          />
          {/* Drawer */}
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-white pt-[env(safe-area-inset-top)] md:hidden dark:bg-zinc-900">
            {sidebarContent}
          </aside>
        </>
      )}
    </>
  );
}
