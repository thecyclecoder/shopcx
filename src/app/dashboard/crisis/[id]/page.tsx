"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

interface CrisisEvent {
  id: string;
  name: string;
  status: string;
  affected_variant_id: string;
  affected_sku: string | null;
  affected_product_title: string | null;
  default_swap_variant_id: string | null;
  default_swap_title: string | null;
  available_flavor_swaps: { variantId: string; title: string }[];
  available_product_swaps: { variantId: string; title: string; productTitle: string }[];
  tier2_coupon_code: string | null;
  tier2_coupon_percent: number;
  expected_restock_date: string | null;
  lead_time_days: number;
  tier_wait_days: number;
  created_at: string;
  updated_at: string;
}

interface CrisisAction {
  id: string;
  crisis_id: string;
  customer_id: string;
  subscription_id: string | null;
  segment: string;
  current_tier: number;
  tier1_response: string | null;
  tier2_response: string | null;
  tier3_response: string | null;
  paused_at: string | null;
  removed_item_at: string | null;
  cancelled: boolean;
  created_at: string;
  customers: { id: string; first_name: string; last_name: string; email: string } | null;
}

interface Stats {
  total: number;
  by_segment: { berry_only: number; berry_plus: number };
  tier1: { sent: number; accepted: number; rejected: number; pending: number };
  tier2: { sent: number; accepted: number; rejected: number; pending: number };
  tier3: { sent: number; accepted: number; rejected: number; pending: number };
  paused: number;
  removed: number;
  cancelled: number;
}

interface FinancialImpact {
  affected_subscriptions: number;
  monthly_revenue_at_risk: number;
  months_at_risk: number;
  total_revenue_at_risk: number;
  annual_revenue_at_risk: number;
  saved_count: number;
  lost_count: number;
}

interface CouponDetails {
  found: boolean;
  code: string;
  title: string;
  status: string;
  type: string;
  percentage: number | null;
  fixed_amount: string | null;
  currency_code: string | null;
  summary: string;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  usage_count: number | null;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  resolved: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
};

const STATUSES = ["draft", "active", "paused", "resolved"] as const;

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function getActionResponse(a: CrisisAction): string {
  if (a.cancelled) return "Cancelled";
  if (a.tier3_response === "accepted_pause") return "Paused";
  if (a.tier3_response === "accepted_remove") return "Removed item";
  if (a.tier3_response === "rejected") return "Tier 3 rejected";
  if (a.tier2_response === "accepted_swap") return "Product swap";
  if (a.tier2_response === "rejected") return "Tier 2 rejected";
  if (a.tier1_response === "accepted_swap") return "Flavor swap";
  if (a.tier1_response === "rejected") return "Tier 1 rejected";
  if (a.current_tier > 0) return "Pending";
  return "Not started";
}

export default function CrisisDetailPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const { id: crisisId } = useParams<{ id: string }>();

  const [crisis, setCrisis] = useState<CrisisEvent | null>(null);
  const [actions, setActions] = useState<CrisisAction[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [impact, setImpact] = useState<FinancialImpact | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");

  // Editable fields
  const [editName, setEditName] = useState("");
  const [editRestockDate, setEditRestockDate] = useState("");
  const [editLeadTime, setEditLeadTime] = useState(7);
  const [editTierWait, setEditTierWait] = useState(3);
  const [editCouponCode, setEditCouponCode] = useState("");

  // Coupon lookup
  const isAdmin = workspace.role === "owner" || workspace.role === "admin";

  // Coupon lookup
  const [couponInput, setCouponInput] = useState("");
  const [couponLooking, setCouponLooking] = useState(false);
  const [couponDetails, setCouponDetails] = useState<CouponDetails | null>(null);
  const [couponError, setCouponError] = useState("");

  // Test campaign
  const [testSubs, setTestSubs] = useState<{ id: string; contractId: string; items: string; status: string; nextDate: string }[]>([]);
  const [testSubId, setTestSubId] = useState("");
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; customer_email?: string; journey_url?: string; segment?: string; error?: string } | null>(null);
  const [testSubsLoaded, setTestSubsLoaded] = useState(false);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/crisis/${crisisId}`);
    if (res.ok) {
      const data = await res.json();
      setCrisis(data.crisis);
      setActions(data.actions || []);
      setStats(data.stats);
      setImpact(data.financialImpact || null);
    }
    setLoading(false);
  }, [workspace.id, crisisId]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  useEffect(() => {
    if (crisis) {
      setEditName(crisis.name);
      setEditRestockDate(crisis.expected_restock_date || "");
      setEditLeadTime(crisis.lead_time_days);
      setEditTierWait(crisis.tier_wait_days);
      setEditCouponCode(crisis.tier2_coupon_code || "");
    }
  }, [crisis]);

  const handleStatusChange = async (newStatus: string) => {
    const res = await fetch(`/api/workspaces/${workspace.id}/crisis/${crisisId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCrisis(updated);
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    setError("");
    const res = await fetch(`/api/workspaces/${workspace.id}/crisis/${crisisId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editName,
        expected_restock_date: editRestockDate || null,
        lead_time_days: editLeadTime,
        tier2_coupon_code: editCouponCode || null,
      }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCrisis(updated);
      setEditing(false);
    } else {
      const data = await res.json();
      setError(data.error || "Failed to update");
    }
    setSaving(false);
  };

  const handleResolve = async () => {
    if (!confirm("Resolve this crisis? This will auto-resume paused subs and re-add removed items.")) return;
    setResolving(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/crisis/${crisisId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolve" }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCrisis(updated);
    }
    setResolving(false);
  };

  const lookupCoupon = async () => {
    if (!couponInput.trim()) return;
    setCouponLooking(true);
    setCouponError("");
    setCouponDetails(null);
    const res = await fetch(`/api/workspaces/${workspace.id}/crisis/${crisisId}/coupon-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: couponInput.trim() }),
    });
    if (res.ok) {
      const data = await res.json();
      setCouponDetails(data);
      // Auto-populate coupon code
      setEditCouponCode(data.code);
    } else {
      const data = await res.json();
      setCouponError(data.error || "Code not found");
    }
    setCouponLooking(false);
  };

  const applyCoupon = async () => {
    if (!couponDetails) return;
    setSaving(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/crisis/${crisisId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier2_coupon_code: couponDetails.code,
        tier2_coupon_percent: couponDetails.percentage || 0,
      }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCrisis(updated);
      setCouponDetails(null);
      setCouponInput("");
    }
    setSaving(false);
  };

  if (loading) {
    return <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6"><p className="text-zinc-400">Loading...</p></div>;
  }

  if (!crisis) {
    return <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6"><p className="text-zinc-400">Crisis event not found.</p></div>;
  }

  const inputClass = "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100";
  const labelClass = "block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1";

  const savedPct = impact && impact.affected_subscriptions > 0
    ? Math.round((impact.saved_count / impact.affected_subscriptions) * 100)
    : 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <Link href="/dashboard/crisis" className="text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
          &larr; Back to Crisis Management
        </Link>
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{crisis.name}</h1>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_COLORS[crisis.status]}`}>
              {crisis.status}
            </span>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2">
              {crisis.status !== "resolved" && (
                <button
                  onClick={handleResolve}
                  disabled={resolving}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {resolving ? "Resolving..." : "Resolve Crisis"}
                </button>
              )}
            </div>
          )}
        </div>
        {crisis.affected_product_title && (
          <p className="mt-1 text-sm text-zinc-500">Affected: {crisis.affected_product_title}</p>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Status toggle — admin/owner only */}
      {isAdmin && crisis.status !== "resolved" && (
        <div className="mb-6 flex items-center gap-2">
          <span className="text-sm text-zinc-500">Status:</span>
          {STATUSES.filter(s => s !== "resolved").map(s => (
            <button
              key={s}
              onClick={() => handleStatusChange(s)}
              className={`rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors ${
                crisis.status === s
                  ? "bg-indigo-600 text-white"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* ── Test Campaign (draft only, admin/owner) ── */}
      {isAdmin && crisis.status === "draft" && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-6 dark:border-amber-800 dark:bg-amber-900/20">
          <h2 className="mb-2 text-lg font-semibold text-amber-800 dark:text-amber-300">Test Campaign</h2>
          <p className="mb-4 text-sm text-amber-700 dark:text-amber-400">
            Run the full Tier 1 flow on a single subscription while in draft mode. This will auto-swap the item, send the email, and create the journey — exactly like the real campaign.
          </p>
          {!testSubsLoaded ? (
            <button
              onClick={async () => {
                setTestLoading(true);
                // Fetch current user's subscriptions with the affected item
                const res = await fetch(`/api/workspaces/${workspace.id}/crisis/${crisisId}/test`);
                if (res.ok) {
                  const data = await res.json();
                  const subs = (data.subscriptions || []) as { id: string; shopify_contract_id: string; items: { title: string; sku?: string; variant_id?: string }[]; status: string; next_billing_date: string }[];
                  setTestSubs(subs.map(s => ({
                    id: s.id,
                    contractId: s.shopify_contract_id,
                    items: (s.items || []).filter(i => !i.title?.toLowerCase().includes("shipping protection")).map(i => i.title).join(", "),
                    status: s.status,
                    nextDate: s.next_billing_date ? new Date(s.next_billing_date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—",
                  })));
                  setTestSubsLoaded(true);
                }
                setTestLoading(false);
              }}
              disabled={testLoading}
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              {testLoading ? "Loading subscriptions..." : "Find Test Subscriptions"}
            </button>
          ) : testSubs.length === 0 ? (
            <p className="text-sm text-amber-600 dark:text-amber-400">No active subscriptions found with the affected item.</p>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">
                  Select a subscription to test ({testSubs.length} found with affected item)
                </label>
                <select
                  value={testSubId}
                  onChange={e => { setTestSubId(e.target.value); setTestResult(null); }}
                  className="w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-amber-700 dark:bg-zinc-800 dark:text-zinc-100"
                >
                  <option value="">Select subscription...</option>
                  {testSubs.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.items} — {s.status} (next: {s.nextDate})
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={async () => {
                  if (!testSubId) return;
                  setTestLoading(true);
                  setTestResult(null);
                  const res = await fetch(`/api/workspaces/${workspace.id}/crisis/${crisisId}/test`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ subscription_id: testSubId }),
                  });
                  const data = await res.json();
                  setTestResult(res.ok ? data : { success: false, error: data.error || "Test failed" });
                  setTestLoading(false);
                  if (res.ok) fetchDetail(); // Refresh stats
                }}
                disabled={testLoading || !testSubId}
                className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
              >
                {testLoading ? "Running test..." : "Run Test"}
              </button>
              {testResult && (
                <div className={`rounded-md p-3 text-sm ${testResult.success
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                  : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
                }`}>
                  {testResult.success ? (
                    <div>
                      <p className="font-medium">Test sent successfully!</p>
                      <p>Email sent to: {testResult.customer_email}</p>
                      <p>Segment: {testResult.segment === "berry_only" ? "Single item (berry only)" : "Multi item (berry + others)"}</p>
                      <p>
                        Journey:{" "}
                        <a href={testResult.journey_url} target="_blank" rel="noopener noreferrer" className="underline">
                          Open journey →
                        </a>
                      </p>
                    </div>
                  ) : (
                    <p>{testResult.error}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Financial Impact — owner only ── */}
      {workspace.role === "owner" && impact && (
        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Financial Impact</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <ImpactCard
              label="Affected Subscriptions"
              value={impact.affected_subscriptions.toLocaleString()}
              color="zinc"
            />
            <ImpactCard
              label="Monthly Revenue at Risk"
              value={formatMoney(impact.monthly_revenue_at_risk)}
              color="amber"
            />
            <ImpactCard
              label={`${impact.months_at_risk} Month${impact.months_at_risk !== 1 ? "s" : ""} Revenue at Risk`}
              value={formatMoney(impact.total_revenue_at_risk)}
              color="red"
            />
            <ImpactCard
              label="Annual Revenue at Risk"
              value={formatMoney(impact.annual_revenue_at_risk)}
              color="red"
            />
            <ImpactCard
              label="Save Rate"
              value={stats && stats.total > 0 ? `${savedPct}%` : "---"}
              sub={impact.saved_count > 0 ? `${impact.saved_count} saved, ${impact.lost_count} lost` : undefined}
              color={savedPct >= 70 ? "emerald" : savedPct >= 40 ? "amber" : "red"}
            />
          </div>
          {crisis.expected_restock_date && (
            <p className="mt-3 text-xs text-zinc-400">
              Based on expected restock date of {formatDate(crisis.expected_restock_date)}. Revenue calculated from current subscription billing amounts.
            </p>
          )}
        </div>
      )}

      {/* ── How It Works (Steps Outline) ── */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">How the Campaign Works</h2>
        <div className="space-y-4">
          <StepOutline
            number={1}
            title="Automatic Flavor Swap + Notification"
            description={`When a customer's next billing date is within ${crisis.lead_time_days} days, we automatically swap ${crisis.affected_product_title || "the affected item"} to ${crisis.default_swap_title || "the default swap"} and email them. They can pick a different flavor if they prefer.`}
            timing={`${crisis.lead_time_days} days before billing`}
            status={stats ? `${stats.tier1.sent} sent, ${stats.tier1.accepted} accepted, ${stats.tier1.rejected} rejected, ${stats.tier1.pending} pending` : undefined}
          />
          <StepOutline
            number={2}
            title={`Product Swap Offer${crisis.tier2_coupon_percent ? ` + ${crisis.tier2_coupon_percent}% Off` : ""}`}
            description={`If they reject the flavor swap, we offer them a completely different product${crisis.tier2_coupon_percent ? ` with ${crisis.tier2_coupon_percent}% off their next order` : ""} on the next campaign run.${crisis.tier2_coupon_code ? ` Code: ${crisis.tier2_coupon_code}` : ""}`}
            timing="Next day after Tier 1 rejection"
            status={stats ? `${stats.tier2.sent} sent, ${stats.tier2.accepted} accepted, ${stats.tier2.rejected} rejected, ${stats.tier2.pending} pending` : undefined}
          />
          <StepOutline
            number={3}
            title="Pause or Remove Item"
            description="If they reject the product swap too, we offer to pause their subscription (single-item subs) or remove the affected item (multi-item subs) with automatic restart when the product is back in stock."
            timing="Next day after Tier 2 rejection"
            status={stats ? `${stats.tier3.sent} sent, ${stats.paused} paused, ${stats.removed} removed, ${stats.cancelled} cancelled` : undefined}
          />
          <StepOutline
            number={4}
            title="Resolution"
            description="When the product is back in stock, click 'Resolve Crisis' to automatically resume paused subscriptions and re-add removed items. Customers who swapped flavors/products can be offered a chance to swap back."
            timing="When you click Resolve"
          />
        </div>
      </div>

      {/* ── Stats Cards ── */}
      {stats && stats.total > 0 && (
        <div className="mb-6">
          <h2 className="mb-3 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Campaign Progress</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <StatCard label="Total Affected" value={stats.total} />
            <StatCard label="Tier 1 Sent" value={stats.tier1.sent} sub={`${stats.tier1.accepted} accepted`} color="emerald" />
            <StatCard label="Tier 1 Rejected" value={stats.tier1.rejected} color="red" />
            <StatCard label="Tier 2 Sent" value={stats.tier2.sent} sub={`${stats.tier2.accepted} accepted`} color="blue" />
            <StatCard label="Tier 2 Rejected" value={stats.tier2.rejected} color="red" />
            <StatCard label="Paused" value={stats.paused} color="amber" />
            <StatCard label="Removed" value={stats.removed} color="zinc" />
            <StatCard label="Cancelled" value={stats.cancelled} color="red" />
          </div>
        </div>
      )}

      {/* ── Coupon Lookup — admin/owner only ── */}
      {isAdmin && <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Tier 2 Coupon</h2>
        {crisis.tier2_coupon_code ? (
          <div className="mb-4 flex items-center gap-3 rounded-md bg-emerald-50 px-4 py-3 dark:bg-emerald-900/20">
            <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              Active: <code className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-bold dark:bg-emerald-900/40">{crisis.tier2_coupon_code}</code> — {crisis.tier2_coupon_percent}% off
            </span>
          </div>
        ) : (
          <p className="mb-3 text-sm text-zinc-500">No coupon configured yet. Look up a Shopify discount code to attach it.</p>
        )}
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className={labelClass}>Shopify Discount Code</label>
            <input
              type="text"
              value={couponInput}
              onChange={e => setCouponInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && lookupCoupon()}
              placeholder="e.g. CRISIS20"
              className={inputClass}
            />
          </div>
          <button
            onClick={lookupCoupon}
            disabled={couponLooking || !couponInput.trim()}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 transition-colors dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {couponLooking ? "Looking up..." : "Look Up"}
          </button>
        </div>
        {couponError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{couponError}</p>
        )}
        {couponDetails && (
          <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{couponDetails.title}</p>
                <p className="text-xs text-zinc-500">{couponDetails.summary}</p>
              </div>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                couponDetails.status === "ACTIVE"
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
              }`}>
                {couponDetails.status}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <p className="text-xs text-zinc-400">Type</p>
                <p className="font-medium text-zinc-700 dark:text-zinc-300">
                  {couponDetails.type === "percentage" ? `${couponDetails.percentage}% off` :
                   couponDetails.type === "fixed_amount" ? `$${couponDetails.fixed_amount} off` :
                   couponDetails.type}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Code</p>
                <p className="font-medium text-zinc-700 dark:text-zinc-300">{couponDetails.code}</p>
              </div>
              {couponDetails.usage_limit && (
                <div>
                  <p className="text-xs text-zinc-400">Usage</p>
                  <p className="font-medium text-zinc-700 dark:text-zinc-300">
                    {couponDetails.usage_count ?? 0} / {couponDetails.usage_limit}
                  </p>
                </div>
              )}
              {couponDetails.ends_at && (
                <div>
                  <p className="text-xs text-zinc-400">Expires</p>
                  <p className="font-medium text-zinc-700 dark:text-zinc-300">{formatDate(couponDetails.ends_at)}</p>
                </div>
              )}
            </div>
            <button
              onClick={applyCoupon}
              disabled={saving}
              className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {saving ? "Applying..." : `Use ${couponDetails.code} for This Crisis`}
            </button>
          </div>
        )}
      </div>}

      {/* ── Settings ── */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Settings</h2>
          {isAdmin && !editing ? (
            <button onClick={() => setEditing(true)} className="text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
              Edit
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={() => setEditing(false)} className="text-sm text-zinc-500 hover:text-zinc-700">Cancel</button>
              <button onClick={handleSaveSettings} disabled={saving} className="text-sm font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50">
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          )}
        </div>

        {editing ? (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Name</label>
              <input type="text" value={editName} onChange={e => setEditName(e.target.value)} className={inputClass} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className={labelClass}>Expected Restock Date</label>
                <input type="date" value={editRestockDate} onChange={e => setEditRestockDate(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Lead Time Days</label>
                <input type="number" value={editLeadTime} onChange={e => setEditLeadTime(Number(e.target.value))} min={0} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Tier Wait Days</label>
                <input type="number" value={editTierWait} onChange={e => setEditTierWait(Number(e.target.value))} min={1} className={inputClass} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Tier 2 Coupon Code</label>
                <input type="text" value={editCouponCode} onChange={e => setEditCouponCode(e.target.value)} className={inputClass} />
              </div>
              {crisis.tier2_coupon_percent > 0 && (
                <div>
                  <label className={labelClass}>Coupon Discount</label>
                  <p className="mt-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">{crisis.tier2_coupon_percent}% off (from Shopify)</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
            <SettingsField label="Affected Variant" value={crisis.affected_product_title || crisis.affected_variant_id} />
            <SettingsField label="SKU" value={crisis.affected_sku || "---"} />
            <SettingsField label="Default Swap" value={crisis.default_swap_title || crisis.default_swap_variant_id || "---"} />
            <SettingsField label="Flavor Swaps" value={`${crisis.available_flavor_swaps?.length || 0} options`} />
            <SettingsField label="Product Swaps" value={`${crisis.available_product_swaps?.length || 0} options`} />
            <SettingsField label="Coupon" value={crisis.tier2_coupon_code ? `${crisis.tier2_coupon_code} (${crisis.tier2_coupon_percent}%)` : "---"} />
            <SettingsField label="Restock Date" value={crisis.expected_restock_date ? formatDate(crisis.expected_restock_date) : "---"} />
            <SettingsField label="Lead Time" value={`${crisis.lead_time_days} days`} />
            <SettingsField label="Tier Wait" value={`${crisis.tier_wait_days} days`} />
          </div>
        )}
      </div>

      {/* ── Customer Actions Table ── */}
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Customer Actions ({actions.length})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Segment</th>
                <th className="px-4 py-2.5">Tier</th>
                <th className="px-4 py-2.5">Response</th>
                <th className="px-4 py-2.5">Date</th>
              </tr>
            </thead>
            <tbody>
              {actions.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-400">No customer actions yet</td></tr>
              ) : (
                actions.map(a => (
                  <tr key={a.id} className="border-b border-zinc-50 dark:border-zinc-800/50">
                    <td className="px-4 py-2.5">
                      {a.customers ? (
                        <div>
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">
                            {a.customers.first_name} {a.customers.last_name}
                          </div>
                          <div className="text-xs text-zinc-400">{a.customers.email}</div>
                        </div>
                      ) : (
                        <span className="text-zinc-400">---</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        a.segment === "berry_only"
                          ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
                          : "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400"
                      }`}>
                        {a.segment === "berry_only" ? "Single item" : "Multi item"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-zinc-600 dark:text-zinc-400">
                      {a.current_tier > 0 ? `Tier ${a.current_tier}` : "---"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs font-medium ${
                        a.cancelled ? "text-red-600 dark:text-red-400" :
                        getActionResponse(a).includes("swap") || getActionResponse(a).includes("Paused") ? "text-emerald-600 dark:text-emerald-400" :
                        getActionResponse(a).includes("rejected") ? "text-amber-600 dark:text-amber-400" :
                        "text-zinc-500"
                      }`}>
                        {getActionResponse(a)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-zinc-400">
                      {formatDate(a.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ImpactCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  const colorClass = color === "emerald" ? "text-emerald-600 dark:text-emerald-400"
    : color === "red" ? "text-red-600 dark:text-red-400"
    : color === "amber" ? "text-amber-600 dark:text-amber-400"
    : color === "blue" ? "text-blue-600 dark:text-blue-400"
    : "text-zinc-900 dark:text-zinc-100";

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-800/50">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${colorClass}`}>{value}</p>
      {sub && <p className="text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}

function StepOutline({ number, title, description, timing, status }: {
  number: number; title: string; description: string; timing: string; status?: string;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
        {number}
      </div>
      <div className="flex-1">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
          <span className="text-xs text-zinc-400">{timing}</span>
        </div>
        <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">{description}</p>
        {status && (
          <p className="mt-1 text-xs font-medium text-indigo-600 dark:text-indigo-400">{status}</p>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: number; sub?: string; color?: string }) {
  const colorClass = color === "emerald" ? "text-emerald-600 dark:text-emerald-400"
    : color === "red" ? "text-red-600 dark:text-red-400"
    : color === "amber" ? "text-amber-600 dark:text-amber-400"
    : color === "blue" ? "text-blue-600 dark:text-blue-400"
    : "text-zinc-900 dark:text-zinc-100";

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${colorClass}`}>{value}</p>
      {sub && <p className="text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}

function SettingsField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="font-medium text-zinc-900 dark:text-zinc-100">{value}</p>
    </div>
  );
}
