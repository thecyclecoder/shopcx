"use client";

import { useState } from "react";

interface StoreCreditModalProps {
  customerId: string;
  currentBalance: number;
  ticketId?: string;
  subscriptionId?: string;
  onClose: () => void;
  onSuccess: (newBalance: number) => void;
}

export default function StoreCreditModal({
  customerId,
  currentBalance,
  ticketId,
  subscriptionId,
  onClose,
  onSuccess,
}: StoreCreditModalProps) {
  const [action, setAction] = useState<"credit" | "debit" | "set">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const numAmount = parseFloat(amount) || 0;

  // For "set" action, calculate the delta
  const effectiveAmount = action === "set"
    ? Math.abs(numAmount - currentBalance)
    : numAmount;
  const effectiveAction = action === "set"
    ? (numAmount >= currentBalance ? "credit" : "debit")
    : action;

  const canSubmit = action === "set"
    ? numAmount >= 0 && numAmount !== currentBalance && reason.trim().length > 0
    : numAmount > 0 && numAmount <= 500 && reason.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError("");

    const endpoint = effectiveAction === "credit"
      ? "/api/store-credit/issue"
      : "/api/store-credit/debit";

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId,
        amount: effectiveAmount,
        reason,
        ticketId,
        subscriptionId,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error || "Failed");
      return;
    }

    onSuccess(data.balance);
  };

  const actionLabel = action === "credit"
    ? `Issue $${numAmount.toFixed(2)} credit`
    : action === "debit"
    ? `Debit $${numAmount.toFixed(2)}`
    : numAmount >= currentBalance
    ? `Set balance to $${numAmount.toFixed(2)} (+$${effectiveAmount.toFixed(2)})`
    : `Set balance to $${numAmount.toFixed(2)} (-$${effectiveAmount.toFixed(2)})`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="mx-4 w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Store credit</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Current balance: <span className="font-medium text-zinc-700 dark:text-zinc-300">${currentBalance.toFixed(2)}</span>
        </p>

        {/* Action tabs */}
        <div className="mt-4 flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
          {([["credit", "Issue"], ["debit", "Debit"], ["set", "Set amount"]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => { setAction(key); setAmount(""); setError(""); }}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                action === key
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Amount */}
        <div className="mt-4">
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {action === "set" ? "New balance" : "Amount"}
          </label>
          <div className="relative mt-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">$</span>
            <input
              type="number"
              min={action === "set" ? "0" : "0.01"}
              max={action === "set" ? undefined : "500"}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={action === "set" ? currentBalance.toFixed(2) : "0.00"}
              className="w-full rounded-md border border-zinc-300 py-2 pl-7 pr-3 text-sm dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>
          {action !== "set" && (
            <p className="mt-1 text-xs text-zinc-400">Max $500.00 per transaction</p>
          )}
        </div>

        {/* Reason */}
        <div className="mt-3">
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Reason
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder={
              action === "credit" ? "Why are you issuing this credit?"
              : action === "debit" ? "Why are you debiting this amount?"
              : "Why are you changing the balance?"
            }
            className="mt-1 w-full resize-none rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </div>

        {error && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {/* Actions */}
        <div className="mt-4 flex gap-2">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || loading}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              action === "debit" || (action === "set" && numAmount < currentBalance)
                ? "bg-red-600 hover:bg-red-700"
                : "bg-indigo-600 hover:bg-indigo-500"
            }`}
          >
            {loading ? "Processing..." : actionLabel}
          </button>
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-500 hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
