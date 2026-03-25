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

interface SubscriptionItem {
  title: string | null;
  quantity: number;
  price_cents: number;
}

interface CustomerSubscription {
  id: string;
  status: string;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  last_payment_status: string | null;
  items: SubscriptionItem[];
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
  subscriptions: CustomerSubscription[];
}

interface TicketDetail extends Ticket {
  assigned_name: string | null;
}

const STATUS_OPTIONS: TicketStatus[] = ["open", "pending", "closed"];

const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
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
  const [activeTab, setActiveTab] = useState<"messages" | "history">("messages");
  const [customerEvents, setCustomerEvents] = useState<{ id: string; event_type: string; source: string; summary: string; created_at: string }[]>([]);
  const [closeWithReply, setCloseWithReply] = useState(true);
  const [editorFocused, setEditorFocused] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const [tagInput, setTagInput] = useState("");
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [suggestingPattern, setSuggestingPattern] = useState(false);
  const [suggestCategory, setSuggestCategory] = useState("");
  const [patternCategories, setPatternCategories] = useState<{ category: string; name: string }[]>([]);
  const [patternSuggestion, setPatternSuggestion] = useState<{
    category: string; category_name: string; phrases: string[]; auto_tag: string; reasoning: string;
  } | null>(null);

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

      // Auto-enrich customer if missing personalization
      if (data.customer && !data.customer.first_name) {
        fetch(`/api/customers/${data.customer.id}/enrich`, { method: "POST" })
          .then((r) => r.json())
          .then((enriched) => {
            if (enriched.enriched && enriched.customer) {
              setCustomer((prev) => prev ? { ...prev, ...enriched.customer } : prev);
            }
          })
          .catch(() => {});
      }
    }
    load();
  }, [id]);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/members`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setMembers(data); })
      .catch(() => {});
    fetch(`/api/workspaces/${workspace.id}/tags`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setTagSuggestions(data); })
      .catch(() => {});
    fetch(`/api/workspaces/${workspace.id}/patterns`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          const cats = [...new Map(data.map((p: { category: string; name: string }) => [p.category, { category: p.category, name: p.name }])).values()];
          setPatternCategories(cats);
        }
      })
      .catch(() => {});
  }, [workspace.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Fetch customer events when history tab is selected
  useEffect(() => {
    if (activeTab !== "history" || !customer?.id) return;
    if (customerEvents.length > 0) return; // already loaded
    fetch(`/api/customers/${customer.id}/events`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setCustomerEvents(data); })
      .catch(() => {});
  }, [activeTab, customer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const getEditorContent = () => {
    return editorRef.current?.innerHTML || replyBody;
  };

  const isEditorEmpty = () => {
    const text = editorRef.current?.textContent?.trim() || replyBody.trim();
    return !text;
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = getEditorContent();
    if (!body || isEditorEmpty()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/tickets/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
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
        if (editorRef.current) editorRef.current.innerHTML = "";
        setEditorFocused(false);

        // Close ticket if "close with reply" is checked and this is an external reply
        if (closeWithReply && replyMode === "external") {
          await fetch(`/api/tickets/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "closed" }),
          });
        }

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
    <div className="flex h-full flex-1 flex-col overflow-hidden md:flex-row">
      {/* Left column - conversation */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
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

          {/* Tags */}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {(ticket.tags || []).map((tag) => (
              <span key={tag} className="inline-flex items-center gap-0.5 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                {tag}
                <button
                  onClick={async () => {
                    const tags = (ticket.tags || []).filter(t => t !== tag);
                    await handlePatch({ tags });
                  }}
                  className="ml-0.5 text-indigo-400 hover:text-indigo-600"
                >x</button>
              </span>
            ))}
            <div className="relative inline-flex">
              <form onSubmit={async (e) => {
                e.preventDefault();
                const t = tagInput.trim().toLowerCase();
                if (!t) return;
                const tags = [...(ticket.tags || []), t];
                await handlePatch({ tags: [...new Set(tags)] });
                setTagInput("");
                setShowTagDropdown(false);
              }}>
                <input
                  value={tagInput}
                  onChange={(e) => { setTagInput(e.target.value); setShowTagDropdown(true); }}
                  onFocus={() => setShowTagDropdown(true)}
                  onBlur={() => setTimeout(() => setShowTagDropdown(false), 150)}
                  placeholder="+ tag"
                  className="w-20 border-none bg-transparent px-1 text-[10px] text-zinc-500 placeholder-zinc-400 outline-none focus:w-28 focus:ring-0"
                />
              </form>
              {showTagDropdown && tagInput.trim() && (() => {
                const existing = ticket.tags || [];
                const filtered = tagSuggestions.filter(t =>
                  t.toLowerCase().includes(tagInput.toLowerCase()) && !existing.includes(t)
                );
                const exactMatch = tagSuggestions.some(t => t.toLowerCase() === tagInput.trim().toLowerCase());
                if (filtered.length === 0 && exactMatch) return null;
                return (
                  <div className="absolute left-0 top-full z-10 mt-1 max-h-32 w-40 overflow-y-auto rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                    {filtered.map(tag => (
                      <button
                        key={tag}
                        type="button"
                        onMouseDown={async (e) => {
                          e.preventDefault();
                          const tags = [...existing, tag];
                          await handlePatch({ tags: [...new Set(tags)] });
                          setTagInput("");
                          setShowTagDropdown(false);
                        }}
                        className="block w-full px-2 py-1 text-left text-[10px] text-zinc-600 hover:bg-indigo-50 hover:text-indigo-600 dark:text-zinc-300 dark:hover:bg-indigo-900/30"
                      >
                        {tag}
                      </button>
                    ))}
                    {!exactMatch && tagInput.trim() && (
                      <button
                        type="button"
                        onMouseDown={async (e) => {
                          e.preventDefault();
                          const t = tagInput.trim().toLowerCase();
                          const tags = [...existing, t];
                          await handlePatch({ tags: [...new Set(tags)] });
                          setTagInput("");
                          setShowTagDropdown(false);
                        }}
                        className="block w-full border-t border-zinc-100 px-2 py-1 text-left text-[10px] font-medium text-indigo-600 hover:bg-indigo-50 dark:border-zinc-700 dark:text-indigo-400"
                      >
                        Create &ldquo;{tagInput.trim().toLowerCase()}&rdquo;
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Suggest Pattern */}
          {!patternSuggestion && (
            <div className="mt-2 flex items-center gap-2">
              {patternCategories.length > 0 && (
                <select
                  value={suggestCategory}
                  onChange={(e) => setSuggestCategory(e.target.value)}
                  className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[10px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  <option value="">Auto-detect category</option>
                  {patternCategories.map(c => (
                    <option key={c.category} value={c.category}>{c.name}</option>
                  ))}
                </select>
              )}
              <button
                onClick={async () => {
                  setSuggestingPattern(true);
                  try {
                    const res = await fetch(`/api/tickets/${id}/suggest-pattern`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(suggestCategory ? { category: suggestCategory } : {}),
                    });
                    if (res.ok) {
                      const data = await res.json();
                      setPatternSuggestion(data.suggestion);
                    }
                  } finally {
                    setSuggestingPattern(false);
                  }
                }}
                disabled={suggestingPattern}
                className="text-[10px] text-indigo-600 hover:underline disabled:opacity-50 dark:text-indigo-400"
              >
                {suggestingPattern ? "Analyzing..." : "Suggest pattern (AI)"}
              </button>
            </div>
          )}
          {patternSuggestion && (
            <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-800 dark:bg-indigo-950">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-indigo-700 dark:text-indigo-300">AI Pattern Suggestion</p>
                <button onClick={() => setPatternSuggestion(null)} className="text-[10px] text-indigo-400 hover:text-indigo-600">Dismiss</button>
              </div>
              <p className="mt-1 text-[10px] text-indigo-600 dark:text-indigo-400">{patternSuggestion.reasoning}</p>
              <div className="mt-2 space-y-1">
                <p className="text-[10px] text-zinc-500">Category: <span className="font-medium text-zinc-700 dark:text-zinc-300">{patternSuggestion.category_name}</span></p>
                <p className="text-[10px] text-zinc-500">Tag: <span className="font-medium text-zinc-700 dark:text-zinc-300">{patternSuggestion.auto_tag}</span></p>
                <div className="flex flex-wrap gap-1">
                  {patternSuggestion.phrases.map((p, i) => (
                    <span key={i} className="rounded bg-white px-1.5 py-0.5 text-[9px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">&ldquo;{p}&rdquo;</span>
                  ))}
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={async () => {
                    // Create workspace pattern with these phrases
                    const res = await fetch(`/api/workspaces/${workspace.id}/patterns`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        category: patternSuggestion.category,
                        name: patternSuggestion.category_name,
                        phrases: patternSuggestion.phrases,
                        auto_tag: patternSuggestion.auto_tag,
                        match_target: "both",
                        priority: 50,
                      }),
                    });
                    if (res.ok) {
                      // Also tag this ticket
                      if (patternSuggestion.auto_tag) {
                        const tags = [...(ticket.tags || []), patternSuggestion.auto_tag];
                        await handlePatch({ tags: [...new Set(tags)] });
                      }
                      setPatternSuggestion(null);
                    }
                  }}
                  className="rounded bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-indigo-500"
                >
                  Accept & Create Pattern
                </button>
                <button
                  onClick={async () => {
                    // Just tag this ticket, don't create pattern
                    if (patternSuggestion.auto_tag) {
                      const tags = [...(ticket.tags || []), patternSuggestion.auto_tag];
                      await handlePatch({ tags: [...new Set(tags)] });
                    }
                    setPatternSuggestion(null);
                  }}
                  className="rounded border border-indigo-300 bg-white px-2 py-0.5 text-[10px] font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-700 dark:bg-transparent dark:text-indigo-400"
                >
                  Just Tag This Ticket
                </button>
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="mt-4 flex gap-4 border-b border-zinc-200 dark:border-zinc-800">
            <button
              onClick={() => setActiveTab("messages")}
              className={`pb-2 text-sm font-medium transition-colors ${
                activeTab === "messages"
                  ? "border-b-2 border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              Messages
            </button>
            <button
              onClick={() => setActiveTab("history")}
              className={`pb-2 text-sm font-medium transition-colors ${
                activeTab === "history"
                  ? "border-b-2 border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              History
            </button>
          </div>

          {/* Messages tab */}
          {activeTab === "messages" && <div className="mt-4 space-y-4">
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
          </div>}

          {/* History tab */}
          {activeTab === "history" && (
            <div className="mt-4 space-y-2">
              {customerEvents.length === 0 ? (
                <p className="py-8 text-center text-sm text-zinc-400">No history events yet.</p>
              ) : (
                customerEvents.map((ev) => (
                  <div key={ev.id} className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
                    <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-700 dark:text-zinc-300">{ev.summary}</p>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-400">
                        <span className="capitalize">{ev.source}</span>
                        <span>{formatDateTime(ev.created_at)}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Reply composer — pinned to bottom */}
        <div className={`shrink-0 border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 ${editorFocused ? "px-3 py-3" : "px-3 py-2"}`}>
          <form onSubmit={handleSend}>
            {/* Mode toggle row */}
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setReplyMode("external")}
                  className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    replyMode === "external"
                      ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400"
                      : "text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  Reply
                </button>
                <button
                  type="button"
                  onClick={() => setReplyMode("internal")}
                  className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    replyMode === "internal"
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                      : "text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  Note
                </button>
              </div>
              {!editorFocused && (
                <button
                  type="submit"
                  disabled={sending}
                  className="shrink-0 rounded-md bg-indigo-600 px-3 py-1 text-[10px] font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                >
                  {sending ? "..." : closeWithReply && replyMode === "external" ? "Send & Close" : "Send"}
                </button>
              )}
            </div>

            {/* Formatting toolbar — only when expanded */}
            {editorFocused && (
              <div className="mb-1.5 flex items-center gap-0.5 border-b border-zinc-200 pb-1.5 dark:border-zinc-700">
                {[
                  { cmd: "bold", icon: "B", cls: "font-bold" },
                  { cmd: "italic", icon: "I", cls: "italic" },
                  { cmd: "underline", icon: "U", cls: "underline" },
                ].map(({ cmd, icon, cls }) => (
                  <button
                    key={cmd}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); document.execCommand(cmd); }}
                    className={`rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${cls}`}
                  >
                    {icon}
                  </button>
                ))}
                <div className="mx-1 h-3 w-px bg-zinc-200 dark:bg-zinc-700" />
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertUnorderedList"); }}
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  title="Bullet list"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                  </svg>
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertOrderedList"); }}
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  title="Numbered list"
                >
                  1.
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const url = prompt("Enter URL:");
                    if (url) document.execCommand("createLink", false, url);
                  }}
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  title="Insert link"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                </button>
              </div>
            )}

            {/* Editor */}
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onFocus={() => setEditorFocused(true)}
              onInput={() => setReplyBody(editorRef.current?.textContent || "")}
              data-placeholder={replyMode === "external" ? "Type your reply..." : "Internal note..."}
              className={`w-full rounded-md border border-zinc-300 bg-white text-sm text-zinc-900 placeholder-zinc-400 outline-none transition-all focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 ${
                editorFocused ? "min-h-[120px] px-3 py-2" : "min-h-[32px] px-2.5 py-1.5"
              } empty:before:pointer-events-none empty:before:text-zinc-400 empty:before:content-[attr(data-placeholder)]`}
            />

            {/* Bottom row — only when expanded */}
            {editorFocused && (
              <div className="mt-1.5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {replyMode === "external" && (
                    <label className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                      <input
                        type="checkbox"
                        checked={closeWithReply}
                        onChange={(e) => setCloseWithReply(e.target.checked)}
                        className="h-3 w-3 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      Close with reply
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => { setEditorFocused(false); if (editorRef.current && !editorRef.current.textContent?.trim()) editorRef.current.innerHTML = ""; }}
                    className="text-[10px] text-zinc-400 hover:text-zinc-600"
                  >
                    Collapse
                  </button>
                </div>
                <button
                  type="submit"
                  disabled={sending || isEditorEmpty()}
                  className="rounded-md bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                >
                  {sending ? "Sending..." : sandboxMode && !emailLive && replyMode === "external" ? "Send (Sandbox)" : closeWithReply && replyMode === "external" ? "Send & Close" : "Send"}
                </button>
              </div>
            )}
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
              <div>
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {[customer.first_name, customer.last_name].filter(Boolean).join(" ") || customer.email}
                </p>
                <div className="mt-1">
                  <RetentionBadge score={customer.retention_score} />
                </div>
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

              {/* Subscriptions */}
              {customer.subscriptions?.length > 0 && (
                <div className="pt-2">
                  <p className="text-xs font-medium text-zinc-500">Subscriptions</p>
                  <div className="mt-1 space-y-1">
                    {customer.subscriptions.map((sub) => (
                      <div key={sub.id} className="rounded bg-zinc-50 px-2 py-1.5 text-xs dark:bg-zinc-800">
                        <div className="flex items-center justify-between">
                          <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${
                            sub.status === "active" ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                            : sub.status === "paused" ? "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
                            : "bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400"
                          }`}>
                            {sub.status}
                          </span>
                          {sub.billing_interval && (
                            <span className="text-[10px] text-zinc-400">
                              {sub.billing_interval_count}/{sub.billing_interval}
                            </span>
                          )}
                        </div>
                        {sub.items?.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {sub.items.slice(0, 3).map((item, idx) => (
                              <p key={idx} className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                                {item.quantity}x {item.title}
                              </p>
                            ))}
                            {sub.items.length > 3 && (
                              <p className="text-[10px] text-zinc-400">+{sub.items.length - 3} more</p>
                            )}
                          </div>
                        )}
                        {sub.next_billing_date && (
                          <p className="mt-1 text-[10px] text-zinc-400">Next: {formatDate(sub.next_billing_date)}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

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
                          </div>
                          <span className="text-zinc-500">{formatCents(o.total_cents)}</span>
                        </button>
                        {expandedOrderId === o.id && (
                          <div className="mt-1 rounded border border-zinc-200 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-900">
                            <div className="flex flex-wrap gap-1">
                              {o.order_type && (
                                <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${
                                  o.order_type === "recurring" ? "bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400"
                                  : o.order_type === "replacement" ? "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400"
                                  : o.order_type === "checkout" ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                                }`}>
                                  {o.order_type === "recurring" ? "Recurring" : o.order_type === "replacement" ? "Replacement" : o.order_type === "checkout" ? "Checkout" : o.order_type}
                                </span>
                              )}
                              {o.financial_status && (
                                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium capitalize text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{o.financial_status}</span>
                              )}
                              {o.fulfillment_status && (
                                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium capitalize text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{o.fulfillment_status}</span>
                              )}
                            </div>
                            <p className="mt-1 text-[10px] text-zinc-400">{formatDate(o.created_at)}</p>
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
