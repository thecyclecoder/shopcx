"use client";

import { useState } from "react";

interface PortalBanButtonProps {
  customerId: string;
  isBanned: boolean;
  bannedAt?: string | null;
  bannedBy?: string | null;
  onUpdate?: (banned: boolean) => void;
  variant?: "button" | "link";
}

export default function PortalBanButton({
  customerId,
  isBanned,
  bannedAt,
  bannedBy,
  onUpdate,
  variant = "button",
}: PortalBanButtonProps) {
  const [busy, setBusy] = useState(false);
  const [banned, setBanned] = useState(isBanned);

  async function toggle() {
    setBusy(true);
    try {
      const res = await fetch(`/api/customers/${customerId}/portal-ban`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ banned: !banned }),
      });
      if (res.ok) {
        setBanned(!banned);
        onUpdate?.(!banned);
      }
    } catch {}
    setBusy(false);
  }

  if (variant === "link") {
    return (
      <div className="flex items-center gap-2">
        {banned && (
          <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
            Banned from portal
          </span>
        )}
        <button
          onClick={toggle}
          disabled={busy}
          className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 disabled:opacity-50"
        >
          {busy ? "..." : banned ? "Unban" : "Ban from portal"}
        </button>
      </div>
    );
  }

  return (
    <div>
      {banned && bannedAt && (
        <p className="mb-2 text-xs text-red-500">
          Banned from portal {bannedAt ? new Date(bannedAt).toLocaleDateString() : ""}
          {bannedBy ? ` by ${bannedBy}` : ""}
        </p>
      )}
      <button
        onClick={toggle}
        disabled={busy}
        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
          banned
            ? "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300"
            : "bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400"
        }`}
      >
        {busy ? "..." : banned ? "Unban from portal" : "Ban from portal"}
      </button>
    </div>
  );
}
