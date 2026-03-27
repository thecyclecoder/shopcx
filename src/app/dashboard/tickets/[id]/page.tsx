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

interface LinkedIdentity {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  is_primary: boolean;
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
  linked_identities: LinkedIdentity[];
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
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-sm font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  chat: "Live Chat",
  help_center: "Help Center",
  social_comments: "Social Comments",
  meta_dm: "Social DMs",
  sms: "SMS",
};

function ChannelBadge({ channel }: { channel: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-sm font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
      {CHANNEL_LABELS[channel] || channel.replace(/_/g, " ")}
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
  const [mobileSection, setMobileSection] = useState<"conversation" | "details" | "customer" | "actions">("conversation");
  const [customerEvents, setCustomerEvents] = useState<{ id: string; event_type: string; source: string; summary: string; created_at: string }[]>([]);
  const [closeWithReply, setCloseWithReply] = useState(true);
  const [editorFocused, setEditorFocused] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const [tagInput, setTagInput] = useState("");
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [suggestingPattern, setSuggestingPattern] = useState(false);
  const [availableWorkflows, setAvailableWorkflows] = useState<{ id: string; name: string; template: string; trigger_tag: string }[]>([]);
  const [runningWorkflow, setRunningWorkflow] = useState(false);
  const [suggestCategory, setSuggestCategory] = useState("");
  const [patternCategories, setPatternCategories] = useState<{ category: string; name: string }[]>([]);
  const [patternSuggestion, setPatternSuggestion] = useState<{
    category: string; category_name: string; phrases: string[]; auto_tag: string; reasoning: string;
  } | null>(null);
  const [removingSmartTag, setRemovingSmartTag] = useState<string | null>(null);
  const [feedbackReason, setFeedbackReason] = useState("");
  const [linkSuggestions, setLinkSuggestions] = useState<{ id: string; email: string; first_name: string | null; last_name: string | null; phone: string | null; match_reason: string }[]>([]);
  const [showLinkSection, setShowLinkSection] = useState(false);
  const [aiDraft, setAiDraft] = useState<{ ai_draft: string | null; ai_confidence: number | null; ai_tier: string | null; ai_source_type: string | null; source_name: string | null; ai_drafted_at: string | null; ai_suggested_macro_id: string | null; ai_suggested_macro_name: string | null } | null>(null);
  const [generatingDraft, setGeneratingDraft] = useState(false);
  const [macroSearch, setMacroSearch] = useState("");
  const [macroResults, setMacroResults] = useState<{ id: string; name: string; body_text: string; category: string | null; usage_count: number }[]>([]);
  const [popularMacros, setPopularMacros] = useState<{ id: string; name: string; body_text: string; category: string | null; usage_count: number }[]>([]);
  const [showMacroPanel, setShowMacroPanel] = useState(false);
  const [applyingMacro, setApplyingMacro] = useState<string | null>(null);
  const [allMacros, setAllMacros] = useState<{ id: string; name: string; body_text: string; category: string | null; usage_count: number }[]>([]);

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

      // Load link suggestions for customer
      if (data.customer) {
        fetch(`/api/customers/${data.customer.id}/suggestions`)
          .then((r) => r.json())
          .then((s) => setLinkSuggestions(s.suggestions || []))
          .catch(() => {});
      }

      // Load existing AI draft
      fetch(`/api/tickets/${id}/ai-draft`)
        .then((r) => r.json())
        .then((d) => { if (d.ai_draft || d.ai_suggested_macro_id) setAiDraft(d); })
        .catch(() => {});

      // Load macros for search + popular
      fetch(`/api/workspaces/${workspace.id}/macros`)
        .then((r) => r.json())
        .then((m) => { if (Array.isArray(m)) setAllMacros(m); })
        .catch(() => {});
      fetch(`/api/workspaces/${workspace.id}/macros/popular`)
        .then((r) => r.json())
        .then((m) => { if (Array.isArray(m)) setPopularMacros(m); })
        .catch(() => {});
    }
    load();
  }, [id]);

  // Poll for new messages + ticket updates every 10s
  useEffect(() => {
    if (loading) return;
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/tickets/${id}`);
        if (!res.ok) return;
        const data = await res.json();
        setTicket(data.ticket);
        // Only update messages if count changed (avoid scroll jumps)
        if (data.messages?.length !== messages.length) {
          setMessages(data.messages);
        }
        if (data.customer) setCustomer(data.customer);
      } catch {}
    }, 10000);
    return () => clearInterval(poll);
  }, [id, loading, messages.length]);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/members`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setMembers(data); })
      .catch(() => {});
    fetch(`/api/workspaces/${workspace.id}/tags`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setTagSuggestions(data); })
      .catch(() => {});
    fetch(`/api/workspaces/${workspace.id}/workflows`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setAvailableWorkflows(data.filter((w: { enabled: boolean }) => w.enabled)); })
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

  // Macro search (client-side filter)
  useEffect(() => {
    if (!macroSearch.trim()) {
      setMacroResults([]);
      return;
    }
    const q = macroSearch.toLowerCase();
    const filtered = allMacros.filter((m) =>
      m.name.toLowerCase().includes(q) || (m.body_text || "").toLowerCase().includes(q)
    ).slice(0, 10);
    setMacroResults(filtered);
  }, [macroSearch, allMacros]);

  // Apply macro: AI personalizes it and puts text in composer
  const handleApplyMacro = async (macroId: string) => {
    setApplyingMacro(macroId);
    try {
      const res = await fetch(`/api/tickets/${id}/apply-macro`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ macro_id: macroId }),
      });
      const data = await res.json();
      if (data.personalized) {
        setReplyBody(data.personalized);
        setEditorFocused(true);
        setShowMacroPanel(false);
        setMacroSearch("");
        // Log macro usage
        const isAISuggested = aiDraft?.ai_suggested_macro_id === macroId;
        fetch(`/api/workspaces/${workspace.id}/macro-usage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ macro_id: macroId, ticket_id: id, source: isAISuggested ? "ai_suggested" : "manual", outcome: "personalized" }),
        }).catch(() => {});
      }
    } catch {}
    setApplyingMacro(null);
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
    <div className="flex h-full flex-1 flex-col overflow-x-hidden overflow-y-hidden md:flex-row">
      {/* Mobile section selector */}
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2 md:hidden dark:border-zinc-800 dark:bg-zinc-900">
        <button onClick={() => router.push("/dashboard/tickets")} className="text-zinc-400">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
        </button>
        <select
          value={mobileSection}
          onChange={(e) => setMobileSection(e.target.value as typeof mobileSection)}
          className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm font-medium text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        >
          <option value="conversation">Conversation</option>
          <option value="details">Ticket Details</option>
          <option value="customer">Customer</option>
          <option value="actions">Actions</option>
        </select>
      </div>

      {/* Left column - conversation */}
      <div className={`flex min-h-0 flex-1 flex-col ${mobileSection !== "conversation" ? "hidden md:flex" : ""}`}>
        <div className="min-h-0 flex-1 overflow-y-auto p-6 pb-0 scrollbar-hidden md:pb-6" style={{ WebkitOverflowScrolling: "touch" }}>
          {/* Back button — desktop only */}
          <button
            onClick={() => router.push("/dashboard/tickets")}
            className="mb-4 hidden items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-700 md:flex dark:hover:text-zinc-300"
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
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Sandbox Mode</p>
                <p className="text-sm text-amber-600 dark:text-amber-500">
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
            {ticket.auto_reply_at && new Date(ticket.auto_reply_at) > new Date() && (
              <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-sm font-medium text-violet-600 dark:bg-violet-900/30 dark:text-violet-400">
                <svg className="h-3 w-3 animate-pulse" fill="currentColor" viewBox="0 0 20 20"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.828a1 1 0 101.415-1.414L11 9.586V6z" /></svg>
                Auto-reply at {new Date(ticket.auto_reply_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                <button
                  onClick={async () => {
                    await handlePatch({ auto_reply_at: null });
                  }}
                  className="ml-1 text-violet-400 hover:text-violet-700"
                >Cancel</button>
              </span>
            )}
          </div>

          {/* Tags */}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {(ticket.tags || []).map((tag) => {
              const isSmart = tag.startsWith("smart:");
              const displayTag = tag;
              return (
                <span key={tag} className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-sm font-medium ${
                  isSmart
                    ? "bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400"
                    : "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400"
                }`}>
                  {isSmart && <svg className="mr-0.5 h-2.5 w-2.5" fill="currentColor" viewBox="0 0 20 20"><path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" /></svg>}
                  {displayTag}
                  <button
                    onClick={async () => {
                      if (isSmart) {
                        setRemovingSmartTag(tag);
                        setFeedbackReason("");
                        return;
                      }
                      const tags = (ticket.tags || []).filter(t => t !== tag);
                      await handlePatch({ tags });
                    }}
                    className={`ml-0.5 ${isSmart ? "text-violet-400 hover:text-violet-600" : "text-indigo-400 hover:text-indigo-600"}`}
                  >x</button>
                </span>
              );
            })}
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
                  onBlur={() => setTimeout(() => setShowTagDropdown(false), 200)}
                  placeholder="+ add tag"
                  className="w-24 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm text-zinc-500 placeholder-zinc-400 outline-none focus:w-32 focus:border-zinc-300 focus:bg-white focus:ring-0 dark:focus:border-zinc-600 dark:focus:bg-zinc-800"
                />
              </form>
              {showTagDropdown && (() => {
                const existing = ticket.tags || [];
                const filtered = tagSuggestions.filter(t =>
                  (!tagInput.trim() || t.toLowerCase().includes(tagInput.toLowerCase())) && !existing.includes(t)
                );
                const exactMatch = tagInput.trim() && tagSuggestions.some(t => t.toLowerCase() === tagInput.trim().toLowerCase());
                if (filtered.length === 0 && !tagInput.trim()) return null;
                if (filtered.length === 0 && exactMatch) return null;
                return (
                  <div className="absolute left-0 top-full z-20 mt-1 max-h-40 w-48 overflow-y-auto rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                    {filtered.slice(0, 10).map(tag => (
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
                        className="block w-full px-2.5 py-1.5 text-left text-sm text-zinc-600 hover:bg-indigo-50 hover:text-indigo-600 dark:text-zinc-300 dark:hover:bg-indigo-900/30"
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
                        className="block w-full border-t border-zinc-100 px-2.5 py-1.5 text-left text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:border-zinc-700 dark:text-indigo-400"
                      >
                        Create &ldquo;{tagInput.trim().toLowerCase()}&rdquo;
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Smart tag removal feedback */}
          {removingSmartTag && (
            <div className="mt-2 rounded-md border border-violet-200 bg-violet-50 p-3 dark:border-violet-800 dark:bg-violet-950">
              <p className="text-sm font-medium text-violet-700 dark:text-violet-300">
                Why are you removing &ldquo;{removingSmartTag}&rdquo;?
              </p>
              <textarea
                rows={2}
                value={feedbackReason}
                onChange={(e) => setFeedbackReason(e.target.value)}
                placeholder="e.g. This ticket is about a refund, not tracking..."
                className="mt-1.5 w-full rounded-md border border-violet-300 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-violet-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              <div className="mt-2 flex gap-2">
                <button
                  onClick={async () => {
                    // Submit feedback + remove tag
                    await fetch(`/api/tickets/${id}/tag-feedback`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ tag: removingSmartTag, reason: feedbackReason }),
                    });
                    const tags = (ticket.tags || []).filter(t => t !== removingSmartTag);
                    await handlePatch({ tags });
                    setRemovingSmartTag(null);
                    setFeedbackReason("");
                  }}
                  className="rounded bg-violet-600 px-2 py-0.5 text-sm font-medium text-white hover:bg-violet-500"
                >
                  Submit & Remove
                </button>
                <button
                  onClick={async () => {
                    // Remove without feedback
                    const tags = (ticket.tags || []).filter(t => t !== removingSmartTag);
                    await handlePatch({ tags });
                    setRemovingSmartTag(null);
                  }}
                  className="text-sm text-zinc-500 hover:text-zinc-700"
                >
                  Skip & Remove
                </button>
                <button
                  onClick={() => setRemovingSmartTag(null)}
                  className="text-sm text-zinc-400"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Actions moved to sidebar */}

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
                    <div className={`mb-1 flex items-center gap-2 text-sm ${isInbound || isInternal ? "text-zinc-500" : "text-indigo-200"}`}>
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
                      className={`prose prose-sm max-w-none break-words overflow-hidden [overflow-wrap:anywhere] ${textClass} ${!isInbound && !isInternal ? "prose-invert" : ""}`}
                      dangerouslySetInnerHTML={{ __html: m.body }}
                    />
                    {(m as TicketMessage & { _sandbox_suppressed?: boolean })._sandbox_suppressed && (
                      <div className="mt-1.5 flex items-center gap-1 text-sm text-amber-300">
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
            {/* Pending auto-reply preview — cyan for AI, purple for workflows */}
            {ticket.pending_auto_reply && ticket.auto_reply_at && new Date(ticket.auto_reply_at) > new Date() && (() => {
              const isAI = !!ticket.ai_draft;
              const bgColor = isAI ? "bg-cyan-100 dark:bg-cyan-900/30" : "bg-violet-100 dark:bg-violet-900/30";
              const ringColor = isAI ? "ring-cyan-300 dark:ring-cyan-700" : "ring-violet-300 dark:ring-violet-700";
              const textColor = isAI ? "text-cyan-500" : "text-violet-500";
              const bodyColor = isAI ? "text-cyan-700 dark:text-cyan-300" : "text-violet-700 dark:text-violet-300";
              const label = isAI ? "AI reply" : "Scheduled reply";
              return (
                <div className="max-w-[85%] ml-auto opacity-60">
                  <div className={`rounded-lg px-4 py-3 ring-1 ${bgColor} ${ringColor}`}>
                    <div className={`mb-1 flex items-center gap-2 text-sm ${textColor}`}>
                      <svg className="h-3 w-3 animate-pulse" fill="currentColor" viewBox="0 0 20 20"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.828a1 1 0 101.415-1.414L11 9.586V6z" /></svg>
                      <span>{label} — {new Date(ticket.auto_reply_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
                      {isAI && ticket.ai_confidence != null && (
                        <span className="rounded-full bg-white/50 px-1.5 py-0.5 text-sm font-medium">{Math.round(ticket.ai_confidence * 100)}%</span>
                      )}
                    </div>
                    <div className={`prose prose-sm max-w-none ${bodyColor}`} dangerouslySetInnerHTML={{ __html: ticket.pending_auto_reply }} />
                  </div>
                </div>
              );
            })()}
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
                      <div className="mt-0.5 flex items-center gap-2 text-sm text-zinc-400">
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

        {/* AI Draft Card */}
        {aiDraft?.ai_draft && aiDraft.ai_tier !== "auto" && (
          <div className="shrink-0 border-t border-cyan-200 bg-cyan-50 px-4 py-3 dark:border-cyan-800 dark:bg-cyan-950">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 text-cyan-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
                <span className="text-sm font-medium text-cyan-700 dark:text-cyan-300">AI Draft</span>
                <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${
                  (aiDraft.ai_confidence || 0) >= 0.8
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                    : (aiDraft.ai_confidence || 0) >= 0.6
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                }`}>
                  {Math.round((aiDraft.ai_confidence || 0) * 100)}%
                </span>
                {aiDraft.ai_source_type && (
                  <span className="text-sm text-cyan-500">
                    via {aiDraft.ai_source_type === "macro" ? "Macro" : "KB"}{aiDraft.source_name ? `: ${aiDraft.source_name}` : ""}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setReplyBody(aiDraft.ai_draft || "");
                    setEditorFocused(true);
                    // Log macro usage: accepted
                    if (aiDraft.ai_suggested_macro_id) {
                      fetch(`/api/workspaces/${workspace.id}/macro-usage`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ macro_id: aiDraft.ai_suggested_macro_id, ticket_id: id, source: "ai_suggested", outcome: "applied", ai_confidence: aiDraft.ai_confidence }),
                      }).catch(() => {});
                    }
                  }}
                  className="rounded-md bg-cyan-600 px-3 py-1 text-sm font-medium text-white hover:bg-cyan-500"
                >
                  Use Draft
                </button>
                <button
                  onClick={() => {
                    // Log macro usage: rejected
                    if (aiDraft.ai_suggested_macro_id) {
                      fetch(`/api/workspaces/${workspace.id}/macro-usage`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ macro_id: aiDraft.ai_suggested_macro_id, ticket_id: id, source: "ai_suggested", outcome: "rejected", ai_confidence: aiDraft.ai_confidence }),
                      }).catch(() => {});
                    }
                    setAiDraft(null);
                  }}
                  className="text-sm text-cyan-400 hover:text-cyan-600 dark:hover:text-cyan-300"
                >
                  Dismiss
                </button>
              </div>
            </div>
            <div className="mt-2 rounded-md bg-white p-3 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              {aiDraft.ai_draft}
            </div>
          </div>
        )}

        {/* AI Suggested Macro (when confidence is below threshold but AI found a match) */}
        {aiDraft?.ai_suggested_macro_id && !aiDraft?.ai_draft && (
          <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-4 py-2.5 dark:border-amber-800 dark:bg-amber-950">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm text-amber-700 dark:text-amber-300">AI suggests macro:</span>
                <span className="text-sm font-medium text-amber-900 dark:text-amber-100">{aiDraft.ai_suggested_macro_name}</span>
              </div>
              <button
                onClick={() => handleApplyMacro(aiDraft.ai_suggested_macro_id!)}
                disabled={!!applyingMacro}
                className="rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {applyingMacro === aiDraft.ai_suggested_macro_id ? "Personalizing..." : "Apply & Personalize"}
              </button>
            </div>
          </div>
        )}

        {/* AI + Macro toolbar */}
        {ticket.status !== "closed" && (
          <div className="shrink-0 flex items-center gap-2 border-t border-zinc-100 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
            {!aiDraft?.ai_draft && (
              <button
                onClick={async () => {
                  setGeneratingDraft(true);
                  try {
                    const res = await fetch(`/api/tickets/${id}/ai-draft`, { method: "POST" });
                    const data = await res.json();
                    if (data.draft || data.source_id) {
                      setAiDraft({
                        ai_draft: data.draft || null,
                        ai_confidence: data.confidence,
                        ai_tier: data.tier,
                        ai_source_type: data.source_type,
                        source_name: null,
                        ai_drafted_at: new Date().toISOString(),
                        ai_suggested_macro_id: data.source_type === "macro" ? data.source_id : null,
                        ai_suggested_macro_name: null,
                      });
                    }
                  } catch {}
                  setGeneratingDraft(false);
                }}
                disabled={generatingDraft}
                className="flex items-center gap-1.5 rounded-md border border-cyan-300 px-3 py-1.5 text-sm font-medium text-cyan-600 hover:bg-cyan-50 disabled:opacity-50 dark:border-cyan-700 dark:text-cyan-400 dark:hover:bg-cyan-950"
              >
                <svg className={`h-4 w-4 ${generatingDraft ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
                {generatingDraft ? "Generating..." : "AI Draft"}
              </button>
            )}
            <button
              onClick={() => setShowMacroPanel(!showMacroPanel)}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium ${
                showMacroPanel
                  ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-600 dark:bg-indigo-950 dark:text-indigo-300"
                  : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              Macros
            </button>
          </div>
        )}

        {/* Macro search panel */}
        {showMacroPanel && (
          <div className="shrink-0 border-t border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
            <input
              type="text"
              value={macroSearch}
              onChange={(e) => setMacroSearch(e.target.value)}
              placeholder="Search macros..."
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              autoFocus
            />
            <div className="mt-2 max-h-48 overflow-y-auto">
              {/* Show search results or popular macros */}
              {(macroSearch.trim() ? macroResults : popularMacros).length === 0 && (
                <p className="py-2 text-sm text-zinc-400">{macroSearch.trim() ? "No macros found" : "No macros available"}</p>
              )}
              {(macroSearch.trim() ? macroResults : popularMacros).map((m) => (
                <button
                  key={m.id}
                  onClick={() => handleApplyMacro(m.id)}
                  disabled={!!applyingMacro}
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:hover:bg-zinc-800"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{m.name}</span>
                      {m.usage_count > 0 && (
                        <span className="text-sm text-zinc-400">{m.usage_count}x</span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-zinc-500">{m.body_text.slice(0, 80)}...</p>
                  </div>
                  <span className="ml-2 shrink-0 text-sm text-indigo-500">
                    {applyingMacro === m.id ? "..." : "Apply"}
                  </span>
                </button>
              ))}
              {!macroSearch.trim() && popularMacros.length > 0 && (
                <p className="mt-1 text-sm text-zinc-400">Showing most-used macros. Type to search all {allMacros.length}.</p>
              )}
            </div>
          </div>
        )}

        {/* Reply composer — pinned to bottom */}
        <div className={`shrink-0 border-t border-zinc-200 bg-white pb-4 dark:border-zinc-800 dark:bg-zinc-900 ${editorFocused ? "px-3 pt-3" : "px-3 pt-2"}`}>
          <form onSubmit={handleSend}>
            {/* Mode toggle row */}
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setReplyMode("external")}
                  className={`rounded px-2 py-0.5 text-sm font-medium transition-colors ${
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
                  className={`rounded px-2 py-0.5 text-sm font-medium transition-colors ${
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
                  className="shrink-0 rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
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
                    className={`rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${cls}`}
                  >
                    {icon}
                  </button>
                ))}
                <div className="mx-1 h-3 w-px bg-zinc-200 dark:bg-zinc-700" />
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertUnorderedList"); }}
                  className="rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  title="Bullet list"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                  </svg>
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertOrderedList"); }}
                  className="rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
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
                  className="rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
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
                    <label className="flex items-center gap-1.5 text-sm text-zinc-500">
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
                    className="text-sm text-zinc-400 hover:text-zinc-600"
                  >
                    Collapse
                  </button>
                </div>
                <button
                  type="submit"
                  disabled={sending || isEditorEmpty()}
                  className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                >
                  {sending ? "Sending..." : sandboxMode && !emailLive && replyMode === "external" ? "Send (Sandbox)" : closeWithReply && replyMode === "external" ? "Send & Close" : "Send"}
                </button>
              </div>
            )}
          </form>
        </div>
      </div>

      {/* Right column - details */}
      <div className={`w-full shrink-0 overflow-y-auto border-t border-zinc-200 bg-zinc-50 p-6 md:w-80 md:border-l md:border-t-0 dark:border-zinc-800 dark:bg-zinc-950 ${mobileSection === "conversation" ? "hidden md:block" : ""}`}>
        {/* Actions card */}
        <div className={`${mobileSection !== "actions" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        {(availableWorkflows.length > 0 || (!(ticket.tags || []).some(t => t.startsWith("smart:")) && !patternSuggestion)) && (
          <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950">
            <h3 className="text-xs font-medium uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Actions</h3>
            <div className="mt-3 space-y-3">
              {/* Run workflow */}
              {availableWorkflows.length > 0 && (
                <div>
                  <label className="block text-xs text-indigo-500">Run Workflow</label>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      id="workflow-select"
                      defaultValue=""
                      className="min-w-0 flex-1 truncate rounded border border-indigo-300 bg-white px-2 py-1 text-xs dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      <option value="" disabled>Select workflow...</option>
                      {availableWorkflows.map(wf => (
                        <option key={wf.id} value={wf.id}>{wf.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={async () => {
                        const select = document.getElementById("workflow-select") as HTMLSelectElement;
                        const wfId = select?.value;
                        if (!wfId) return;
                        setRunningWorkflow(true);
                        try {
                          const res = await fetch(`/api/tickets/${id}/run-workflow`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ workflow_id: wfId }),
                          });
                          if (res.ok) {
                            const ticketRes = await fetch(`/api/tickets/${id}`);
                            if (ticketRes.ok) {
                              const data = await ticketRes.json();
                              setTicket(data.ticket);
                              setMessages(data.messages);
                            }
                          }
                        } finally {
                          setRunningWorkflow(false);
                        }
                      }}
                      disabled={runningWorkflow}
                      className="shrink-0 rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {runningWorkflow ? "..." : "Run"}
                    </button>
                  </div>
                </div>
              )}

              {/* Suggest pattern */}
              {!patternSuggestion && !(ticket.tags || []).some(t => t.startsWith("smart:")) && (
                <div>
                  <label className="block text-xs text-indigo-500">Suggest Pattern (AI)</label>
                  <div className="mt-1 flex items-center gap-2">
                    {patternCategories.length > 0 && (
                      <select
                        value={suggestCategory}
                        onChange={(e) => setSuggestCategory(e.target.value)}
                        className="min-w-0 flex-1 truncate rounded border border-indigo-300 bg-white px-2 py-1 text-xs dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100"
                      >
                        <option value="">Auto-detect</option>
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
                      className="shrink-0 rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {suggestingPattern ? "..." : "Analyze"}
                    </button>
                  </div>
                </div>
              )}

              {/* Pattern suggestion result */}
              {patternSuggestion && (
                <div className="rounded-md border border-indigo-300 bg-white p-2.5 dark:border-indigo-700 dark:bg-zinc-800">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-indigo-700 dark:text-indigo-300">AI Suggestion</p>
                    <button onClick={() => setPatternSuggestion(null)} className="text-xs text-indigo-400 hover:text-indigo-600">x</button>
                  </div>
                  <p className="mt-1 text-xs text-indigo-600 dark:text-indigo-400">{patternSuggestion.reasoning}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {patternSuggestion.phrases.map((p, i) => (
                      <span key={i} className="rounded bg-zinc-100 px-1 py-0.5 text-[9px] dark:bg-zinc-700">&ldquo;{p}&rdquo;</span>
                    ))}
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    <button
                      onClick={async () => {
                        await fetch(`/api/workspaces/${workspace.id}/patterns`, {
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
                        if (patternSuggestion.auto_tag) {
                          const tags = [...(ticket.tags || []), patternSuggestion.auto_tag];
                          await handlePatch({ tags: [...new Set(tags)] });
                        }
                        setPatternSuggestion(null);
                      }}
                      className="rounded bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-indigo-500"
                    >
                      Accept
                    </button>
                    <button
                      onClick={async () => {
                        if (patternSuggestion.auto_tag) {
                          const tags = [...(ticket.tags || []), patternSuggestion.auto_tag];
                          await handlePatch({ tags: [...new Set(tags)] });
                        }
                        setPatternSuggestion(null);
                      }}
                      className="rounded border border-indigo-300 px-2 py-0.5 text-[10px] text-indigo-600 dark:border-indigo-700 dark:text-indigo-400"
                    >
                      Just Tag
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Delete ticket — owner/admin only */}
        {["owner", "admin"].includes(workspace.role) && (
          <div className="mb-4">
            <button
              onClick={async () => {
                if (!confirm("Delete this ticket and all its messages? This cannot be undone.")) return;
                const res = await fetch(`/api/tickets/${id}`, { method: "DELETE" });
                if (res.ok) router.push("/dashboard/tickets");
              }}
              className="text-xs text-red-500 hover:underline"
            >
              Delete ticket
            </button>
          </div>
        )}
        </div>

        {/* Ticket details card */}
        <div className={`${mobileSection !== "details" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-sm font-medium uppercase tracking-wider text-zinc-500">Ticket Details</h3>
          <div className="mt-3 space-y-3">
            <div>
              <label className="block text-sm text-zinc-500">Status</label>
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
              <label className="block text-sm text-zinc-500">Assigned To</label>
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
            {/* Escalation */}
            <div>
              <label className="flex items-center gap-1.5 text-sm text-zinc-500">
                {ticket.escalated_to && (
                  <svg className="h-3 w-3 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M3 6a3 3 0 013-3h10l-4 4 4 4H6a3 3 0 01-3-3V6z" clipRule="evenodd" />
                  </svg>
                )}
                Escalated To
              </label>
              <select
                value={ticket.escalated_to || ""}
                onChange={(e) => {
                  if (e.target.value && !ticket.escalated_to) {
                    const reason = prompt("Escalation reason (optional):");
                    handlePatch({ escalated_to: e.target.value, escalation_reason: reason || null });
                  } else {
                    handlePatch({ escalated_to: e.target.value || null, escalation_reason: null });
                  }
                }}
                className={`mt-1 w-full rounded-md border px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                  ticket.escalated_to
                    ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300"
                    : "border-zinc-300 bg-white text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                }`}
              >
                <option value="">Not escalated</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.display_name || m.email}</option>
                ))}
              </select>
              {ticket.escalated_to && ticket.escalation_reason && (
                <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">Reason: {ticket.escalation_reason}</p>
              )}
              {ticket.escalated_to && ticket.escalated_at && (
                <p className="mt-0.5 text-sm text-zinc-400">Escalated {formatDate(ticket.escalated_at)}</p>
              )}
            </div>
            <div>
              <label className="block text-sm text-zinc-500">Channel</label>
              <p className="mt-1 text-sm capitalize text-zinc-700 dark:text-zinc-300">{ticket.channel.replace("_", " ")}</p>
            </div>
            <div>
              <label className="block text-sm text-zinc-500">Created</label>
              <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{formatDate(ticket.created_at)}</p>
            </div>
            <div>
              <label className="block text-sm text-zinc-500">First Response</label>
              <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{formatDate(ticket.first_response_at)}</p>
            </div>
            <div>
              <label className="block text-sm text-zinc-500">Resolved</label>
              <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{formatDate(ticket.resolved_at)}</p>
            </div>
            {ticket.tags && ticket.tags.length > 0 && (
              <div>
                <label className="block text-sm text-zinc-500">Tags</label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {ticket.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-zinc-100 px-2 py-0.5 text-sm font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        </div>

        {/* Customer card */}
        <div className={`${mobileSection !== "customer" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        {customer && (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="text-sm font-medium uppercase tracking-wider text-zinc-500">Customer</h3>
            <div className="mt-3 space-y-2">
              <div>
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {[customer.first_name, customer.last_name].filter(Boolean).join(" ") || customer.email}
                </p>
                <div className="mt-1">
                  <RetentionBadge score={customer.retention_score} />
                </div>
              </div>
              <p className="text-sm text-zinc-500">{customer.email}</p>
              {customer.phone && <p className="text-sm text-zinc-500">{customer.phone}</p>}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div>
                  <p className="text-sm text-zinc-400">LTV</p>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{formatCents(customer.ltv_cents)}</p>
                </div>
                <div>
                  <p className="text-sm text-zinc-400">Orders</p>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{customer.total_orders}</p>
                </div>
              </div>
              <div>
                <p className="text-sm text-zinc-400">Subscription</p>
                <p className="text-sm capitalize text-zinc-700 dark:text-zinc-300">{customer.subscription_status}</p>
              </div>
              <button
                onClick={() => router.push(`/dashboard/customers/${customer.id}`)}
                className="mt-1 text-sm text-indigo-600 hover:underline dark:text-indigo-400"
              >
                View full profile
              </button>

              {/* Linked Identities */}
              {(customer.linked_identities?.length > 0 || linkSuggestions.length > 0) && (
                <div className="pt-2">
                  <button
                    onClick={() => setShowLinkSection(!showLinkSection)}
                    className="flex w-full items-center justify-between text-sm font-medium text-zinc-500"
                  >
                    <span>Linked Profiles{customer.linked_identities?.length > 0 && ` (${customer.linked_identities.length})`}</span>
                    <svg className={`h-3 w-3 transition-transform ${showLinkSection ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                  {showLinkSection && (
                    <div className="mt-1.5 space-y-1">
                      {customer.linked_identities?.map((li) => (
                        <button
                          key={li.id}
                          onClick={() => router.push(`/dashboard/customers/${li.id}`)}
                          className="block w-full rounded bg-zinc-50 px-2 py-1.5 text-left text-sm transition-colors hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                        >
                          <span className="text-indigo-600 dark:text-indigo-400">{li.email}</span>
                          {(li.first_name || li.last_name) && (
                            <span className="ml-1 text-zinc-400">{[li.first_name, li.last_name].filter(Boolean).join(" ")}</span>
                          )}
                          {li.is_primary && (
                            <span className="ml-1 rounded bg-indigo-100 px-1 py-0.5 text-sm font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">primary</span>
                          )}
                        </button>
                      ))}
                      {linkSuggestions.length > 0 && (
                        <div className="mt-1">
                          <p className="text-sm font-medium uppercase tracking-wider text-zinc-400">Suggested</p>
                          {linkSuggestions.map((s) => (
                            <div key={s.id} className="mt-1 flex items-center justify-between rounded border border-amber-200 bg-amber-50 px-2 py-1.5 dark:border-amber-800 dark:bg-amber-950">
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{s.email}</p>
                                <span className="rounded bg-amber-200 px-1 py-0.5 text-sm font-medium text-amber-700 dark:bg-amber-800 dark:text-amber-300">
                                  {s.match_reason}
                                </span>
                              </div>
                              <button
                                onClick={async () => {
                                  const res = await fetch(`/api/customers/${customer.id}/links`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ link_to: s.id }),
                                  });
                                  if (res.ok) {
                                    setCustomer((prev) => prev ? {
                                      ...prev,
                                      linked_identities: [...(prev.linked_identities || []), { id: s.id, email: s.email, first_name: s.first_name, last_name: s.last_name, is_primary: false }],
                                    } : prev);
                                    setLinkSuggestions((prev) => prev.filter((x) => x.id !== s.id));
                                  }
                                }}
                                className="ml-2 flex-shrink-0 rounded border border-indigo-300 px-1.5 py-0.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-950"
                              >
                                Link
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Subscriptions */}
              {customer.subscriptions?.length > 0 && (
                <div className="pt-2">
                  <p className="text-sm font-medium text-zinc-500">Subscriptions</p>
                  <div className="mt-1 space-y-1">
                    {customer.subscriptions.map((sub) => (
                      <div key={sub.id} className="rounded bg-zinc-50 px-2 py-1.5 text-sm dark:bg-zinc-800">
                        <div className="flex items-center justify-between">
                          <span className={`rounded px-1.5 py-0.5 text-sm font-medium ${
                            sub.status === "active" ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                            : sub.status === "paused" ? "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
                            : "bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400"
                          }`}>
                            {sub.status}
                          </span>
                          {sub.billing_interval && (
                            <span className="text-sm text-zinc-400">
                              {sub.billing_interval_count}/{sub.billing_interval}
                            </span>
                          )}
                        </div>
                        {sub.items?.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {sub.items.slice(0, 3).map((item, idx) => (
                              <p key={idx} className="truncate text-sm text-zinc-500 dark:text-zinc-400">
                                {item.quantity}x {item.title}
                              </p>
                            ))}
                            {sub.items.length > 3 && (
                              <p className="text-sm text-zinc-400">+{sub.items.length - 3} more</p>
                            )}
                          </div>
                        )}
                        {sub.next_billing_date && (
                          <p className="mt-1 text-sm text-zinc-400">Next: {formatDate(sub.next_billing_date)}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent orders */}
              {customer.recent_orders.length > 0 && (
                <div className="pt-2">
                  <p className="text-sm font-medium text-zinc-500">Recent Orders</p>
                  <div className="mt-1 space-y-1">
                    {customer.recent_orders.map((o) => (
                      <div key={o.id}>
                        <button
                          onClick={() => setExpandedOrderId(expandedOrderId === o.id ? null : o.id)}
                          className="flex w-full items-center justify-between rounded bg-zinc-50 px-2 py-1.5 text-sm transition-colors hover:bg-zinc-100 dark:bg-zinc-800 dark:hover:bg-zinc-700"
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
                          <div className="mt-1 rounded border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
                            <div className="flex flex-wrap gap-1">
                              {o.order_type && (
                                <span className={`rounded px-1.5 py-0.5 text-sm font-medium ${
                                  o.order_type === "recurring" ? "bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400"
                                  : o.order_type === "replacement" ? "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400"
                                  : o.order_type === "checkout" ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                                }`}>
                                  {o.order_type === "recurring" ? "Recurring" : o.order_type === "replacement" ? "Replacement" : o.order_type === "checkout" ? "Checkout" : o.order_type}
                                </span>
                              )}
                              {o.financial_status && (
                                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm font-medium capitalize text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{o.financial_status}</span>
                              )}
                              {o.fulfillment_status && (
                                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm font-medium capitalize text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{o.fulfillment_status}</span>
                              )}
                            </div>
                            <p className="mt-1 text-sm text-zinc-400">{formatDate(o.created_at)}</p>
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
    </div>
  );
}
