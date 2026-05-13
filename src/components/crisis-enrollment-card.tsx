"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Ticket-sidebar card showing the customer's active-crisis enrollment
 * with toggles for the agent to flip the auto-* flags inline. Renders
 * nothing when the customer has no active enrollment (no card noise on
 * normal tickets).
 *
 * Why this exists: the orchestrator can miss explicit pause/auto-readd
 * actions even when the customer asks (see tickets a14e3d82 and
 * b0d46e97 — Opus discussed crisis_pause but only emitted create_return).
 * The card lets an agent fix that in two clicks instead of running a
 * one-off script.
 *
 * Labels avoid raw column names ("auto_readd") — they read as the
 * agent-facing intent ("Auto-switch back to Mixed Berry") with the
 * actual variant name interpolated from the crisis event.
 */

interface CrisisEnrollment {
  action: {
    id: string;
    crisis_id: string;
    segment: string;
    current_tier: number;
    paused_at: string | null;
    auto_resume: boolean;
    removed_item_at: string | null;
    auto_readd: boolean;
    cancelled: boolean;
    subscription_id: string | null;
    original_item: { title?: string; variant_title?: string } | null;
  };
  crisis: {
    id: string;
    name: string;
    status: string;
    affected_product_title: string | null;
    default_swap_title: string | null;
    expected_restock_date: string | null;
  };
}

export default function CrisisEnrollmentCard({
  workspaceId,
  customerId,
}: {
  workspaceId: string;
  customerId: string;
}) {
  const [enrollments, setEnrollments] = useState<CrisisEnrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!customerId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/customers/${customerId}/crisis-enrollment`,
      );
      if (!res.ok) return;
      const body = (await res.json()) as { enrollments: CrisisEnrollment[] };
      setEnrollments(body.enrollments || []);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, customerId]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = useCallback(
    async (actionId: string, patch: Record<string, boolean>) => {
      setSavingId(actionId);
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/crisis-actions/${actionId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          },
        );
        if (res.ok) await load();
      } finally {
        setSavingId(null);
      }
    },
    [workspaceId, load],
  );

  if (loading || enrollments.length === 0) return null;

  return (
    <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between p-4"
      >
        <h3 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-amber-800 dark:text-amber-300">
          <span aria-hidden="true">⚠</span>
          Crisis Enrollment
          <span className="text-xs text-amber-700/70 dark:text-amber-400/70">
            ({enrollments.length})
          </span>
        </h3>
        <svg
          className={`h-4 w-4 text-amber-700 transition-transform dark:text-amber-400 ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="space-y-4 border-t border-amber-200 px-4 py-3 dark:border-amber-800">
          {enrollments.map((e) => (
            <EnrollmentRow
              key={e.action.id}
              enrollment={e}
              saving={savingId === e.action.id}
              onPatch={(p) => patch(e.action.id, p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EnrollmentRow({
  enrollment,
  saving,
  onPatch,
}: {
  enrollment: CrisisEnrollment;
  saving: boolean;
  onPatch: (p: Record<string, boolean>) => void;
}) {
  const { action, crisis } = enrollment;
  const originalName =
    enrollment.action.original_item?.variant_title ||
    enrollment.action.original_item?.title ||
    crisis.affected_product_title ||
    "the original";
  const swapName = crisis.default_swap_title || "the swap";

  return (
    <div className="rounded-md border border-amber-200 bg-white p-3 dark:border-amber-800/60 dark:bg-zinc-900">
      <div className="mb-2">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {crisis.name}
        </div>
        <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Was: <span className="font-medium">{originalName}</span> · Now receiving: <span className="font-medium">{swapName}</span>
          {crisis.expected_restock_date && (
            <>
              {" · "}Expected back:{" "}
              <span className="font-medium">
                {new Date(crisis.expected_restock_date).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            </>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Pill color="amber">Segment: {action.segment}</Pill>
          {action.paused_at && <Pill color="zinc">Sub paused {fmt(action.paused_at)}</Pill>}
          {action.removed_item_at && <Pill color="zinc">Item removed {fmt(action.removed_item_at)}</Pill>}
          {action.cancelled && <Pill color="rose">Cancelled</Pill>}
        </div>
      </div>

      <div className="mt-3 space-y-2 border-t border-amber-100 pt-3 dark:border-amber-900/40">
        <Toggle
          label={`Auto-switch back to ${originalName} when restocked`}
          hint="When the crisis is resolved, the system automatically swaps the subscription line back to the original variant. Customer doesn't need to confirm."
          checked={action.auto_readd}
          onChange={(v) => onPatch({ auto_readd: v })}
          saving={saving}
        />
        <Toggle
          label="Auto-resume paused subscription when restocked"
          hint="Only meaningful if the subscription is currently paused. Unpauses on resolution so the next shipment ships automatically."
          checked={action.auto_resume}
          onChange={(v) => onPatch({ auto_resume: v })}
          saving={saving}
        />
        <Toggle
          label="Marked as cancelled / off-list"
          hint="Set when the customer has cancelled or opted out — they'll be skipped during resolution."
          checked={action.cancelled}
          onChange={(v) => onPatch({ cancelled: v })}
          saving={saving}
          tone="danger"
        />
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  saving,
  tone = "default",
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  saving: boolean;
  tone?: "default" | "danger";
}) {
  const accent = tone === "danger" ? "accent-rose-500" : "accent-emerald-600";
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={saving}
        className={`mt-0.5 h-4 w-4 rounded border-zinc-300 ${accent} disabled:opacity-50`}
      />
      <span className="text-sm">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{label}</span>
        {hint && (
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>
        )}
      </span>
    </label>
  );
}

function Pill({
  children,
  color,
}: {
  children: React.ReactNode;
  color: "amber" | "zinc" | "rose";
}) {
  const cls =
    color === "amber"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
      : color === "rose"
        ? "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300"
        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {children}
    </span>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
