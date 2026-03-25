"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import type { Ticket, TicketMessage, TicketStatus } from "@/lib/types/ticket";
import { cleanEmailForDisplay } from "@/lib/email-utils";

interface Member {
  user_id: string;
  display_name: string | null;
  email: string | null;
}

interface OrderLineItem {
  title: string;
  quantity: number;
  price_cents: number;
  sku: string | null;
}

interface OrderFulfillment {
  trackingInfo: { number: string; url: string | null; company: string | null }[];
  status: string | null;
  createdAt: string | null;
}

interface RecentOrder {
  id: string;
  order_number: string | null;
  total_cents: number;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  source_name: string | null;
  order_type: string | null;
  line_items: OrderLineItem[];
  fulfillments: OrderFulfillment[];
  created_at: string;
}

interface CustomerDetail {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  retention_score: number;
  ltv_cents: number;
  total_orders: number;
  subscription_status: string;
  recent_orders: RecentOrder[];
}

interface TicketDetail extends Ticket {
  assigned_name: string | null;
}

const STATUS_OPTIONS: TicketStatus[] = ["open", "pending", "resolved", "closed"];

const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  resolved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  closed: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] || STATUS_COLORS.closed;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

function ChannelBadge({ channel }: { channel: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium capitalize text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
      {channel.replace("_", " ")}
    </span>
  );
}

function RetentionBadge({ score }: { score: number }) {
  let classes: string;
  if (score > 70) {
    classes = "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400";
  } else if (score >= 40) {
    classes = "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
  } else {
    classes = "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  }
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium ${classes}`}>
      {score}/100
    </span>
  );
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const workspace = useWorkspace();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Sandbox
  const [sandboxMode, setSandboxMode] = useState(false);
  const [emailLive, setEmailLive] = useState(true);

  // Composer state
  const [replyBody, setReplyBody] = useState("");
  const [replyMode, setReplyMode] = useState<"external" | "internal">("external");
  const [sending, setSending] = useState(false);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/tickets/${id}`);
      if (!res.ok) {
        setError("Ticket not found");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setTicket(data.ticket);
      setMessages(data.messages);
      setCustomer(data.customer);
      setSandboxMode(data.sandbox_mode ?? false);
      setEmailLive(data.email_live ?? true);
      setLoading(false);
    }
    load();
  }, [id]);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/members`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setMembers(data);
      })
      .catch(() => {});
  }, [workspace.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handlePatch = async (updates: Record<string, unknown>) => {
    const res = await fetch(`/api/tickets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      const updated = await res.json();
      setTicket((prev) => (prev ? { ...prev, ...updated } : prev));
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyBody.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/tickets/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: replyBody,
          visibility: replyMode,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        // Mark suppressed messages
        const msg = data.email_suppressed
          ? { ...data.message, _sandbox_suppressed: true }
          : data.message;
        setMessages((prev) => [...prev, msg]);
        setReplyBody("");
        // Refresh ticket to get updated status
        const ticketRes = await fetch(`/api/tickets/${id}`);
        if (ticketRes.ok) {
          const ticketData = await ticketRes.json();
          setTicket(ticketData.ticket);
        }
      }
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-sm text-zinc-400">{error || "Ticket not found"}</p>
        <button
          onClick={() => router.push("/dashboard/tickets")}
          className="mt-4 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Back to tickets
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
      {/* Left column - conversation */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6">
          {/* Back button */}
          <button
            onClick={() => router.push("/dashboard/tickets")}
            className="mb-4 flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Back to tickets
          </button>

          {/* Sandbox banner */}
          {sandboxMode && !emailLive && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 dark:border-amber-700 dark:bg-amber-950">
              <svg className="h-4 w-4 flex-shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <div>
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Sandbox Mode</p>
                <p className="text-[10px] text-amber-600 dark:text-amber-500">
                  Replies on this ticket will not be sent to the customer. This ticket was received via a forwarded support email. Disable sandbox mode in Settings to send real replies.
                </p>
              </div>
            </div>
          )}

          {/* Header */}
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
              {ticket.subject || "(no subject)"}
            </h1>
            <StatusBadge status={ticket.status} />
            <ChannelBadge channel={ticket.channel} />
          </div>

          {/* Messages */}
          <div className="mt-6 space-y-4">
            {messages.map((m) => {
              const isInbound = m.direction === "inbound";
              const isInternal = m.visibility === "internal";

              let bgClass: string;
              let textClass: string;
              let align: string;

              if (isInternal) {
                bgClass = "bg-amber-50 border border-amber-200 dark:bg-amber-900/20 dark:border-amber-800";
                textClass = "text-zinc-900 dark:text-zinc-100";
                align = "mr-auto";
              } else if (isInbound) {
                bgClass = "bg-zinc-100 dark:bg-zinc-800";
                textClass = "text-zinc-900 dark:text-zinc-100";
                align = "mr-auto";
              } else {
                bgClass = "bg-indigo-600 dark:bg-indigo-700";
                textClass = "text-white";
                align = "ml-auto";
              }

              return (
                <div key={m.id} className={`max-w-[85%] ${align}`}>
                  <div className={`rounded-lg px-4 py-3 ${bgClass}`}>
                    <div className={`mb-1 flex items-center gap-2 text-xs ${isInbound || isInternal ? "text-zinc-500" : "text-indigo-200"}`}>
                      {isInternal && (
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                        </svg>
                      )}
                      <span className="font-medium">
                        {isInternal && "(Internal note) "}
                        {m.author_name || m.author_type}
                      </span>
                      <span>{formatDateTime(m.created_at)}</span>
                    </div>
                    <div
                      className={`prose prose-sm max-w-none ${textClass} ${!isInbound && !isInternal ? "prose-invert" : ""}`}
                      dangerouslySetInnerHTML={{ __html: m.direction === "inbound" ? cleanEmailForDisplay(m.body) : m.body }}
                    />
                    {(m as TicketMessage & { _sandbox_suppressed?: boolean })._sandbox_suppressed && (
                      <div className="mt-1.5 flex items-center gap-1 text-[10px] text-amber-300">
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
                        </svg>
                        Sandbox — not sent to customer
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Reply composer */}
        <div className="border-t border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-2 flex gap-1">
            <button
              onClick={() => setReplyMode("external")}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                replyMode === "external"
                  ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400"
                  : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              Reply
            </button>
            <button
              onClick={() => setReplyMode("internal")}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                replyMode === "internal"
                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                  : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              Note
            </button>
          </div>
          <form onSubmit={handleSend} className="flex gap-2">
            <textarea
              rows={2}
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              placeholder={replyMode === "external" ? "Type your reply..." : "Add an internal note..."}
              className="flex-1 resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <button
              type="submit"
              disabled={sending || !replyBody.trim()}
              className="self-end rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              {sending ? "Sending..." : sandboxMode && !emailLive && replyMode === "external" ? "Send (Sandbox)" : "Send"}
            </button>
          </form>
        </div>
      </div>

      {/* Right column - details */}
      <div className="w-full shrink-0 overflow-y-auto border-t border-zinc-200 bg-zinc-50 p-6 md:w-80 md:border-l md:border-t-0 dark:border-zinc-800 dark:bg-zinc-950">
        {/* Ticket details card */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Ticket Details</h3>
          <div className="mt-3 space-y-3">
            <div>
              <label className="block text-xs text-zinc-500">Status</label>
              <select
                value={ticket.status}
                onChange={(e) => handlePatch({ status: e.target.value })}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-500">Assigned To</label>
              <select
                value={ticket.assigned_to || ""}
                onChange={(e) => handlePatch({ assigned_to: e.target.value || null })}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.display_name || m.email}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-500">Channel</label>
              <p className="mt-1 text-sm capitalize text-zinc-700 dark:text-zinc-300">{ticket.channel.replace("_", " ")}</p>
            </div>
            <div>
              <label className="block text-xs text-zinc-500">Created</label>
              <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{formatDate(ticket.created_at)}</p>
            </div>
            <div>
              <label className="block text-xs text-zinc-500">First Response</label>
              <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{formatDate(ticket.first_response_at)}</p>
            </div>
            <div>
              <label className="block text-xs text-zinc-500">Resolved</label>
              <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{formatDate(ticket.resolved_at)}</p>
            </div>
            {ticket.tags && ticket.tags.length > 0 && (
              <div>
                <label className="block text-xs text-zinc-500">Tags</label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {ticket.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Customer card */}
        {customer && (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Customer</h3>
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {[customer.first_name, customer.last_name].filter(Boolean).join(" ") || customer.email}
                </p>
                <RetentionBadge score={customer.retention_score} />
              </div>
              <p className="text-xs text-zinc-500">{customer.email}</p>
              {customer.phone && <p className="text-xs text-zinc-500">{customer.phone}</p>}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div>
                  <p className="text-xs text-zinc-400">LTV</p>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{formatCents(customer.ltv_cents)}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-400">Orders</p>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{customer.total_orders}</p>
                </div>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Subscription</p>
                <p className="text-sm capitalize text-zinc-700 dark:text-zinc-300">{customer.subscription_status}</p>
              </div>
              <button
                onClick={() => router.push(`/dashboard/customers/${customer.id}`)}
                className="mt-1 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
              >
                View full profile
              </button>

              {/* Recent orders */}
              {customer.recent_orders.length > 0 && (
                <div className="pt-2">
                  <p className="text-xs font-medium text-zinc-500">Recent Orders</p>
                  <div className="mt-1 space-y-1">
                    {customer.recent_orders.map((o) => (
                      <div key={o.id}>
                        <button
                          onClick={() => setExpandedOrderId(expandedOrderId === o.id ? null : o.id)}
                          className="flex w-full items-center justify-between rounded bg-zinc-50 px-2 py-1.5 text-xs transition-colors hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                        >
                          <div className="flex items-center gap-1.5">
                            <svg className={`h-3 w-3 text-zinc-400 transition-transform ${expandedOrderId === o.id ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                            </svg>
                            <span className="font-medium text-zinc-700 dark:text-zinc-300">#{o.order_number || "--"}</span>
                            {o.order_type === "recurring" && <span className="rounded bg-violet-100 px-1 py-0.5 text-[9px] font-medium text-violet-600 dark:bg-violet-900/30 dark:text-violet-400">Recurring</span>}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-zinc-500">{formatCents(o.total_cents)}</span>
                            <span className="text-zinc-400">{formatDate(o.created_at)}</span>
                          </div>
                        </button>
                        {expandedOrderId === o.id && (
                          <div className="mt-1 rounded border border-zinc-200 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-900">
                            <div className="flex gap-2 text-zinc-400">
                              {o.financial_status && <span className="capitalize">{o.financial_status}</span>}
                              {o.fulfillment_status && <span className="capitalize">{o.fulfillment_status}</span>}
                              {o.source_name && <span>{o.source_name}</span>}
                            </div>
                            {/* Fulfillments */}
                            {o.fulfillments?.length > 0 && (
                              <div className="mt-1.5 space-y-1">
                                {o.fulfillments.map((f, fi) => (
                                  <div key={fi}>
                                    {f.trackingInfo?.map((t, ti) => (
                                      <div key={ti} className="flex items-center gap-1">
                                        {t.company && <span className="text-zinc-400">{t.company}:</span>}
                                        {t.url ? (
                                          <a href={t.url} target="_blank" rel="noopener noreferrer" className="font-mono text-indigo-600 hover:underline dark:text-indigo-400">{t.number}</a>
                                        ) : (
                                          <span className="font-mono">{t.number}</span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            )}
                            {/* Line items */}
                            {o.line_items?.length > 0 && (
                              <div className="mt-1.5 space-y-0.5">
                                {o.line_items.map((li, idx) => (
                                  <div key={idx} className="flex justify-between">
                                    <span className="text-zinc-600 dark:text-zinc-400">{li.quantity}× {li.title}</span>
                                    <span className="text-zinc-400">{formatCents(li.price_cents * li.quantity)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
