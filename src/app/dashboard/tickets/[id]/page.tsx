"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import type { Ticket, TicketMessage, TicketStatus } from "@/lib/types/ticket";
import { cleanEmailForDisplay } from "@/lib/email-utils";
import TicketPresenceBanner, { useTicketPresence } from "@/components/ticket-presence";
import { createClient } from "@/lib/supabase/client";
import StoreCreditModal from "@/components/store-credit-modal";
import ReturnsList from "@/components/shared/ReturnsList";
import { ReplacementsList } from "@/components/shared/ReplacementsList";
import type { ReplacementItem } from "@/components/shared/ReplacementsList";
import SubscriptionsList from "@/components/shared/SubscriptionsList";
import LoyaltyCard from "@/components/shared/LoyaltyCard";
import type { LoyaltyMemberData, LoyaltyRedemption } from "@/components/shared/LoyaltyCard";
import type { SubscriptionData as CustomerSubscription } from "@/components/shared/SubscriptionsList";
import { formatItemName } from "@/components/shared/format-utils";
import EmailPreviewModal from "@/components/email-preview-modal";
import ChargebacksList from "@/components/shared/ChargebacksList";
import type { ChargebackItem } from "@/components/shared/ChargebacksList";
import FraudCasesList from "@/components/shared/FraudCasesList";
import type { FraudCaseItem } from "@/components/shared/FraudCasesList";

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
  shopify_order_id: string | null;
  order_number: string | null;
  total_cents: number;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  delivery_status?: string | null;
  source_name: string | null;
  order_type: string | null;
  line_items: OrderLineItem[];
  fulfillments: OrderFulfillment[];
  shipping_address?: { address1?: string; address2?: string; city?: string; province?: string; provinceCode?: string; zip?: string; country?: string } | null;
  created_at: string;
}

function getOrderShippingStatus(o: RecentOrder): { label: string; classes: string } {
  const fs = (o.fulfillment_status || "").toUpperCase();
  const ds = o.delivery_status || "";
  if (ds === "delivered") return { label: "Delivered", classes: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" };
  if (ds === "returned") return { label: "Returned", classes: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" };
  if (fs === "FULFILLED" && ds === "not_delivered") return { label: "In Transit", classes: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" };
  if (fs === "FULFILLED") return { label: "In Transit", classes: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" };
  if (!fs || fs === "UNFULFILLED" || fs === "NULL") return { label: "Unfulfilled", classes: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" };
  return { label: fs.toLowerCase(), classes: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" };
}

/* SubscriptionItem / CustomerSubscription types use SubscriptionData from shared component */

interface LinkedIdentity {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  is_primary: boolean;
}

interface CustomerReview {
  id: string;
  rating: number | null;
  title: string | null;
  body: string | null;
  review_type: string;
  status: string;
  featured: boolean;
  product_name: string | null;
  published_at: string | null;
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
  portal_banned?: boolean;
  recent_orders: RecentOrder[];
  subscriptions: CustomerSubscription[];
  linked_identities: LinkedIdentity[];
  reviews?: CustomerReview[];
}

interface TicketDetail extends Ticket {
  assigned_name: string | null;
}

const STATUS_OPTIONS: TicketStatus[] = ["open", "pending", "closed"];
const STATUS_OPTIONS_WITH_ARCHIVED: TicketStatus[] = ["open", "pending", "closed", "archived"];

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
  const [shopifyDomain, setShopifyDomain] = useState<string | null>(null);
  const [emailLive, setEmailLive] = useState(true);

  // Composer state
  const [replyBody, setReplyBody] = useState("");
  const [replyMode, setReplyMode] = useState<"external" | "internal">("external");
  const [sending, setSending] = useState(false);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"messages" | "history" | "improve">("messages");
  const [mobileSection, setMobileSection] = useState<"conversation" | "details" | "customer" | "subscriptions" | "orders" | "returns" | "replacements" | "chargebacks" | "fraud" | "loyalty" | "reviews" | "actions">("conversation");
  const [customerEvents, setCustomerEvents] = useState<{ id: string; event_type: string; source: string; summary: string; created_at: string }[]>([]);
  const [closeWithReply, setCloseWithReply] = useState(true);
  const [editorFocused, setEditorFocused] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const [tagInput, setTagInput] = useState("");
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  // Improve tab state
  const [improveMessages, setImproveMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [improveInput, setImproveInput] = useState("");
  const [improveLoading, setImproveLoading] = useState(false);
  const [proposedPrompt, setProposedPrompt] = useState<{ title: string; content: string; category: string } | null>(null);
  const [promptSaved, setPromptSaved] = useState(false);
  const [proposedActions, setProposedActions] = useState<{ type: string; [key: string]: unknown }[] | null>(null);
  const [actionsExecuted, setActionsExecuted] = useState(false);
  const [availableWorkflows, setAvailableWorkflows] = useState<{ id: string; name: string; template: string; trigger_tag: string }[]>([]);
  const [runningWorkflow, setRunningWorkflow] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [availablePlaybooks, setAvailablePlaybooks] = useState<{ id: string; name: string }[]>([]);
  const [applyingPlaybook, setApplyingPlaybook] = useState(false);
  const [availableJourneys, setAvailableJourneys] = useState<{ id: string; name: string; trigger_intent: string }[]>([]);
  const [sendingJourney, setSendingJourney] = useState(false);
  const [sendingCrisisJourney, setSendingCrisisJourney] = useState(false);
  const [selectedCrisisTier, setSelectedCrisisTier] = useState("1");
  const [playbookContext, setPlaybookContext] = useState("");
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
  const [currentUser, setCurrentUser] = useState<{ id: string; name: string } | null>(null);
  const [storeCreditBalance, setStoreCreditBalance] = useState<number | null>(null);
  const [showStoreCreditModal, setShowStoreCreditModal] = useState(false);

  // Loyalty state
  const [loyaltyMember, setLoyaltyMember] = useState<LoyaltyMemberData | null>(null);
  const [loyaltyRedemptions, setLoyaltyRedemptions] = useState<LoyaltyRedemption[]>([]);
  const [chargebacks, setChargebacks] = useState<ChargebackItem[]>([]);
  const [fraudCases, setFraudCases] = useState<FraudCaseItem[]>([]);
  const [loyaltySettings, setLoyaltySettings] = useState<{
    enabled: boolean;
    redemption_tiers: { label: string; points_cost: number; discount_value: number }[];
  } | null>(null);

  // Returns state
  const [ticketReturns, setTicketReturns] = useState<{ id: string; order_number: string; status: string; resolution_type: string; net_refund_cents: number; tracking_number: string | null; created_at: string }[]>([]);
  const [ticketReplacements, setTicketReplacements] = useState<ReplacementItem[]>([]);
  const [replacementsCardOpen, setReplacementsCardOpen] = useState(true);
  const [returnsCardOpen, setReturnsCardOpen] = useState(false);

  // Collapsible card states (all collapsed by default)
  const [customerCardOpen, setCustomerCardOpen] = useState(false);
  const [subscriptionsCardOpen, setSubscriptionsCardOpen] = useState(false);
  const [ordersCardOpen, setOrdersCardOpen] = useState(false);
  const [loyaltyCardOpen, setLoyaltyCardOpen] = useState(false);
  const [emailPreview, setEmailPreview] = useState<{ html: string; subject: string; to?: string; sentAt?: string } | null>(null);

  // Inline subscription actions state
  const [subActionPanel, setSubActionPanel] = useState<{ subId: string; action: string } | null>(null);
  const [subActionLoading, setSubActionLoading] = useState(false);
  const [subActionResult, setSubActionResult] = useState<{ subId: string; message: string; success: boolean } | null>(null);
  const [subNextDate, setSubNextDate] = useState("");
  const [subCancelReason, setSubCancelReason] = useState("");
  const [subCouponCode, setSubCouponCode] = useState("");

  // Fetch current user for presence
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setCurrentUser({
          id: data.user.id,
          name: data.user.user_metadata?.full_name || data.user.email || "Agent",
        });
      }
    });
  }, []);

  const presence = useTicketPresence({
    ticketId: id,
    currentUserId: currentUser?.id || "",
    currentUserName: currentUser?.name || "",
  });

  // Order actions state
  const [orderActionPanel, setOrderActionPanel] = useState<{ orderId: string; action: "refund" | "cancel" | "edit_address" } | null>(null);
  const [orderActionLoading, setOrderActionLoading] = useState(false);
  const [orderActionError, setOrderActionError] = useState<string | null>(null);
  const [orderActionSuccess, setOrderActionSuccess] = useState<string | null>(null);
  const [refundFull, setRefundFull] = useState(true);
  const [cancelReason, setCancelReason] = useState<"CUSTOMER" | "INVENTORY" | "OTHER">("CUSTOMER");
  const [cancelRefund, setCancelRefund] = useState(true);
  const [cancelRestock, setCancelRestock] = useState(true);
  const [addressForm, setAddressForm] = useState({ address1: "", address2: "", city: "", province: "", zip: "", country: "US" });

  // Snooze state
  const [showSnoozeMenu, setShowSnoozeMenu] = useState(false);
  const [showSnoozeCustom, setShowSnoozeCustom] = useState(false);
  const [snoozeCustomDate, setSnoozeCustomDate] = useState("");
  const [snoozeCustomTime, setSnoozeCustomTime] = useState("09:00");

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
      setShopifyDomain(data.shopify_domain || null);
      setEmailLive(data.email_live ?? true);
      setLoading(false);

      // Fetch store credit balance
      if (data.customer?.id) {
        fetch(`/api/store-credit/balance?customerId=${data.customer.id}`)
          .then(r => r.json())
          .then(b => setStoreCreditBalance(b.balance ?? 0))
          .catch(() => setStoreCreditBalance(0));
      }

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

      // Load reviews for customer
      if (data.customer) {
        fetch(`/api/workspaces/${workspace.id}/reviews?customer_id=${data.customer.id}&limit=10`)
          .then((r) => r.json())
          .then((d) => {
            if (d.reviews) setCustomer((prev) => prev ? { ...prev, reviews: d.reviews } : prev);
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

      // Load loyalty data for customer
      if (data.customer) {
        fetch(`/api/loyalty/members?workspace_id=${workspace.id}&customer_id=${data.customer.id}&limit=1`)
          .then((r) => r.json())
          .then((d) => {
            if (d.members?.[0]) {
              setLoyaltyMember(d.members[0]);
              // Fetch redemptions for this member
              fetch(`/api/loyalty/redemptions?member_id=${d.members[0].id}`)
                .then(r => r.json())
                .then(rd => { if (rd.redemptions) setLoyaltyRedemptions(rd.redemptions); })
                .catch(() => {});
            }
          })
          .catch(() => {});
        fetch(`/api/workspaces/${workspace.id}/loyalty`)
          .then((r) => r.json())
          .then((d) => { if (d.enabled) setLoyaltySettings(d); })
          .catch(() => {});
      }

      // Load returns for this ticket and customer
      if (data.customer) {
        Promise.all([
          fetch(`/api/workspaces/${workspace.id}/returns?ticket_id=${id}&limit=50`).then(r => r.json()),
          fetch(`/api/workspaces/${workspace.id}/returns?customer_id=${data.customer.id}&limit=50`).then(r => r.json()),
        ]).then(([byTicket, byCustomer]) => {
          const map = new Map<string, typeof ticketReturns[0]>();
          for (const r of [...(byTicket.returns || []), ...(byCustomer.returns || [])]) {
            map.set(r.id, r);
          }
          setTicketReturns(Array.from(map.values()));
        }).catch(() => {});

        // Load replacements for this ticket and customer
        Promise.all([
          fetch(`/api/workspaces/${workspace.id}/replacements?ticket_id=${id}&limit=50`).then(r => r.json()),
          fetch(`/api/workspaces/${workspace.id}/replacements?customer_id=${data.customer.id}&limit=50`).then(r => r.json()),
        ]).then(([byTicket, byCustomer]) => {
          const map = new Map<string, ReplacementItem>();
          for (const r of [...(byTicket.replacements || []), ...(byCustomer.replacements || [])]) {
            map.set(r.id, r);
          }
          setTicketReplacements(Array.from(map.values()));
        }).catch(() => {});
      }

        // Load chargebacks for customer
        fetch(`/api/chargebacks?customer_id=${data.customer.id}&limit=10`)
          .then(r => r.json())
          .then(d => { if (d.data) setChargebacks(d.data); })
          .catch(() => {});

        // Load fraud cases for customer
        fetch(`/api/workspaces/${workspace.id}/fraud-cases?customer_id=${data.customer.id}&limit=10`)
          .then(r => r.json())
          .then(d => { if (d.cases) setFraudCases(d.cases); })
          .catch(() => {});

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
    fetch(`/api/workspaces/${workspace.id}/playbooks`)
      .then((res) => res.json())
      .then((data) => { if (data?.playbooks) setAvailablePlaybooks(data.playbooks.filter((p: { is_active: boolean }) => p.is_active).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }))); })
      .catch(() => {});
    fetch(`/api/workspaces/${workspace.id}/journeys`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setAvailableJourneys(data.filter((j: { is_active: boolean }) => j.is_active).map((j: { id: string; name: string; trigger_intent: string }) => ({ id: j.id, name: j.name, trigger_intent: j.trigger_intent }))); })
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

  const handleOrderAction = async (order: RecentOrder, action: string, payload: Record<string, unknown>) => {
    setOrderActionLoading(true);
    setOrderActionError(null);
    setOrderActionSuccess(null);
    try {
      const res = await fetch(`/api/tickets/${id}/order-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          order_id: order.shopify_order_id,
          order_number: order.order_number,
          ...payload,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setOrderActionSuccess(data.note);
        setOrderActionPanel(null);
        // Refresh ticket data to get updated order + new internal note
        const refreshRes = await fetch(`/api/tickets/${id}`);
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json();
          setTicket(refreshData.ticket);
          setMessages(refreshData.messages);
          setCustomer(refreshData.customer);
        }
      } else {
        setOrderActionError(data.error || "Action failed");
      }
    } catch {
      setOrderActionError("Network error");
    } finally {
      setOrderActionLoading(false);
    }
  };

  const handleSubAction = async (subId: string, action: string, body: Record<string, unknown> = {}) => {
    setSubActionLoading(true);
    setSubActionResult(null);
    let actionSuccess = false;
    let actionMessage = "";
    try {
      if (action === "bill_now") {
        const res = await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}/bill-now`, { method: "POST" });
        const data = await res.json();
        actionSuccess = res.ok;
        actionMessage = res.ok ? "Payment processed" : (data.error || "Failed");
      } else if (action === "apply_coupon") {
        const res = await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}/coupon`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: body.code }),
        });
        const data = await res.json();
        actionSuccess = res.ok;
        actionMessage = res.ok ? "Coupon applied" : (data.error || "Failed");
      } else {
        const res = await fetch(`/api/workspaces/${workspace.id}/subscriptions/${subId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...body }),
        });
        const data = await res.json();
        actionSuccess = res.ok;
        actionMessage = res.ok ? `${action.replace(/_/g, " ")} successful` : (data.error || "Failed");
      }
      setSubActionResult({ subId, message: actionMessage, success: actionSuccess });
      setSubActionPanel(null);

      // Post system message to conversation
      const actionLabel = action.replace(/_/g, " ");
      const noteBody = actionSuccess
        ? `${actionLabel} completed on subscription`
        : `${actionLabel} attempted but failed: ${actionMessage}`;
      await fetch(`/api/tickets/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: noteBody, visibility: "internal", author_type: "system" }),
      }).catch(() => {});
      // Refresh customer data + messages
      const refreshRes = await fetch(`/api/tickets/${id}`);
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json();
        setCustomer(refreshData.customer);
      }
    } catch {
      setSubActionResult({ subId, message: "Network error", success: false });
    } finally {
      setSubActionLoading(false);
    }
  };

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

  const handleSnooze = async (until: Date) => {
    setShowSnoozeMenu(false);
    setShowSnoozeCustom(false);
    await handlePatch({ snoozed_until: until.toISOString(), status: "pending" });
    // Add internal note
    await fetch(`/api/tickets/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        direction: "outbound",
        visibility: "internal",
        author_type: "system",
        body: `Ticket snoozed until ${until.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}`,
      }),
    });
    // Refresh messages
    const res = await fetch(`/api/tickets/${id}`);
    if (res.ok) {
      const data = await res.json();
      setMessages(data.messages);
    }
  };

  const handleUnsnooze = async () => {
    await handlePatch({ snoozed_until: null, status: "open" });
    await fetch(`/api/tickets/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        direction: "outbound",
        visibility: "internal",
        author_type: "system",
        body: "Ticket unsnoozed manually",
      }),
    });
    const res = await fetch(`/api/tickets/${id}`);
    if (res.ok) {
      const data = await res.json();
      setMessages(data.messages);
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
        if (editorRef.current) editorRef.current.innerHTML = data.personalized;
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
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
          <option value="subscriptions">Subscriptions</option>
          <option value="orders">Orders</option>
          <option value="returns">Returns</option>
          <option value="replacements">Replacements</option>
          <option value="chargebacks">Chargebacks</option>
          <option value="fraud">Fraud</option>
          <option value="loyalty">Loyalty</option>
          <option value="reviews">Reviews</option>
          <option value="actions">Actions</option>
        </select>
      </div>

      {/* Left column - conversation */}
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${mobileSection !== "conversation" ? "hidden md:flex" : ""}`}>
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

          {/* Fraud customer banner */}
          {customer?.portal_banned && (
            <div className="mb-4 rounded-lg bg-red-600 px-4 py-2 text-center text-sm font-bold text-white">
              FRAUD CUSTOMER — Account banned
            </div>
          )}

          {/* Presence banner */}
          <TicketPresenceBanner others={presence.others} />

          {/* Escalation banner */}
          {(ticket as TicketDetail & { escalation_reason?: string; ai_turn_count?: number }).escalation_reason && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 dark:border-red-800 dark:bg-red-950">
              <svg className="h-4 w-4 flex-shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-red-700 dark:text-red-400">
                  {((ticket as TicketDetail & { escalation_reason?: string }).escalation_reason || "").replace(/_/g, " ")} — AI paused
                  {(ticket as TicketDetail & { ai_turn_count?: number }).ai_turn_count ? ` after ${(ticket as TicketDetail & { ai_turn_count?: number }).ai_turn_count} turn${(ticket as TicketDetail & { ai_turn_count?: number }).ai_turn_count !== 1 ? "s" : ""}` : ""}
                </p>
              </div>
            </div>
          )}

          {/* Snooze banner */}
          {ticket.snoozed_until && new Date(ticket.snoozed_until) > new Date() && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 dark:border-indigo-800 dark:bg-indigo-950">
              <svg className="h-4 w-4 flex-shrink-0 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-medium text-indigo-700 dark:text-indigo-400">
                  Snoozed until {new Date(ticket.snoozed_until).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </p>
              </div>
              <button
                onClick={handleUnsnooze}
                className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500"
              >
                Unsnooze
              </button>
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

          {/* Archived banner */}
          {ticket.status === "archived" && (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-400">
              This ticket was archived on {ticket.archived_at ? new Date(ticket.archived_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "unknown date"}. Archived tickets are read-only.
            </div>
          )}

          {/* Tags */}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {(ticket.tags || []).map((tag) => {
              const isSmart = tag.startsWith("smart:");
              const displayTag = tag;
              return (
                <span key={tag} className={`inline-flex max-w-[180px] items-center gap-0.5 rounded px-1.5 py-0.5 text-sm font-medium ${
                  isSmart
                    ? "bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400"
                    : "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400"
                }`}>
                  {isSmart && <svg className="mr-0.5 h-2.5 w-2.5 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" /></svg>}
                  <span className="truncate">{displayTag}</span>
                  {ticket.status !== "archived" && (
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
                  )}
                </span>
              );
            })}
            {ticket.status !== "archived" && (
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
            )}
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
            {["owner", "admin"].includes(workspace.role) && (
              <button
                onClick={() => setActiveTab("improve")}
                className={`pb-2 text-sm font-medium transition-colors ${
                  activeTab === "improve"
                    ? "border-b-2 border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
                    : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                }`}
              >
                Improve
              </button>
            )}
          </div>

          {/* Messages tab */}
          {activeTab === "messages" && <div className="mt-4 space-y-4">
            {messages.map((m) => {
              // Journey suggestion card
              const journeySuggestMatch = m.body.match(/<!--JOURNEY-SUGGEST:([\s\S]*?)-->/);
              if (journeySuggestMatch) {
                try {
                  const suggestion = JSON.parse(journeySuggestMatch[1]);
                  return (
                    <JourneySuggestionCard
                      key={m.id}
                      journeyId={suggestion.journeyId}
                      journeyName={suggestion.journeyName}
                      ticketId={id as string}
                      onSent={async () => {
                        const res = await fetch(`/api/tickets/${id}`);
                        if (res.ok) { const d = await res.json(); setTicket(d.ticket); setMessages(d.messages); }
                      }}
                    />
                  );
                } catch { /* fall through to normal render */ }
              }

              const isInbound = m.direction === "inbound";
              const isInternal = m.visibility === "internal";

              let bgClass: string;
              let textClass: string;
              let align: string;

              if (isInternal) {
                bgClass = "bg-amber-50 border border-amber-200 dark:bg-amber-900/20 dark:border-amber-800";
                textClass = "text-zinc-900 dark:text-zinc-100";
                align = "ml-auto";
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
                      {m.author_type === "ai" && !isInternal && (
                        <span className="rounded bg-cyan-100 px-1 py-0.5 text-[10px] font-medium text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-400">AI</span>
                      )}
                      <span>{formatDateTime(m.created_at)}</span>
                    </div>
                    <div
                      className={`prose prose-sm max-w-none break-words overflow-hidden [overflow-wrap:anywhere] ${textClass} ${!isInbound && !isInternal ? "prose-invert" : ""}`}
                      dangerouslySetInnerHTML={{ __html: (m.direction === "inbound" && (m as unknown as Record<string, unknown>).body_clean) ? String((m as unknown as Record<string, unknown>).body_clean) : m.body }}
                    />
                    {(m as TicketMessage & { _sandbox_suppressed?: boolean })._sandbox_suppressed && (
                      <div className="mt-1.5 flex items-center gap-1 text-sm text-amber-300">
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
                        </svg>
                        Sandbox — not sent to customer
                      </div>
                    )}
                    {/* Pending send indicator */}
                    {(m as TicketMessage & { pending_send_at?: string | null; sent_at?: string | null; send_cancelled?: boolean }).pending_send_at && !(m as TicketMessage & { sent_at?: string | null }).sent_at && !(m as TicketMessage & { send_cancelled?: boolean }).send_cancelled && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-300">
                        <svg className="h-3 w-3 animate-pulse" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
                        </svg>
                        Sending at {new Date((m as TicketMessage & { pending_send_at: string }).pending_send_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                        <button
                          onClick={() => {
                            const current = (m.body || "").replace(/<[^>]*>/g, "").trim();
                            const edited = prompt("Edit message before sending:", current);
                            if (edited !== null && edited !== current) {
                              fetch(`/api/tickets/${id}`, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ edit_pending_message: m.id, new_body: edited }),
                              }).then(() => {
                                setMessages(prev => prev.map(pm => pm.id === m.id ? { ...pm, body: `<p>${edited.replace(/\n/g, "</p><p>")}</p>` } as typeof pm : pm));
                              });
                            }
                          }}
                          className="ml-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 hover:bg-amber-500/30"
                        >
                          Edit
                        </button>
                        <button
                          onClick={async () => {
                            await fetch(`/api/tickets/${id}`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ cancel_pending_message: m.id }),
                            });
                            setMessages(prev => prev.map(pm => pm.id === m.id ? { ...pm, send_cancelled: true } as typeof pm : pm));
                          }}
                          className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-300 hover:bg-red-500/30"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {(m as TicketMessage & { send_cancelled?: boolean }).send_cancelled && ticket.channel !== "chat" && (
                      <div className="mt-1.5 text-xs text-zinc-400 line-through">Send cancelled</div>
                    )}
                    {/* Email delivery status */}
                    {!isInbound && !isInternal && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs">
                        {/* Chat→email fallback badge */}
                        {ticket.channel === "chat" && (m as TicketMessage & { email_status?: string }).email_status && (
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">Sent via email</span>
                        )}
                        {(() => {
                          const status = (m as TicketMessage & { email_status?: string }).email_status;
                          if (status === "opened" || status === "clicked") return <span className="text-emerald-400">Opened</span>;
                          if (status === "delivered") return <span className="text-blue-400">Delivered</span>;
                          if (status === "bounced") return <span className="text-red-400">Bounced</span>;
                          if (status === "sent") return <span className="text-zinc-400">Sent</span>;
                          return null;
                        })()}
                        {(m as TicketMessage & { sent_at?: string }).sent_at && (
                          <button
                            onClick={() => setEmailPreview({
                              html: m.body,
                              subject: ticket.subject || "Email",
                              to: customer?.email,
                              sentAt: (m as TicketMessage & { sent_at?: string }).sent_at || undefined,
                            })}
                            className="text-indigo-300 hover:text-indigo-200 hover:underline"
                          >
                            Preview
                          </button>
                        )}
                      </div>
                    )}
                    {/* Approve & Send for AI sandbox drafts */}
                    {isInternal && m.author_type === "ai" && m.body.includes("[AI Draft") && (
                      <button
                        onClick={async () => {
                          if (!confirm("Send this AI draft to the customer?")) return;
                          // Strip the sandbox prefix from the body
                          const cleanBody = m.body
                            .replace(/\[AI Draft.*?Sandbox Mode\]\s*/i, "")
                            .replace(/\s*Confidence:.*?Source:.*$/i, "")
                            .trim();
                          const res = await fetch(`/api/tickets/${id}/messages`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ body: cleanBody, visibility: "external" }),
                          });
                          if (res.ok) {
                            const ticketRes = await fetch(`/api/tickets/${id}`);
                            if (ticketRes.ok) {
                              const data = await ticketRes.json();
                              setTicket(data.ticket);
                              setMessages(data.messages);
                            }
                          }
                        }}
                        className="mt-2 rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500"
                      >
                        Approve &amp; Send to Customer
                      </button>
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
                    <div className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                      ev.event_type === "email.sent" ? "bg-blue-400" :
                      ev.event_type === "email.opened" ? "bg-emerald-400" :
                      ev.event_type === "email.clicked" ? "bg-cyan-400" :
                      ev.event_type === "email.bounced" ? "bg-red-400" :
                      ev.event_type?.startsWith("subscription.") ? "bg-violet-400" :
                      ev.event_type?.startsWith("portal.") ? "bg-amber-400" :
                      "bg-zinc-300 dark:bg-zinc-600"
                    }`} />
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

          {/* Improve tab */}
          {activeTab === "improve" && ["owner", "admin"].includes(workspace.role) && (
            <div className="mt-4 flex flex-col" style={{ minHeight: 300 }}>
              {/* Chat messages */}
              <div className="flex-1 space-y-3 overflow-y-auto" style={{ maxHeight: 400 }}>
                {improveMessages.length === 0 && (
                  <p className="py-8 text-center text-sm text-zinc-400">
                    Chat with Sonnet about this ticket. You can:
                    <ul className="mt-2 space-y-1 text-left text-xs">
                      <li>Improve future responses — "You should have paused instead of cancelling"</li>
                      <li>Fix this ticket — "Refund the customer $30 and send them an apology"</li>
                      <li>Investigate — "Did we double charge this customer?"</li>
                    </ul>
                  </p>
                )}
                {improveMessages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                      m.role === "user"
                        ? "bg-indigo-600 text-white"
                        : "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                    }`}>
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    </div>
                  </div>
                ))}
                {improveLoading && (
                  <div className="flex justify-start">
                    <div className="rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-500 dark:bg-zinc-800">
                      Thinking...
                    </div>
                  </div>
                )}
              </div>

              {/* Proposed prompt card */}
              {proposedPrompt && !promptSaved && (
                <div className="mt-3 rounded-lg border-2 border-indigo-400 bg-white p-3 dark:bg-zinc-900">
                  <p className="text-xs font-medium uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Proposed Prompt Rule</p>
                  <input
                    type="text"
                    value={proposedPrompt.title}
                    onChange={(e) => setProposedPrompt({ ...proposedPrompt, title: e.target.value })}
                    className="mt-2 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    placeholder="Rule title"
                  />
                  <textarea
                    value={proposedPrompt.content}
                    onChange={(e) => setProposedPrompt({ ...proposedPrompt, content: e.target.value })}
                    rows={3}
                    className="mt-2 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    placeholder="Rule content"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <select
                      value={proposedPrompt.category}
                      onChange={(e) => setProposedPrompt({ ...proposedPrompt, category: e.target.value })}
                      className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      <option value="rule">Rule</option>
                      <option value="approach">Approach</option>
                      <option value="knowledge">Knowledge</option>
                      <option value="tool_hint">Tool Hint</option>
                    </select>
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch(`/api/workspaces/${workspace.id}/sonnet-prompts`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              category: proposedPrompt.category,
                              title: proposedPrompt.title,
                              content: proposedPrompt.content,
                            }),
                          });
                          if (res.ok) {
                            setPromptSaved(true);
                          }
                        } catch {
                          // ignore
                        }
                      }}
                      className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500"
                    >
                      Save to AI Prompts
                    </button>
                  </div>
                </div>
              )}
              {promptSaved && (
                <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  Prompt rule saved. It will apply to future AI responses.
                </div>
              )}

              {/* Proposed actions card */}
              {proposedActions && !actionsExecuted && (
                <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950">
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">Proposed Actions</p>
                  <ul className="mt-2 space-y-1">
                    {proposedActions.map((a, i) => (
                      <li key={i} className="text-sm text-amber-700 dark:text-amber-300">
                        {a.type === "partial_refund" && `Refund $${(((a.amount_cents as number) || 0) / 100).toFixed(2)} on order ${a.shopify_order_id}`}
                        {a.type === "send_message" && `Send message: "${String(a.body || "").slice(0, 80)}..."`}
                        {a.type === "reactivate" && `Reactivate subscription ${a.contract_id}`}
                        {a.type === "close_ticket" && "Close this ticket"}
                        {a.type === "reopen_ticket" && "Reopen this ticket"}
                        {a.type === "skip_next_order" && `Skip next order on ${a.contract_id}`}
                        {a.type === "crisis_pause" && `Pause subscription (crisis) ${a.contract_id}`}
                        {a.type === "apply_coupon" && `Apply coupon ${a.code} to ${a.contract_id}`}
                        {a.type === "update_line_item_price" && `Update base price to $${(((a.base_price_cents as number) || 0) / 100).toFixed(2)}`}
                        {!["partial_refund", "send_message", "reactivate", "close_ticket", "reopen_ticket", "skip_next_order", "crisis_pause", "apply_coupon", "update_line_item_price"].includes(a.type) && JSON.stringify(a)}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={async () => {
                        setImproveLoading(true);
                        setImproveMessages(prev => [...prev, { role: "user", content: "Yes, execute those actions." }]);
                        try {
                          const res = await fetch(`/api/tickets/${id}/improve`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              message: "Yes, execute those actions.",
                              conversationHistory: [...improveMessages, { role: "user", content: "Yes, execute those actions." }],
                            }),
                          });
                          if (res.ok) {
                            const data = await res.json();
                            setImproveMessages(prev => [...prev, { role: "assistant", content: data.message }]);
                            if (data.action_results) {
                              setActionsExecuted(true);
                              setProposedActions(null);
                              fetch(`/api/tickets/${id}`).then(r => r.json()).then(d => { if (d.messages) setMessages(d.messages); });
                            }
                          }
                        } catch {
                          setImproveMessages(prev => [...prev, { role: "assistant", content: "Something went wrong executing actions." }]);
                        }
                        setImproveLoading(false);
                      }}
                      disabled={improveLoading}
                      className="rounded bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                    >
                      {improveLoading ? "Executing..." : "Approve & Execute"}
                    </button>
                    <button
                      onClick={() => setProposedActions(null)}
                      className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 dark:border-zinc-600 dark:text-zinc-400"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {actionsExecuted && (
                <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  Actions executed. Check the conversation for results.
                </div>
              )}

              {/* Input */}
              <div className="mt-3 flex gap-2">
                <input
                  type="text"
                  value={improveInput}
                  onChange={(e) => setImproveInput(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter" && !e.shiftKey && improveInput.trim() && !improveLoading) {
                      e.preventDefault();
                      const msg = improveInput.trim();
                      setImproveInput("");
                      setImproveMessages((prev) => [...prev, { role: "user", content: msg }]);
                      setImproveLoading(true);
                      setPromptSaved(false);
                      try {
                        const res = await fetch(`/api/tickets/${id}/improve`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            message: msg,
                            conversationHistory: improveMessages,
                          }),
                        });
                        if (res.ok) {
                          const data = await res.json();
                          setImproveMessages((prev) => [...prev, { role: "assistant", content: data.message }]);
                          if (data.type === "prompt" && data.proposed_rule) {
                            setProposedPrompt({
                              title: data.proposed_rule.title,
                              content: data.proposed_rule.content,
                              category: data.proposed_rule.category || "rule",
                            });
                            setProposedActions(null);
                          } else if (data.type === "action_proposal" && data.proposed_actions?.length) {
                            setProposedActions(data.proposed_actions);
                            setActionsExecuted(false);
                            setProposedPrompt(null);
                          } else if (data.type === "action_execute" && data.action_results) {
                            setProposedActions(null);
                            setActionsExecuted(true);
                            setProposedPrompt(null);
                            // Refresh ticket messages
                            fetch(`/api/tickets/${id}`).then(r => r.json()).then(d => { if (d.messages) setMessages(d.messages); });
                          } else {
                            setProposedPrompt(null);
                            setProposedActions(null);
                          }
                        }
                      } catch {
                        setImproveMessages((prev) => [...prev, { role: "assistant", content: "Something went wrong. Please try again." }]);
                      } finally {
                        setImproveLoading(false);
                      }
                    }
                  }}
                  placeholder="Improve, fix, or investigate..."
                  className="flex-1 rounded border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  disabled={improveLoading}
                />
                <button
                  onClick={async () => {
                    if (!improveInput.trim() || improveLoading) return;
                    const msg = improveInput.trim();
                    setImproveInput("");
                    setImproveMessages((prev) => [...prev, { role: "user", content: msg }]);
                    setImproveLoading(true);
                    setPromptSaved(false);
                    try {
                      const res = await fetch(`/api/tickets/${id}/improve`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          message: msg,
                          conversationHistory: improveMessages,
                        }),
                      });
                      if (res.ok) {
                        const data = await res.json();
                        setImproveMessages((prev) => [...prev, { role: "assistant", content: data.message }]);
                        if (data.type === "prompt" && data.proposed_rule) {
                          setProposedPrompt({
                            title: data.proposed_rule.title,
                            content: data.proposed_rule.content,
                            category: data.proposed_rule.category || "rule",
                          });
                        } else {
                          setProposedPrompt(null);
                        }
                      }
                    } catch {
                      setImproveMessages((prev) => [...prev, { role: "assistant", content: "Something went wrong. Please try again." }]);
                    } finally {
                      setImproveLoading(false);
                    }
                  }}
                  disabled={!improveInput.trim() || improveLoading}
                  className="shrink-0 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  Send
                </button>
              </div>
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
                    if (editorRef.current) editorRef.current.innerHTML = aiDraft.ai_draft || "";
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
        {ticket.status !== "closed" && ticket.status !== "archived" && (
          <div className="shrink-0 flex items-center gap-2 border-t border-zinc-100 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
            {!aiDraft?.ai_draft && (
              <button
                onClick={async () => {
                  setGeneratingDraft(true);
                  try {
                    const res = await fetch(`/api/tickets/${id}/ai-draft`, { method: "POST" });
                    const data = await res.json();
                    if (!res.ok) {
                      alert(data.error || "AI draft failed");
                    } else if (data.draft) {
                      setAiDraft({
                        ai_draft: data.draft,
                        ai_confidence: data.confidence,
                        ai_tier: data.tier,
                        ai_source_type: data.source_type,
                        source_name: null,
                        ai_drafted_at: new Date().toISOString(),
                        ai_suggested_macro_id: data.source_type === "macro" ? data.source_id : null,
                        ai_suggested_macro_name: null,
                      });
                    } else {
                      alert("AI couldn't generate a draft for this ticket. No matching macros or KB articles found.");
                    }
                  } catch (err) {
                    alert(`AI draft error: ${err}`);
                  }
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
        {ticket.status !== "archived" && (
        <>
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
              onBlur={() => presence.onEditorBlur()}
              onInput={() => { setReplyBody(editorRef.current?.innerHTML || ""); presence.onEditorInput(); }}
              data-placeholder={replyMode === "external" ? "Type your reply..." : "Internal note..."}
              className={`w-full rounded-md border border-zinc-300 bg-white text-sm text-zinc-900 placeholder-zinc-400 outline-none transition-all focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 ${
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
        </>
        )}
      </div>

      {/* Right column - details */}
      <div className={`w-full shrink-0 overflow-y-auto border-t border-zinc-200 bg-zinc-50 p-6 md:w-80 md:border-l md:border-t-0 dark:border-zinc-800 dark:bg-zinc-950 ${mobileSection === "conversation" ? "hidden md:block" : ""}`}>
        {/* Actions card (hidden for archived) */}
        <div className={`${mobileSection !== "actions" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        {ticket.status !== "archived" && (availableWorkflows.length > 0 || availablePlaybooks.length > 0 || availableJourneys.length > 0 || (ticket.tags || []).some(t => t.startsWith("crisis"))) && (
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
                      value={selectedWorkflowId}
                      onChange={(e) => setSelectedWorkflowId(e.target.value)}
                      className="min-w-0 flex-1 truncate rounded border border-indigo-300 bg-white px-2 py-1 text-xs dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      <option value="" disabled>Select workflow...</option>
                      {availableWorkflows.map(wf => (
                        <option key={wf.id} value={wf.id}>{wf.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={async () => {
                        const wfId = selectedWorkflowId;
                        if (!wfId) return;
                        // For subscription_inquiry, require a subscription selection if customer has multiple
                        const selectedWf = availableWorkflows.find(w => w.id === wfId);
                        const subSelect = document.getElementById("workflow-subscription-select") as HTMLSelectElement | null;
                        const subscriptionId = selectedWf?.template === "subscription_inquiry" && subSelect?.value ? subSelect.value : undefined;
                        setRunningWorkflow(true);
                        try {
                          const res = await fetch(`/api/tickets/${id}/run-workflow`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ workflow_id: wfId, ...(subscriptionId ? { subscription_id: subscriptionId } : {}) }),
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
                  {/* Subscription selector for subscription_inquiry workflows */}
                  {(() => {
                    const selectedWf = availableWorkflows.find(w => w.id === selectedWorkflowId);
                    if (selectedWf?.template !== "subscription_inquiry") return null;
                    const subs = customer?.subscriptions || [];
                    if (subs.length === 0) return null;
                    return (
                      <div className="mt-2">
                        <label className="block text-xs text-indigo-400">Select subscription</label>
                        <select
                          id="workflow-subscription-select"
                          defaultValue=""
                          className="mt-1 w-full truncate rounded border border-indigo-300 bg-white px-2 py-1 text-xs dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100"
                        >
                          <option value="">Auto-detect</option>
                          {subs.map((sub) => {
                            const title = sub.items
                              ?.filter(i => i.title && !i.title.toLowerCase().includes("shipping protection"))
                              .map(i => formatItemName(i))
                              .join(", ") || "Subscription";
                            const nextDate = sub.next_billing_date
                              ? new Date(sub.next_billing_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                              : "—";
                            return (
                              <option key={sub.id} value={sub.id}>
                                {title} — {sub.status} ({nextDate})
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Send journey */}
              {availableJourneys.length > 0 && (
                <div>
                  <label className="block text-xs text-indigo-500">Send Journey</label>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      id="journey-select"
                      defaultValue=""
                      className="min-w-0 flex-1 truncate rounded border border-indigo-300 bg-white px-2 py-1 text-xs dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      <option value="" disabled>Select journey...</option>
                      {availableJourneys.map(j => (
                        <option key={j.id} value={j.id}>{j.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={async () => {
                        const select = document.getElementById("journey-select") as HTMLSelectElement;
                        const journeyId = select?.value;
                        if (!journeyId) return;
                        setSendingJourney(true);
                        try {
                          const res = await fetch(`/api/tickets/${id}/send-journey`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ journeyId }),
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
                          setSendingJourney(false);
                        }
                      }}
                      disabled={sendingJourney}
                      className="shrink-0 rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {sendingJourney ? "..." : "Send"}
                    </button>
                  </div>
                </div>
              )}

              {/* Send crisis journey */}
              {(ticket.tags || []).some(t => t.startsWith("crisis")) && (
                <div>
                  <label className="block text-xs text-indigo-500">Send Crisis Journey</label>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      value={selectedCrisisTier}
                      onChange={(e) => setSelectedCrisisTier(e.target.value)}
                      className="min-w-0 flex-1 truncate rounded border border-indigo-300 bg-white px-2 py-1 text-xs dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      <option value="1">Tier 1 — Flavor Swap</option>
                      <option value="2">Tier 2 — Product Swap</option>
                      <option value="3">Tier 3 — Pause/Remove</option>
                    </select>
                    <button
                      onClick={async () => {
                        setSendingCrisisJourney(true);
                        try {
                          const res = await fetch(`/api/tickets/${id}/send-crisis-journey`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ tier: Number(selectedCrisisTier) }),
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
                          setSendingCrisisJourney(false);
                        }
                      }}
                      disabled={sendingCrisisJourney}
                      className="shrink-0 rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {sendingCrisisJourney ? "..." : "Send"}
                    </button>
                  </div>
                </div>
              )}

              {/* Apply playbook */}
              {availablePlaybooks.length > 0 && (
                <div>
                  <label className="block text-xs text-indigo-500">Apply Playbook</label>
                  <div className="mt-1 space-y-1.5">
                    <select
                      id="playbook-select"
                      defaultValue=""
                      className="w-full truncate rounded border border-indigo-300 bg-white px-2 py-1 text-xs dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100"
                    >
                      <option value="" disabled>Select playbook...</option>
                      {availablePlaybooks.map(pb => (
                        <option key={pb.id} value={pb.id}>{pb.name}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={playbookContext}
                      onChange={e => setPlaybookContext(e.target.value)}
                      placeholder="Context, e.g. &quot;customer wants refund on SC12345&quot;"
                      className="w-full rounded border border-indigo-300 bg-white px-2 py-1 text-xs placeholder-indigo-300 dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-indigo-600"
                    />
                    <button
                      onClick={async () => {
                        const select = document.getElementById("playbook-select") as HTMLSelectElement;
                        const pbId = select?.value;
                        if (!pbId) return;
                        setApplyingPlaybook(true);
                        try {
                          const res = await fetch(`/api/tickets/${id}/apply-playbook`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ playbook_id: pbId, context: playbookContext }),
                          });
                          if (res.ok) {
                            setPlaybookContext("");
                            const ticketRes = await fetch(`/api/tickets/${id}`);
                            if (ticketRes.ok) {
                              const data = await ticketRes.json();
                              setTicket(data.ticket);
                              setMessages(data.messages);
                            }
                          }
                        } finally {
                          setApplyingPlaybook(false);
                        }
                      }}
                      disabled={applyingPlaybook}
                      className="w-full rounded bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {applyingPlaybook ? "Applying..." : "Apply Playbook"}
                    </button>
                  </div>
                </div>
              )}

            </div>
          </div>
        )}

        {/* Snooze */}
        <div className="mb-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Snooze</h3>
          {ticket.snoozed_until && new Date(ticket.snoozed_until) > new Date() ? (
            <div className="mt-2">
              <p className="text-xs text-zinc-500">
                Snoozed until {new Date(ticket.snoozed_until).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </p>
              <button
                onClick={handleUnsnooze}
                className="mt-2 w-full rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
              >
                Unsnooze
              </button>
            </div>
          ) : (
            <div className="relative mt-2">
              <button
                onClick={() => setShowSnoozeMenu(!showSnoozeMenu)}
                className="flex w-full items-center justify-center gap-1.5 rounded bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Snooze
              </button>
              {showSnoozeMenu && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                  <button
                    onClick={() => {
                      const d = new Date();
                      d.setHours(d.getHours() + 4);
                      handleSnooze(d);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  >
                    Later today (4 hours)
                  </button>
                  <button
                    onClick={() => {
                      const d = new Date();
                      d.setDate(d.getDate() + 1);
                      d.setHours(9, 0, 0, 0);
                      handleSnooze(d);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  >
                    Tomorrow morning (9 AM)
                  </button>
                  <button
                    onClick={() => {
                      const d = new Date();
                      const daysUntilMonday = ((1 - d.getDay()) + 7) % 7 || 7;
                      d.setDate(d.getDate() + daysUntilMonday);
                      d.setHours(9, 0, 0, 0);
                      handleSnooze(d);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  >
                    Next Monday (9 AM)
                  </button>
                  <hr className="my-1 border-zinc-200 dark:border-zinc-700" />
                  <button
                    onClick={() => {
                      setShowSnoozeMenu(false);
                      setShowSnoozeCustom(true);
                      const tomorrow = new Date();
                      tomorrow.setDate(tomorrow.getDate() + 1);
                      setSnoozeCustomDate(tomorrow.toISOString().split("T")[0]);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  >
                    Custom date/time...
                  </button>
                </div>
              )}
              {showSnoozeCustom && (
                <div className="mt-2 space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-700 dark:bg-zinc-800">
                  <input
                    type="date"
                    value={snoozeCustomDate}
                    onChange={(e) => setSnoozeCustomDate(e.target.value)}
                    className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                  />
                  <input
                    type="time"
                    value={snoozeCustomTime}
                    onChange={(e) => setSnoozeCustomTime(e.target.value)}
                    className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                  />
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => {
                        if (!snoozeCustomDate) return;
                        const d = new Date(`${snoozeCustomDate}T${snoozeCustomTime}`);
                        if (d > new Date()) handleSnooze(d);
                      }}
                      className="flex-1 rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500"
                    >
                      Snooze
                    </button>
                    <button
                      onClick={() => setShowSnoozeCustom(false)}
                      className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-500 dark:border-zinc-600"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Share ticket */}
        <ShareTicketButton ticketId={id as string} workspaceId={workspace.id} />

        {/* Delete ticket — owner/admin only */}
        {["owner", "admin"].includes(workspace.role) && (
          <div className="mb-4">
            <button
              onClick={async () => {
                if (!confirm("Delete this ticket and all its messages? This cannot be undone.")) return;
                const res = await fetch(`/api/tickets/${id}`, { method: "DELETE" });
                if (res.ok) router.push("/dashboard/tickets");
              }}
              className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
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
              {ticket.status === "archived" ? (
                <div className="mt-1 w-full rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-sm text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500">Archived</div>
              ) : (
              <select
                value={ticket.status}
                onChange={(e) => handlePatch({ status: e.target.value })}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
              )}
            </div>
            <div>
              <label className="block text-sm text-zinc-500">Assigned To</label>
              {(ticket as TicketDetail & { handled_by?: string }).handled_by && (
                <div className="mt-1 mb-1 flex items-center gap-1.5">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                    (ticket as TicketDetail & { handled_by?: string }).handled_by?.startsWith("AI")
                      ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400"
                      : "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400"
                  }`}>
                    {(ticket as TicketDetail & { handled_by?: string }).handled_by?.startsWith("AI") ? (
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>
                    ) : (
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>
                    )}
                    {(ticket as TicketDetail & { handled_by?: string }).handled_by}
                  </span>
                </div>
              )}
              <select
                value={ticket.assigned_to || ""}
                onChange={(e) => handlePatch({ assigned_to: e.target.value || null, handled_by: null })}
                disabled={ticket.status === "archived"}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
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
                      className="max-w-[180px] truncate rounded-full bg-zinc-100 px-2 py-0.5 text-sm font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
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

        {/* ═══ CUSTOMER CARD ═══ */}
        <div className={`${mobileSection !== "customer" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        {customer && (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <button
              onClick={() => setCustomerCardOpen(!customerCardOpen)}
              className="flex w-full items-center justify-between p-4"
            >
              <h3 className="text-sm font-medium uppercase tracking-wider text-zinc-500">Customer</h3>
              <svg className={`h-4 w-4 text-zinc-400 transition-transform ${customerCardOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {customerCardOpen && (
            <div className="space-y-2 border-t border-zinc-100 px-4 pb-4 pt-3 dark:border-zinc-800">
              <div>
                <button
                  onClick={() => router.push(`/dashboard/customers/${customer.id}`)}
                  className="truncate text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {[customer.first_name, customer.last_name].filter(Boolean).join(" ") || customer.email}
                </button>
                <div className="mt-1">
                  <RetentionBadge score={customer.retention_score} />
                </div>
              </div>
              <p className="text-sm text-zinc-500">{customer.email}</p>
              {customer.phone && <p className="text-sm text-zinc-500">{customer.phone}</p>}
              {customer.subscriptions?.[0]?.id && (
                <a
                  href={`https://${(() => { /* resolve shop domain from workspace */ return "admin.shopify.com"; })()}/customers`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
                  View in Shopify
                </a>
              )}
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
              {/* Store Credit */}
              <div className="pt-1">
                <p className="text-sm text-zinc-400">Store Credit</p>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {storeCreditBalance !== null ? (storeCreditBalance > 0 ? `$${storeCreditBalance.toFixed(2)}` : "None") : "..."}
                  </p>
                  {["owner", "admin"].includes(workspace.role) && (
                    <button
                      onClick={() => setShowStoreCreditModal(true)}
                      className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-900/20 dark:text-indigo-400 dark:hover:bg-indigo-900/40"
                    >
                      Manage
                    </button>
                  )}
                </div>
              </div>

              {/* Marketing status */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div>
                  <p className="text-sm text-zinc-400">Email Marketing</p>
                  <p className="text-sm capitalize text-zinc-700 dark:text-zinc-300">{(customer as CustomerDetail & { email_marketing_status?: string }).email_marketing_status || "unknown"}</p>
                </div>
                <div>
                  <p className="text-sm text-zinc-400">SMS Marketing</p>
                  <p className="text-sm capitalize text-zinc-700 dark:text-zinc-300">{(customer as CustomerDetail & { sms_marketing_status?: string }).sms_marketing_status || "unknown"}</p>
                </div>
              </div>

              {/* Linked Identities — always show for agents */}
              <div className="pt-2">
                <button
                  onClick={() => setShowLinkSection(!showLinkSection)}
                  className="flex w-full items-center justify-between text-sm font-medium text-zinc-500"
                >
                  <span>
                    Linked Profiles
                    {customer.linked_identities?.length > 0 && ` (${customer.linked_identities.length})`}
                    {!customer.linked_identities?.length && linkSuggestions.length > 0 && (
                      <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-[10px] font-bold text-white">{linkSuggestions.length}</span>
                    )}
                  </span>
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
                          <span className="ml-1 rounded bg-indigo-100 px-1 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">primary</span>
                        )}
                      </button>
                    ))}
                    {linkSuggestions.length > 0 && (
                      <div className="mt-1">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Suggested matches</p>
                        {linkSuggestions.map((s) => (
                          <div key={s.id} className="mt-1 flex items-center justify-between rounded border border-amber-200 bg-amber-50 px-2 py-1.5 dark:border-amber-800 dark:bg-amber-950">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{s.email}</p>
                              <p className="text-xs text-zinc-500">{[s.first_name, s.last_name].filter(Boolean).join(" ")}</p>
                              <span className="rounded bg-amber-200 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-800 dark:text-amber-300">
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
                                  setLinkSuggestions((prev) => prev.filter((x) => x.id !== s.id));
                                  // Re-fetch ticket to get updated customer data with linked orders/subscriptions
                                  const refreshRes = await fetch(`/api/tickets/${ticket.id}`);
                                  if (refreshRes.ok) {
                                    const refreshData = await refreshRes.json();
                                    setCustomer(refreshData.customer);
                                  }
                                }
                              }}
                              className="ml-2 flex-shrink-0 rounded border border-indigo-300 px-1.5 py-0.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-950"
                            >
                              Link
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Manual search to link */}
                    <div className="mt-2">
                      <div className="flex gap-1">
                        <input
                          type="text"
                          placeholder="Search by email..."
                          className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                          onKeyDown={async (e) => {
                            if (e.key !== "Enter") return;
                            const input = e.currentTarget;
                            const query = input.value.trim();
                            if (!query) return;
                            const res = await fetch(`/api/customers?search=${encodeURIComponent(query)}&limit=5`);
                            if (!res.ok) return;
                            const data = await res.json();
                            const results = (data.customers || data || [])
                              .filter((c: { id: string }) => c.id !== customer.id && !customer.linked_identities?.some((li) => li.id === c.id))
                              .map((c: { id: string; email: string; first_name: string | null; last_name: string | null; phone: string | null }) => ({
                                ...c, match_reason: "Search result",
                              }));
                            setLinkSuggestions((prev) => {
                              const existing = new Set(prev.map((s) => s.id));
                              return [...prev, ...results.filter((r: { id: string }) => !existing.has(r.id))];
                            });
                            input.value = "";
                          }}
                        />
                      </div>
                      <p className="mt-0.5 text-[10px] text-zinc-400">Press Enter to search</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Ban/Unban — admin only */}
              {["owner", "admin"].includes(workspace.role) && (
                <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800">
                  <button
                    onClick={async () => {
                      const isBanned = (customer as CustomerDetail & { banned?: boolean }).banned;
                      if (!confirm(isBanned ? "Unban this customer?" : "Ban this customer? They will not receive AI responses.")) return;
                      await fetch(`/api/customers/${customer.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ banned: !isBanned }),
                      });
                      setCustomer((prev) => prev ? { ...prev, banned: !isBanned } as CustomerDetail : prev);
                    }}
                    className="text-xs text-red-500 hover:underline"
                  >
                    {(customer as CustomerDetail & { banned?: boolean }).banned ? "Unban customer" : "Ban customer"}
                  </button>
                </div>
              )}
            </div>
            )}
          </div>
        )}
        </div>

        {/* ═══ SUBSCRIPTIONS CARD ═══ */}
        <div className={`${mobileSection !== "subscriptions" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        {customer && customer.subscriptions?.length > 0 && (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <button
              onClick={() => setSubscriptionsCardOpen(!subscriptionsCardOpen)}
              className="flex w-full items-center justify-between p-4"
            >
              <h3 className="text-sm font-medium uppercase tracking-wider text-zinc-500">
                Subscriptions <span className="text-xs text-zinc-400">({customer.subscriptions.length})</span>
              </h3>
              <svg className={`h-4 w-4 text-zinc-400 transition-transform ${subscriptionsCardOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {subscriptionsCardOpen && (
            <div className="border-t border-zinc-100 px-4 pb-4 pt-3 dark:border-zinc-800">
              {customer.subscriptions.map((sub) => (
                <div key={sub.id}>
                  <SubscriptionsList subscriptions={[sub]} variant="compact" />

                  {/* Inline subscription actions */}
                  {(sub.status === "active" || sub.status === "paused") && (
                    <div className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-700">
                      {subActionPanel?.subId !== sub.id ? (
                        <div className="flex flex-col gap-1.5">
                          {sub.status === "active" && (
                            <>
                              <button onClick={() => { setSubActionPanel({ subId: sub.id, action: "skip" }); }} className="w-full rounded-md bg-zinc-100 px-3 py-2 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600">Skip Next Order</button>
                              <button onClick={() => { setSubActionPanel({ subId: sub.id, action: "bill_now" }); }} className="w-full rounded-md bg-zinc-100 px-3 py-2 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600">Order Now</button>
                              <button onClick={() => { setSubActionPanel({ subId: sub.id, action: "pause_30" }); }} className="w-full rounded-md bg-zinc-100 px-3 py-2 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600">Pause 30 Days</button>
                              <button onClick={() => { setSubActionPanel({ subId: sub.id, action: "pause_60" }); }} className="w-full rounded-md bg-zinc-100 px-3 py-2 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600">Pause 60 Days</button>
                            </>
                          )}
                          {sub.status === "paused" && (
                            <button onClick={() => handleSubAction(sub.id, "resume")} disabled={subActionLoading} className="w-full rounded-md bg-emerald-100 px-3 py-2 text-left text-sm font-medium text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400">Resume Subscription</button>
                          )}
                          <button onClick={() => { setSubActionPanel({ subId: sub.id, action: "change_next_date" }); setSubNextDate(sub.next_billing_date?.split("T")[0] || ""); }} className="w-full rounded-md bg-zinc-100 px-3 py-2 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600">Change Next Order Date</button>
                          <button onClick={() => { setSubActionPanel({ subId: sub.id, action: "apply_coupon" }); setSubCouponCode(""); }} className="w-full rounded-md bg-zinc-100 px-3 py-2 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600">Apply Coupon</button>
                          <button onClick={() => { setSubActionPanel({ subId: sub.id, action: "cancel" }); setSubCancelReason(""); }} className="w-full rounded-md bg-red-50 px-3 py-2 text-left text-sm font-medium text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400">Cancel Subscription</button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {/* Skip confirmation */}
                          {subActionPanel.action === "skip" && (
                            <div>
                              <p className="text-xs text-zinc-500">Skip next order?</p>
                              <div className="mt-1 flex gap-1.5">
                                <button disabled={subActionLoading} onClick={() => handleSubAction(sub.id, "skip")} className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{subActionLoading ? "..." : "Confirm"}</button>
                                <button onClick={() => setSubActionPanel(null)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
                              </div>
                            </div>
                          )}
                          {/* Bill now confirmation */}
                          {subActionPanel.action === "bill_now" && (
                            <div>
                              <p className="text-xs text-zinc-500">Process payment now?</p>
                              <div className="mt-1 flex gap-1.5">
                                <button disabled={subActionLoading} onClick={() => handleSubAction(sub.id, "bill_now")} className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{subActionLoading ? "..." : "Bill Now"}</button>
                                <button onClick={() => setSubActionPanel(null)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
                              </div>
                            </div>
                          )}
                          {/* Pause 30/60 */}
                          {(subActionPanel.action === "pause_30" || subActionPanel.action === "pause_60") && (
                            <div>
                              <p className="text-xs text-zinc-500">Pause for {subActionPanel.action === "pause_30" ? "30" : "60"} days?</p>
                              <div className="mt-1 flex gap-1.5">
                                <button disabled={subActionLoading} onClick={() => handleSubAction(sub.id, "pause", { days: subActionPanel.action === "pause_30" ? 30 : 60 })} className="rounded bg-amber-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50">{subActionLoading ? "..." : "Pause"}</button>
                                <button onClick={() => setSubActionPanel(null)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
                              </div>
                            </div>
                          )}
                          {/* Change next date */}
                          {subActionPanel.action === "change_next_date" && (
                            <div>
                              <p className="text-xs text-zinc-500">Change next order date</p>
                              <input
                                type="date"
                                value={subNextDate}
                                onChange={(e) => setSubNextDate(e.target.value)}
                                className="mt-1 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                              />
                              <div className="mt-1 flex gap-1.5">
                                <button disabled={subActionLoading || !subNextDate} onClick={() => handleSubAction(sub.id, "change_next_date", { next_billing_date: subNextDate })} className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{subActionLoading ? "..." : "Save"}</button>
                                <button onClick={() => setSubActionPanel(null)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
                              </div>
                            </div>
                          )}
                          {/* Apply coupon */}
                          {subActionPanel.action === "apply_coupon" && (
                            <div>
                              <p className="text-xs text-zinc-500">Apply coupon code</p>
                              <input
                                type="text"
                                value={subCouponCode}
                                onChange={(e) => setSubCouponCode(e.target.value)}
                                placeholder="Coupon code"
                                className="mt-1 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                              />
                              <div className="mt-1 flex gap-1.5">
                                <button disabled={subActionLoading || !subCouponCode.trim()} onClick={() => handleSubAction(sub.id, "apply_coupon", { code: subCouponCode.trim() })} className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{subActionLoading ? "..." : "Apply"}</button>
                                <button onClick={() => setSubActionPanel(null)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
                              </div>
                            </div>
                          )}
                          {/* Cancel subscription */}
                          {subActionPanel.action === "cancel" && (
                            <div>
                              <p className="text-xs font-medium text-red-600 dark:text-red-400">Cancel subscription</p>
                              <input
                                type="text"
                                value={subCancelReason}
                                onChange={(e) => setSubCancelReason(e.target.value)}
                                placeholder="Reason (optional)"
                                className="mt-1 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                              />
                              <div className="mt-1 flex gap-1.5">
                                <button disabled={subActionLoading} onClick={() => { if (confirm("Cancel this subscription?")) handleSubAction(sub.id, "cancel", { reason: subCancelReason || undefined }); }} className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">{subActionLoading ? "..." : "Confirm Cancel"}</button>
                                <button onClick={() => setSubActionPanel(null)} className="text-xs text-zinc-400 hover:text-zinc-600">Back</button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {/* Action result message */}
                      {subActionResult?.subId === sub.id && (
                        <p className={`mt-1 text-xs font-medium ${subActionResult.success ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                          {subActionResult.message}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            )}
          </div>
        )}
        </div>

        {/* ═══ ORDERS CARD ═══ */}
        <div className={`${mobileSection !== "orders" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        {customer && customer.recent_orders.length > 0 && (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <button
              onClick={() => setOrdersCardOpen(!ordersCardOpen)}
              className="flex w-full items-center justify-between p-4"
            >
              <h3 className="text-sm font-medium uppercase tracking-wider text-zinc-500">
                Orders <span className="text-xs text-zinc-400">({customer.recent_orders.length})</span>
              </h3>
              <svg className={`h-4 w-4 text-zinc-400 transition-transform ${ordersCardOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {ordersCardOpen && (
            <div className="space-y-1 border-t border-zinc-100 px-4 pb-4 pt-3 dark:border-zinc-800">
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
                        {(() => {
                          const ss = getOrderShippingStatus(o);
                          return <span className={`rounded px-1.5 py-0.5 text-sm font-medium ${ss.classes}`}>{ss.label}</span>;
                        })()}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-sm text-zinc-400">
                        <span>{formatDate(o.created_at)}</span>
                        <a
                          href={`/dashboard/orders/${o.id}`}
                          onClick={e => e.stopPropagation()}
                          className="text-indigo-500 hover:text-indigo-400"
                        >
                          View
                        </a>
                        {shopifyDomain && o.shopify_order_id && (
                          <a
                            href={`https://${shopifyDomain}/admin/orders/${o.shopify_order_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="text-zinc-500 hover:text-zinc-300"
                          >
                            Shopify
                          </a>
                        )}
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
                      {/* Shipping address */}
                      {o.shipping_address?.address1 && (
                        <div className="mt-1.5 text-xs text-zinc-400">
                          <span className="font-medium text-zinc-500">Ship to: </span>
                          {[o.shipping_address.address1, o.shipping_address.city, o.shipping_address.provinceCode || o.shipping_address.province, o.shipping_address.zip].filter(Boolean).join(", ")}
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

                      {/* Order Action Buttons */}
                      {o.shopify_order_id && (
                        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-zinc-200 pt-2 dark:border-zinc-700">
                          {(o.financial_status === "paid" || o.financial_status === "partially_refunded") && (
                            <button
                              onClick={() => { setOrderActionPanel({ orderId: o.id, action: "refund" }); setRefundFull(true); setOrderActionError(null); setOrderActionSuccess(null); }}
                              className="rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40"
                            >
                              Refund
                            </button>
                          )}
                          {(!o.fulfillment_status || o.fulfillment_status === "unfulfilled") && (
                            <>
                              <button
                                onClick={() => { setOrderActionPanel({ orderId: o.id, action: "cancel" }); setCancelReason("CUSTOMER"); setCancelRefund(true); setCancelRestock(true); setOrderActionError(null); setOrderActionSuccess(null); }}
                                className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-600 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-400 dark:hover:bg-amber-900/40"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => { setOrderActionPanel({ orderId: o.id, action: "edit_address" }); setAddressForm({ address1: "", address2: "", city: "", province: "", zip: "", country: "US" }); setOrderActionError(null); setOrderActionSuccess(null); }}
                                className="rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:hover:bg-blue-900/40"
                              >
                                Edit Address
                              </button>
                            </>
                          )}
                        </div>
                      )}

                      {/* Order Action Success */}
                      {orderActionSuccess && orderActionPanel === null && (
                        <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">{orderActionSuccess}</p>
                      )}

                      {/* Refund Form */}
                      {orderActionPanel?.orderId === o.id && orderActionPanel.action === "refund" && (
                        <div className="mt-2 space-y-2 rounded border border-red-200 bg-red-50/50 p-2 dark:border-red-800 dark:bg-red-900/10">
                          <p className="text-xs font-medium text-red-700 dark:text-red-400">Refund Order #{o.order_number}</p>
                          <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                            <input type="checkbox" checked={refundFull} onChange={(e) => setRefundFull(e.target.checked)} className="rounded" />
                            Full refund ({formatCents(o.total_cents)})
                          </label>
                          {orderActionError && <p className="text-xs text-red-600">{orderActionError}</p>}
                          <div className="flex gap-1.5">
                            <button
                              disabled={orderActionLoading}
                              onClick={() => {
                                if (confirm(`Refund ${refundFull ? formatCents(o.total_cents) : "selected items"} to customer?`)) {
                                  handleOrderAction(o, "refund", { full: refundFull });
                                }
                              }}
                              className="rounded bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                            >
                              {orderActionLoading ? "Processing..." : "Confirm Refund"}
                            </button>
                            <button onClick={() => setOrderActionPanel(null)} className="rounded px-2.5 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Cancel Form */}
                      {orderActionPanel?.orderId === o.id && orderActionPanel.action === "cancel" && (
                        <div className="mt-2 space-y-2 rounded border border-amber-200 bg-amber-50/50 p-2 dark:border-amber-800 dark:bg-amber-900/10">
                          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Cancel Order #{o.order_number}</p>
                          <div>
                            <label className="block text-xs text-zinc-500 mb-1">Reason</label>
                            <select
                              value={cancelReason}
                              onChange={(e) => setCancelReason(e.target.value as "CUSTOMER" | "INVENTORY" | "OTHER")}
                              className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                            >
                              <option value="CUSTOMER">Customer request</option>
                              <option value="INVENTORY">Out of stock</option>
                              <option value="OTHER">Other</option>
                            </select>
                          </div>
                          <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                            <input type="checkbox" checked={cancelRefund} onChange={(e) => setCancelRefund(e.target.checked)} className="rounded" />
                            Refund payment
                          </label>
                          <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                            <input type="checkbox" checked={cancelRestock} onChange={(e) => setCancelRestock(e.target.checked)} className="rounded" />
                            Restock items
                          </label>
                          {orderActionError && <p className="text-xs text-red-600">{orderActionError}</p>}
                          <div className="flex gap-1.5">
                            <button
                              disabled={orderActionLoading}
                              onClick={() => {
                                if (confirm(`Cancel order #${o.order_number}?`)) {
                                  handleOrderAction(o, "cancel", { reason: cancelReason, refund: cancelRefund, restock: cancelRestock });
                                }
                              }}
                              className="rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                            >
                              {orderActionLoading ? "Processing..." : "Confirm Cancel"}
                            </button>
                            <button onClick={() => setOrderActionPanel(null)} className="rounded px-2.5 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                              Back
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Edit Address Form */}
                      {orderActionPanel?.orderId === o.id && orderActionPanel.action === "edit_address" && (
                        <div className="mt-2 space-y-2 rounded border border-blue-200 bg-blue-50/50 p-2 dark:border-blue-800 dark:bg-blue-900/10">
                          <p className="text-xs font-medium text-blue-700 dark:text-blue-400">Edit Shipping Address</p>
                          <input
                            placeholder="Address line 1"
                            value={addressForm.address1}
                            onChange={(e) => setAddressForm((f) => ({ ...f, address1: e.target.value }))}
                            className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                          />
                          <input
                            placeholder="Address line 2 (optional)"
                            value={addressForm.address2}
                            onChange={(e) => setAddressForm((f) => ({ ...f, address2: e.target.value }))}
                            className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                          />
                          <div className="flex gap-1.5">
                            <input
                              placeholder="City"
                              value={addressForm.city}
                              onChange={(e) => setAddressForm((f) => ({ ...f, city: e.target.value }))}
                              className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                            />
                            <input
                              placeholder="State"
                              value={addressForm.province}
                              onChange={(e) => setAddressForm((f) => ({ ...f, province: e.target.value }))}
                              className="w-16 rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                            />
                          </div>
                          <div className="flex gap-1.5">
                            <input
                              placeholder="ZIP"
                              value={addressForm.zip}
                              onChange={(e) => setAddressForm((f) => ({ ...f, zip: e.target.value }))}
                              className="w-24 rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                            />
                            <input
                              placeholder="Country (US)"
                              value={addressForm.country}
                              onChange={(e) => setAddressForm((f) => ({ ...f, country: e.target.value }))}
                              className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                            />
                          </div>
                          {orderActionError && <p className="text-xs text-red-600">{orderActionError}</p>}
                          <div className="flex gap-1.5">
                            <button
                              disabled={orderActionLoading || !addressForm.address1 || !addressForm.city || !addressForm.province || !addressForm.zip}
                              onClick={() => handleOrderAction(o, "update_address", { address: addressForm })}
                              className="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                              {orderActionLoading ? "Saving..." : "Save Address"}
                            </button>
                            <button onClick={() => setOrderActionPanel(null)} className="rounded px-2.5 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            )}
          </div>
        )}
        </div>

        {/* ═══ RETURNS CARD ═══ */}
        <div className={`${mobileSection !== "returns" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        {ticketReturns.length > 0 && (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <button
              onClick={() => setReturnsCardOpen(!returnsCardOpen)}
              className="flex w-full items-center justify-between p-4"
            >
              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                Returns <span className="text-xs text-zinc-400">({ticketReturns.length})</span>
              </h3>
              <svg className={`h-4 w-4 text-zinc-400 transition-transform ${returnsCardOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {returnsCardOpen && (
              <div className="border-t border-zinc-100 px-4 pb-3 dark:border-zinc-800">
                <ReturnsList returns={ticketReturns} variant="compact" />
              </div>
            )}
          </div>
        )}
        </div>

        {/* ═══ REPLACEMENTS ═══ */}
        {ticketReplacements.length > 0 && (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <button
              onClick={() => setReplacementsCardOpen(!replacementsCardOpen)}
              className="flex w-full items-center justify-between p-4"
            >
              <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Replacements <span className="text-xs text-zinc-400">({ticketReplacements.length})</span>
              </h3>
              <svg className={`h-4 w-4 text-zinc-400 transition-transform ${replacementsCardOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {replacementsCardOpen && (
              <div className="border-t border-zinc-100 px-4 pb-3 dark:border-zinc-800">
                <ReplacementsList replacements={ticketReplacements} compact />
              </div>
            )}
          </div>
        )}

        {/* ═══ CHARGEBACKS ═══ */}
        <div className={`${mobileSection !== "chargebacks" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        {chargebacks.length > 0 && (
          <div className="mt-4 rounded-lg border border-red-200 bg-white dark:border-red-800 dark:bg-zinc-900">
            <div className="p-4">
              <h3 className="text-xs font-medium uppercase tracking-wider text-red-500">
                Chargebacks <span className="text-xs text-red-400">({chargebacks.length})</span>
              </h3>
            </div>
            <div className="border-t border-red-100 px-4 pb-3 dark:border-red-900">
              <ChargebacksList chargebacks={chargebacks} compact />
            </div>
          </div>
        )}
        </div>

        {/* ═══ FRAUD ═══ */}
        <div className={`${mobileSection !== "fraud" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        {fraudCases.length > 0 && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-white dark:border-amber-800 dark:bg-zinc-900">
            <div className="p-4">
              <h3 className="text-xs font-medium uppercase tracking-wider text-amber-500">
                Fraud Cases <span className="text-xs text-amber-400">({fraudCases.length})</span>
              </h3>
            </div>
            <div className="border-t border-amber-100 px-4 pb-3 dark:border-amber-900">
              <FraudCasesList cases={fraudCases} compact />
            </div>
          </div>
        )}
        </div>

        {/* ═══ LOYALTY CARD ═══ */}
        <div className={`${mobileSection !== "loyalty" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        {loyaltyMember && loyaltySettings && (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <button
              onClick={() => setLoyaltyCardOpen(!loyaltyCardOpen)}
              className="flex w-full items-center justify-between p-4"
            >
              <h3 className="text-sm font-medium uppercase tracking-wider text-zinc-500">
                Loyalty <span className="text-xs font-semibold text-purple-600 dark:text-purple-400">{loyaltyMember.points_balance.toLocaleString()} pts</span>
              </h3>
              <svg className={`h-4 w-4 text-zinc-400 transition-transform ${loyaltyCardOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {loyaltyCardOpen && (
            <div className="space-y-2 border-t border-zinc-100 px-4 pb-4 pt-3 dark:border-zinc-800">
              <LoyaltyCard
                member={loyaltyMember}
                tiers={loyaltySettings.redemption_tiers}
                workspaceId={workspace.id}
                variant="compact"
                redemptions={loyaltyRedemptions}
                onRedeem={(newBalance, code, value, pointsCost) => {
                  setLoyaltyMember((prev) => prev ? { ...prev, points_balance: newBalance } : prev);
                  setLoyaltyRedemptions(prev => [{ id: crypto.randomUUID(), discount_code: code, discount_value: value, points_spent: pointsCost, status: "active", used_at: null, expires_at: null, created_at: new Date().toISOString() }, ...prev]);
                }}
              />
            </div>
            )}
          </div>
        )}
        </div>

        {/* ═══ REVIEWS CARD ═══ */}
        <div className={`${mobileSection !== "reviews" && mobileSection !== "conversation" ? "hidden md:block" : ""}`}>
        {customer?.reviews && customer.reviews.length > 0 && (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="text-sm font-medium uppercase tracking-wider text-zinc-500">Reviews &amp; Ratings</h3>
            <div className="mt-2 space-y-1">
              {customer.reviews.map((rv) => (
                <div key={rv.id} className="rounded bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800">
                  <div className="flex items-center gap-1.5">
                    <div className="flex gap-0.5">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <svg key={i} className={`h-3 w-3 ${i < (rv.rating || 0) ? "text-yellow-400" : "text-zinc-200 dark:text-zinc-700"}`} fill="currentColor" viewBox="0 0 20 20">
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                      ))}
                    </div>
                    {rv.featured && (
                      <span className="rounded bg-indigo-100 px-1 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">Featured</span>
                    )}
                    <span className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">
                      {rv.review_type === "store" ? "Site" : rv.review_type === "rating" ? "Rating" : "Product"}
                    </span>
                  </div>
                  {rv.product_name && (
                    <p className="mt-0.5 text-xs text-zinc-400 truncate">{rv.product_name}</p>
                  )}
                  {rv.title && (
                    <p className="mt-0.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 truncate">{rv.title}</p>
                  )}
                  {rv.body && (
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2">{rv.body}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        </div>
      </div>

      {/* Store Credit Modal */}
      {showStoreCreditModal && customer && (
        <StoreCreditModal
          customerId={customer.id}
          currentBalance={storeCreditBalance ?? 0}
          ticketId={id}
          onClose={() => setShowStoreCreditModal(false)}
          onSuccess={(newBalance) => {
            setStoreCreditBalance(newBalance);
            setShowStoreCreditModal(false);
            // Refresh messages to show internal note
            fetch(`/api/tickets/${id}`).then(r => r.json()).then(data => {
              if (data.messages) setMessages(data.messages);
            });
          }}
        />
      )}

      {/* Email preview modal */}
      {emailPreview && (
        <EmailPreviewModal
          html={emailPreview.html}
          subject={emailPreview.subject}
          to={emailPreview.to}
          sentAt={emailPreview.sentAt}
          isOpen={!!emailPreview}
          onClose={() => setEmailPreview(null)}
        />
      )}
    </div>
  );
}

function JourneySuggestionCard({
  journeyId,
  journeyName,
  ticketId,
  onSent,
}: {
  journeyId: string;
  journeyName: string;
  ticketId: string;
  onSent: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    setSending(true);
    const res = await fetch(`/api/tickets/${ticketId}/send-journey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ journeyId }),
    });
    if (res.ok) {
      setSent(true);
      onSent();
    }
    setSending(false);
  };

  return (
    <div className="mx-auto max-w-[85%] rounded-lg border border-cyan-200 bg-cyan-50/50 p-4 dark:border-cyan-800 dark:bg-cyan-950/20">
      <div className="flex items-center gap-2 text-sm">
        <svg className="h-4 w-4 shrink-0 text-cyan-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="font-medium text-cyan-700 dark:text-cyan-400">Journey Detected</span>
      </div>
      <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
        Customer&apos;s message matches the <strong>{journeyName}</strong> journey. Send it to guide them through the flow automatically.
      </p>
      {sent ? (
        <p className="mt-2 text-sm font-medium text-emerald-600">Journey sent!</p>
      ) : (
        <button
          onClick={handleSend}
          disabled={sending}
          className="mt-3 rounded-md bg-cyan-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
        >
          {sending ? "Sending..." : `Send "${journeyName}" Journey`}
        </button>
      )}
    </div>
  );
}

// ── Share Ticket Button + Modal ──

function ShareTicketButton({ ticketId, workspaceId }: { ticketId: string; workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"link" | "slack">("link");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [slackData, setSlackData] = useState<{
    slackConnected: boolean;
    members: { userId: string; name: string; slackUserId: string }[];
    channels: { id: string; name: string }[];
  } | null>(null);
  const [target, setTarget] = useState("");
  const [targetType, setTargetType] = useState<"member" | "channel">("member");
  const [message, setMessage] = useState("");
  const [mentionIds, setMentionIds] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState("");

  const ticketUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/dashboard/tickets/${ticketId}`;

  const handleOpen = async () => {
    setOpen(true);
    if (!slackData) {
      setLoading(true);
      try {
        const res = await fetch(`/api/tickets/${ticketId}/share`);
        if (res.ok) setSlackData(await res.json());
      } catch { /* */ }
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(ticketUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSend = async () => {
    if (!target) return;
    setSending(true);
    setResult("");
    try {
      const res = await fetch(`/api/tickets/${ticketId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          message: message || undefined,
          mentionUserIds: targetType === "channel" ? Array.from(mentionIds) : undefined,
        }),
      });
      if (res.ok) {
        setResult("Shared!");
        setTimeout(() => { setOpen(false); setResult(""); setMessage(""); setTarget(""); setMentionIds(new Set()); }, 1500);
      } else {
        const data = await res.json();
        setResult(data.error || "Failed to share");
      }
    } catch {
      setResult("Failed to share");
    }
    setSending(false);
  };

  return (
    <div className="mb-4">
      <button
        onClick={handleOpen}
        className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
      >
        Share Ticket
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl dark:bg-zinc-900" onClick={e => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Share Ticket</h3>
              <button onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-600">&times;</button>
            </div>

            {/* Tabs */}
            <div className="mb-4 flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
              <button
                onClick={() => setTab("link")}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tab === "link" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100" : "text-zinc-500"}`}
              >
                Copy Link
              </button>
              <button
                onClick={() => setTab("slack")}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tab === "slack" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100" : "text-zinc-500"}`}
              >
                Slack
              </button>
            </div>

            {/* Copy Link Tab */}
            {tab === "link" && (
              <div>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={ticketUrl}
                    className="flex-1 truncate rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-xs font-mono text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
                  />
                  <button
                    onClick={handleCopy}
                    className="shrink-0 rounded-md bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500"
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
            )}

            {/* Slack Tab */}
            {tab === "slack" && (
              <div className="space-y-3">
                {loading ? (
                  <p className="text-sm text-zinc-400">Loading Slack data...</p>
                ) : !slackData?.slackConnected ? (
                  <p className="text-sm text-zinc-400">Slack is not connected. Connect it in Settings &rarr; Integrations.</p>
                ) : (
                  <>
                    {/* Member vs Channel toggle */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setTargetType("member"); setTarget(""); setMentionIds(new Set()); }}
                        className={`rounded-md px-3 py-1 text-xs font-medium ${targetType === "member" ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
                      >
                        Person
                      </button>
                      <button
                        onClick={() => { setTargetType("channel"); setTarget(""); }}
                        className={`rounded-md px-3 py-1 text-xs font-medium ${targetType === "channel" ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
                      >
                        Channel
                      </button>
                    </div>

                    {/* Target selector */}
                    <select
                      value={target}
                      onChange={e => setTarget(e.target.value)}
                      className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    >
                      <option value="">Select {targetType === "member" ? "person" : "channel"}...</option>
                      {targetType === "member"
                        ? slackData.members.map(m => <option key={m.slackUserId} value={m.slackUserId}>{m.name}</option>)
                        : slackData.channels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)
                      }
                    </select>

                    {/* Mention selector for channels */}
                    {targetType === "channel" && slackData.members.length > 0 && (
                      <div>
                        <label className="mb-1 block text-xs text-zinc-500">Tag people (optional)</label>
                        <div className="flex flex-wrap gap-1.5">
                          {slackData.members.map(m => (
                            <button
                              key={m.slackUserId}
                              onClick={() => setMentionIds(prev => {
                                const next = new Set(prev);
                                next.has(m.slackUserId) ? next.delete(m.slackUserId) : next.add(m.slackUserId);
                                return next;
                              })}
                              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                                mentionIds.has(m.slackUserId)
                                  ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400"
                                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                              }`}
                            >
                              {m.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Message */}
                    <textarea
                      value={message}
                      onChange={e => setMessage(e.target.value)}
                      placeholder="Add a message (optional)"
                      rows={2}
                      className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm placeholder-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    />

                    {/* Send */}
                    <button
                      onClick={handleSend}
                      disabled={!target || sending}
                      className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {sending ? "Sending..." : "Share via Slack"}
                    </button>

                    {result && (
                      <p className={`text-sm ${result === "Shared!" ? "text-green-600" : "text-red-600"}`}>{result}</p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
