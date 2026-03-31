"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface MemberCustomer {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  shopify_customer_id: string | null;
}

interface Member {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  shopify_customer_id: string | null;
  email: string | null;
  points_balance: number;
  points_earned: number;
  points_spent: number;
  source: string;
  created_at: string;
  updated_at: string;
  customers: MemberCustomer | null;
}

interface Tier {
  label: string;
  points_cost: number;
  discount_value: number;
  tier_index: number;
  affordable: boolean;
}

interface Transaction {
  id: string;
  points_change: number;
  type: string;
  description: string | null;
  order_id: string | null;
  created_at: string;
}

interface Redemption {
  id: string;
  reward_tier: string;
  points_spent: number;
  discount_code: string;
  discount_value: number;
  status: string;
  used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

interface DiscountHistoryEntry {
  code: string;
  order_number: string | null;
  total_cents: number;
  created_at: string;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    applied: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    used: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
    expired: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${map[status] || "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"}`}>
      {status}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    earning: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    spending: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
    adjustment: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    import: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    refund: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
    chargeback: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${map[type] || "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"}`}>
      {type}
    </span>
  );
}

export default function LoyaltyDetailPage() {
  const { memberId } = useParams<{ memberId: string }>();
  const router = useRouter();
  const workspace = useWorkspace();

  const [member, setMember] = useState<Member | null>(null);
  const [dollarValue, setDollarValue] = useState(0);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [unusedCoupons, setUnusedCoupons] = useState<Redemption[]>([]);
  const [discountHistory, setDiscountHistory] = useState<DiscountHistoryEntry[]>([]);
  const [workspaceRole, setWorkspaceRole] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Redemption
  const [redeemTier, setRedeemTier] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [redeemResult, setRedeemResult] = useState<{ code: string; value: number } | null>(null);

  // Manual adjustment
  const [adjustPoints, setAdjustPoints] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [adjustResult, setAdjustResult] = useState("");

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/loyalty/members/${memberId}`);
      if (!res.ok) {
        setError("Member not found");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setMember(data.member);
      setDollarValue(data.dollar_value);
      setTiers(data.tiers || []);
      setTransactions(data.transactions || []);
      setRedemptions(data.redemptions || []);
      setUnusedCoupons(data.unused_coupons || []);
      setDiscountHistory(data.discount_history || []);
      setWorkspaceRole(data.workspace_role || "");
      setLoading(false);
    }
    load();
  }, [memberId]);

  const handleRedeem = async () => {
    if (!redeemTier || !member) return;
    setRedeeming(true);
    setRedeemResult(null);
    try {
      const res = await fetch("/api/loyalty/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspace.id, member_id: member.id, tier_index: parseInt(redeemTier) }),
      });
      const data = await res.json();
      if (data.ok) {
        setRedeemResult({ code: data.code, value: data.discount_value });
        setMember((prev) =>
          prev
            ? {
                ...prev,
                points_balance: data.new_balance,
                points_spent: prev.points_spent + (tiers[parseInt(redeemTier)]?.points_cost || 0),
              }
            : prev,
        );
        setRedeemTier("");
        // Refresh data
        const refreshRes = await fetch(`/api/loyalty/members/${memberId}`);
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json();
          setRedemptions(refreshData.redemptions || []);
          setUnusedCoupons(refreshData.unused_coupons || []);
          setTransactions(refreshData.transactions || []);
        }
      }
    } catch {}
    setRedeeming(false);
  };

  const handleAdjust = async () => {
    const pts = parseInt(adjustPoints);
    if (!pts || pts === 0) return;
    setAdjusting(true);
    setAdjustResult("");
    try {
      const res = await fetch(`/api/loyalty/members/${memberId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: pts, reason: adjustReason || undefined }),
      });
      const data = await res.json();
      if (data.ok) {
        setAdjustResult(`Adjusted ${pts > 0 ? "+" : ""}${pts} points. New balance: ${data.new_balance.toLocaleString()}`);
        setMember((prev) =>
          prev
            ? {
                ...prev,
                points_balance: data.new_balance,
                points_earned: pts > 0 ? prev.points_earned + pts : prev.points_earned,
              }
            : prev,
        );
        setAdjustPoints("");
        setAdjustReason("");
        // Refresh transactions
        const refreshRes = await fetch(`/api/loyalty/members/${memberId}`);
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json();
          setTransactions(refreshData.transactions || []);
        }
      } else {
        setAdjustResult(data.error || "Adjustment failed");
      }
    } catch {
      setAdjustResult("Adjustment failed");
    }
    setAdjusting(false);
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  if (error || !member) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <p className="text-sm text-zinc-400">{error || "Member not found"}</p>
        <button onClick={() => router.push("/dashboard/loyalty")} className="mt-4 text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          Back to loyalty
        </button>
      </div>
    );
  }

  const displayName = member.customers
    ? [member.customers.first_name, member.customers.last_name].filter(Boolean).join(" ") || member.email || "Unknown"
    : member.email || "Unknown";

  const isAdmin = ["admin", "owner"].includes(workspaceRole);

  return (
    <div className="px-4 py-6 sm:px-6">
      {/* Back button */}
      <button
        onClick={() => router.push("/dashboard/loyalty")}
        className="mb-6 flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to loyalty
      </button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{displayName}</h1>
          <p className="mt-1 text-sm text-zinc-500">{member.email || member.customers?.email}</p>
        </div>
        {member.customers?.id && (
          <button
            onClick={() => router.push(`/dashboard/customers/${member.customers!.id}`)}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            View customer
          </button>
        )}
      </div>

      {/* Points summary */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500">Balance</p>
          <p className="mt-1 text-2xl font-bold text-purple-600 dark:text-purple-400">{member.points_balance.toLocaleString()}</p>
          <p className="mt-0.5 text-xs text-zinc-400">${dollarValue.toFixed(2)} value</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500">Total Earned</p>
          <p className="mt-1 text-xl font-bold text-emerald-600 dark:text-emerald-400">{member.points_earned.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500">Total Spent</p>
          <p className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">{member.points_spent.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500">Source</p>
          <p className="mt-1 text-xl font-bold capitalize text-zinc-900 dark:text-zinc-100">{member.source}</p>
          <p className="mt-0.5 text-xs text-zinc-400">Since {formatDate(member.created_at)}</p>
        </div>
      </div>

      {/* Redemption tool */}
      <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Redeem Points</h2>
        {redeemResult && (
          <div className="mt-3 rounded-md bg-emerald-50 p-3 dark:bg-emerald-900/20">
            <p className="text-sm text-emerald-700 dark:text-emerald-400">
              Coupon created: <strong>{redeemResult.code}</strong> (${redeemResult.value} off)
            </p>
          </div>
        )}
        {tiers.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <select
              value={redeemTier}
              onChange={(e) => setRedeemTier(e.target.value)}
              className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="">Select reward tier...</option>
              {tiers.map((t) => (
                <option key={t.tier_index} value={String(t.tier_index)} disabled={!t.affordable}>
                  {t.label} — {t.points_cost.toLocaleString()} pts{!t.affordable ? " (insufficient)" : ""}
                </option>
              ))}
            </select>
            <button
              disabled={!redeemTier || redeeming}
              onClick={handleRedeem}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {redeeming ? "..." : "Redeem"}
            </button>
          </div>
        )}
      </div>

      {/* Unused coupons */}
      {unusedCoupons.length > 0 && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Unused Coupons ({unusedCoupons.length})</h2>
          <div className="mt-3 space-y-2">
            {unusedCoupons.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded bg-zinc-50 px-3 py-2 dark:bg-zinc-800">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-purple-100 px-2 py-0.5 text-sm font-mono font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                    {c.discount_code}
                  </code>
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">${c.discount_value} off</span>
                  <StatusBadge status={c.status} />
                </div>
                <span className="text-xs text-zinc-400">
                  Expires {c.expires_at ? formatDate(c.expires_at) : "never"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Redemption history */}
      {redemptions.length > 0 && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Redemption History ({redemptions.length})</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/50">
                  <th className="px-4 py-2 font-medium text-zinc-500">Code</th>
                  <th className="px-4 py-2 font-medium text-zinc-500">Value</th>
                  <th className="px-4 py-2 font-medium text-zinc-500">Points</th>
                  <th className="px-4 py-2 font-medium text-zinc-500">Status</th>
                  <th className="px-4 py-2 font-medium text-zinc-500">Created</th>
                  <th className="px-4 py-2 font-medium text-zinc-500">Used</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {redemptions.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2">
                      <code className="text-sm font-mono text-zinc-900 dark:text-zinc-100">{r.discount_code}</code>
                    </td>
                    <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">${r.discount_value}</td>
                    <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{r.points_spent.toLocaleString()}</td>
                    <td className="px-4 py-2"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-2 text-zinc-400">{formatDate(r.created_at)}</td>
                    <td className="px-4 py-2 text-zinc-400">{r.used_at ? formatDate(r.used_at) : "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Discount History (from orders) */}
      {discountHistory.length > 0 && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Discount History ({discountHistory.length})</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/50">
                  <th className="px-4 py-2 font-medium text-zinc-500">Code</th>
                  <th className="px-4 py-2 font-medium text-zinc-500">Order</th>
                  <th className="px-4 py-2 font-medium text-zinc-500">Order Total</th>
                  <th className="px-4 py-2 font-medium text-zinc-500">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {discountHistory.map((d, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2">
                      <code className="text-sm font-mono text-zinc-900 dark:text-zinc-100">{d.code}</code>
                    </td>
                    <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{d.order_number || "--"}</td>
                    <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                      {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(d.total_cents / 100)}
                    </td>
                    <td className="px-4 py-2 text-zinc-400">{formatDate(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Transaction history */}
      {transactions.length > 0 && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Transaction History ({transactions.length})</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/50">
                  <th className="px-4 py-2 font-medium text-zinc-500">Type</th>
                  <th className="px-4 py-2 font-medium text-zinc-500">Points</th>
                  <th className="px-4 py-2 font-medium text-zinc-500">Description</th>
                  <th className="px-4 py-2 font-medium text-zinc-500">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {transactions.map((t) => (
                  <tr key={t.id}>
                    <td className="px-4 py-2"><TypeBadge type={t.type} /></td>
                    <td className="px-4 py-2">
                      <span className={`font-medium ${t.points_change > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                        {t.points_change > 0 ? "+" : ""}{t.points_change.toLocaleString()}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400 max-w-xs truncate">{t.description || "--"}</td>
                    <td className="px-4 py-2 text-zinc-400">{formatDate(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Manual adjustment (admin only) */}
      {isAdmin && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Manual Adjustment</h2>
          <p className="mt-1 text-xs text-zinc-400">Add or remove points. Use negative numbers to deduct.</p>
          {adjustResult && (
            <div className={`mt-3 rounded-md p-3 ${adjustResult.includes("Adjusted") ? "bg-emerald-50 dark:bg-emerald-900/20" : "bg-red-50 dark:bg-red-900/20"}`}>
              <p className={`text-sm ${adjustResult.includes("Adjusted") ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>{adjustResult}</p>
            </div>
          )}
          <div className="mt-3 flex items-end gap-2">
            <div className="flex-shrink-0">
              <label className="block text-xs text-zinc-500 mb-1">Points</label>
              <input
                type="number"
                value={adjustPoints}
                onChange={(e) => setAdjustPoints(e.target.value)}
                placeholder="+100 or -50"
                className="w-32 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-zinc-500 mb-1">Reason</label>
              <input
                type="text"
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="Reason for adjustment..."
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </div>
            <button
              disabled={!adjustPoints || parseInt(adjustPoints) === 0 || adjusting}
              onClick={handleAdjust}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {adjusting ? "..." : "Adjust"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
