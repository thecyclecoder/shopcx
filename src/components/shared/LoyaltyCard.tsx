"use client";

import React, { useState } from "react";

export interface LoyaltyMemberData {
  id: string;
  points_balance: number;
  points_earned: number;
  points_spent: number;
}

export interface LoyaltyTierData {
  label: string;
  points_cost: number;
  discount_value: number;
  affordable?: boolean;
}

export interface LoyaltyRedemption {
  id: string;
  discount_code: string;
  discount_value: number;
  points_spent: number;
  status: string;
  used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

interface LoyaltyCardProps {
  member: LoyaltyMemberData;
  tiers: LoyaltyTierData[];
  workspaceId: string;
  /** "full" = standalone card (customer detail), "compact" = sidebar inline (ticket detail) */
  variant?: "full" | "compact";
  /** Called after a successful redemption with the new balance */
  onRedeem?: (newBalance: number, code: string, value: number, pointsCost: number) => void;
  /** Navigate to loyalty member detail (full variant only) */
  onNavigate?: () => void;
  /** Existing redemptions/coupons for this customer */
  redemptions?: LoyaltyRedemption[];
}

/**
 * Shared loyalty points card with redemption form.
 * Used on customer detail and ticket detail pages.
 */
export default function LoyaltyCard({
  member,
  tiers,
  workspaceId,
  variant = "full",
  onRedeem,
  onNavigate,
  redemptions,
}: LoyaltyCardProps) {
  const [redeeming, setRedeeming] = useState(false);
  const [selectedTier, setSelectedTier] = useState<number | string>("");
  const [redeemResult, setRedeemResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleRedeem = async () => {
    const tierIndex = typeof selectedTier === "string" ? parseInt(selectedTier) : selectedTier;
    if (isNaN(tierIndex)) return;
    setRedeeming(true);
    setRedeemResult(null);
    try {
      const res = await fetch("/api/loyalty/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          member_id: member.id,
          tier_index: tierIndex,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const tier = tiers[tierIndex];
        setRedeemResult({ success: true, message: `Code: ${data.code}` });
        setSelectedTier("");
        onRedeem?.(data.new_balance, data.code, data.discount_value, tier?.points_cost || 0);
      } else {
        setRedeemResult({ success: false, message: data.error || "Failed" });
      }
    } catch {
      setRedeemResult({ success: false, message: "Failed" });
    }
    setRedeeming(false);
  };

  if (variant === "compact") {
    return (
      <div className="space-y-2">
        <div className="rounded bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-500">Points Balance</span>
            <span className="text-sm font-semibold text-purple-600 dark:text-purple-400">
              {member.points_balance.toLocaleString()}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs text-zinc-400">
            <span>Earned: {member.points_earned.toLocaleString()}</span>
            <span>Spent: {member.points_spent.toLocaleString()}</span>
          </div>
        </div>

        {/* Redemption workflow */}
        {tiers.length > 0 && (
          <div className="rounded border border-purple-200 bg-purple-50/50 p-2.5 dark:border-purple-800 dark:bg-purple-900/10">
            <p className="text-xs font-medium text-purple-700 dark:text-purple-400">Create Redemption</p>
            <select
              value={selectedTier}
              onChange={(e) => setSelectedTier(e.target.value)}
              className="mt-1.5 w-full rounded border border-purple-300 bg-white px-2 py-1 text-xs dark:border-purple-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="">Select tier...</option>
              {tiers.map((tier, idx) => {
                const affordable = member.points_balance >= tier.points_cost;
                return (
                  <option key={idx} value={idx} disabled={!affordable}>
                    {tier.label} — {tier.points_cost.toLocaleString()} pts{!affordable ? " (not enough)" : ""}
                  </option>
                );
              })}
            </select>
            <button
              disabled={selectedTier === "" || redeeming}
              onClick={handleRedeem}
              className="mt-2 w-full rounded bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50"
            >
              {redeeming ? "Redeeming..." : "Redeem"}
            </button>
            {redeemResult && (
              <p className={`mt-1.5 text-sm font-medium ${redeemResult.success ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                {redeemResult.message}
              </p>
            )}
          </div>
        )}

        {/* Coupons list */}
        {redemptions && redemptions.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-zinc-500">Coupons</p>
            {redemptions.slice(0, 5).map(r => {
              const isUsed = !!r.used_at;
              const isExpired = !isUsed && r.expires_at && new Date(r.expires_at) < new Date();
              const statusLabel = isUsed ? "Used" : isExpired ? "Expired" : r.status === "active" ? "Unused" : r.status;
              const statusColor = isUsed ? "text-zinc-400" : isExpired ? "text-red-400" : "text-emerald-500";
              const date = new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
              return (
                <div key={r.id} className="flex items-center justify-between rounded bg-zinc-50 px-2 py-1 text-xs dark:bg-zinc-800">
                  <div className="min-w-0">
                    <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{r.discount_code}</span>
                    <span className="ml-1.5 text-zinc-400">${r.discount_value}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={`font-medium ${statusColor}`}>{statusLabel}</span>
                    <span className="text-zinc-300 dark:text-zinc-600">{date}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Full variant (customer detail page)
  return (
    <div>
      {onNavigate && (
        <button onClick={onNavigate} className="flex w-full items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Loyalty Points</h2>
          <svg className="h-4 w-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
      {!onNavigate && (
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Loyalty Points</h2>
      )}
      <div className="mt-3 grid grid-cols-3 gap-3">
        <div>
          <p className="text-xs text-zinc-400">Balance</p>
          <p className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{member.points_balance.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-zinc-400">Earned</p>
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{member.points_earned.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-zinc-400">Spent</p>
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{member.points_spent.toLocaleString()}</p>
        </div>
      </div>
      {redeemResult?.success && (
        <div className="mt-3 rounded-md bg-emerald-50 p-3 dark:bg-emerald-900/20">
          <p className="text-sm text-emerald-700 dark:text-emerald-400">Coupon created: <strong>{redeemResult.message.replace("Code: ", "")}</strong></p>
        </div>
      )}
      {tiers.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <select
            value={selectedTier}
            onChange={(e) => setSelectedTier(e.target.value)}
            className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          >
            <option value="">Redeem points...</option>
            {tiers.map((t, i) => {
              const canAfford = member.points_balance >= t.points_cost;
              return (
                <option key={i} value={String(i)} disabled={!canAfford}>
                  {t.label} — {t.points_cost.toLocaleString()} pts{!canAfford ? " (insufficient)" : ""}
                </option>
              );
            })}
          </select>
          <button
            disabled={selectedTier === "" || redeeming}
            onClick={handleRedeem}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {redeeming ? "..." : "Redeem"}
          </button>
        </div>
      )}

      {/* Coupons list — full variant */}
      {redemptions && redemptions.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-2">Coupons</h3>
          <div className="space-y-1.5">
            {redemptions.map(r => {
              const isUsed = !!r.used_at;
              const isExpired = !isUsed && r.expires_at && new Date(r.expires_at) < new Date();
              const statusLabel = isUsed ? "Used" : isExpired ? "Expired" : r.status === "active" ? "Unused" : r.status;
              const statusColor = isUsed ? "text-zinc-400" : isExpired ? "text-red-400" : "text-emerald-500";
              const date = new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
              return (
                <div key={r.id} className="flex items-center justify-between rounded-md border border-zinc-100 px-3 py-2 dark:border-zinc-800">
                  <div>
                    <span className="font-mono text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.discount_code}</span>
                    <span className="ml-2 text-sm text-zinc-400">${r.discount_value} off</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`font-medium ${statusColor}`}>{statusLabel}</span>
                    <span className="text-zinc-300 dark:text-zinc-600">{date}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
