"use client";

/**
 * Storefront Optimizer — the Growth control surface.
 *
 * The on/off switch + enforced product scope + the `auto_run_reversible` opt-in +
 * the editable guardrails the optimizer agent (M4) reads to bound every campaign.
 * OFF by default: while off the agent doesn't even propose. While on it proposes
 * campaigns as Build/Approve cards — the owner's tap runs each test
 * (docs/brain/specs/storefront-optimizer-activation-gate.md).
 *
 * Reads / writes /api/workspaces/[id]/storefront-optimizer-policy.
 */

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Policy {
  id: string | null;
  workspace_id: string;
  active: boolean;
  product_scope: string[];
  auto_run_reversible: boolean;
  max_concurrent_experiments: number;
  min_sample: number;
  holdout_pct: number;
  auto_rollback_ltv_tolerance: number;
  auto_rollback_windows: number;
  auto_rollback_refund_spike_delta: number;
  created_by: "agent" | "human";
  rationale: string | null;
  updated_at: string | null;
}

interface ProductOption {
  id: string;
  title: string;
  handle: string | null;
  published: boolean;
}

export default function StorefrontOptimizerPage() {
  const workspace = useWorkspace();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/storefront-optimizer-policy`);
    if (res.ok) {
      const data = await res.json();
      setPolicy(data.policy);
      setProducts(data.products ?? []);
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = useCallback(
    async (changes: Partial<Policy>) => {
      setSaving(true);
      setError(null);
      const res = await fetch(`/api/workspaces/${workspace.id}/storefront-optimizer-policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPolicy(data.policy);
        setSavedAt(new Date().toLocaleTimeString());
      } else {
        setError(data.error || "Failed to save");
      }
      setSaving(false);
    },
    [workspace.id],
  );

  const toggleScope = (productId: string) => {
    if (!policy) return;
    const next = policy.product_scope.includes(productId)
      ? policy.product_scope.filter((id) => id !== productId)
      : [...policy.product_scope, productId];
    patch({ product_scope: next });
  };

  if (loading || !policy) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Storefront Optimizer</h1>
        <p className="mt-1 text-sm text-zinc-500">
          The control surface for the autonomous storefront optimizer. While off it does nothing.
          While on it <strong>proposes</strong> campaigns as Build/Approve cards — your tap runs each test.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* ── Master on/off ─────────────────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Optimizer is {policy.active ? "ON" : "OFF"}
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              {policy.active
                ? "The agent proposes campaigns (scoped below) as Build/Approve cards. Nothing runs on live traffic without your tap."
                : "The agent does not propose anything. Turn it on to start receiving campaign proposals."}
            </p>
          </div>
          <Toggle checked={policy.active} disabled={saving} onChange={(v) => patch({ active: v })} />
        </div>
      </section>

      {/* ── Product scope ─────────────────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Product scope</h2>
        <p className="mt-1 mb-3 text-xs text-zinc-500">
          The optimizer may only touch products on this allowlist — enforced, not advisory. A proposal for any
          other product is refused even if a lander exists.
        </p>
        {products.length === 0 ? (
          <p className="text-xs text-zinc-400">No products in this workspace.</p>
        ) : (
          <ul className="space-y-1.5">
            {products.map((p) => {
              const checked = policy.product_scope.includes(p.id);
              return (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={saving}
                      onChange={() => toggleScope(p.id)}
                      className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span className="text-sm text-zinc-900 dark:text-zinc-100">{p.title}</span>
                    {!p.published && (
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-800">
                        draft
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── auto_run_reversible opt-in ────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Auto-run reversible levers
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              When on, reversible copy/hero/chapter tests may run without the per-campaign tap. Offer and
              structural changes always stay approval-gated, regardless of this switch.
            </p>
          </div>
          <Toggle
            checked={policy.auto_run_reversible}
            disabled={saving}
            onChange={(v) => patch({ auto_run_reversible: v })}
          />
        </div>
      </section>

      {/* ── Guardrails ────────────────────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Guardrails</h2>
        <p className="mb-4 text-xs text-zinc-500">
          The bounded proxy the optimizer operates within. Percentages are fractions (0.10 = 10%).
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Max concurrent experiments"
            value={policy.max_concurrent_experiments}
            step={1}
            onCommit={(n) => patch({ max_concurrent_experiments: n })}
            disabled={saving}
          />
          <NumberField
            label="Min sample (per arm)"
            value={policy.min_sample}
            step={50}
            onCommit={(n) => patch({ min_sample: n })}
            disabled={saving}
          />
          <NumberField
            label="Holdout %"
            value={policy.holdout_pct}
            step={0.01}
            onCommit={(n) => patch({ holdout_pct: n })}
            disabled={saving}
          />
          <NumberField
            label="Auto-rollback LTV tolerance"
            value={policy.auto_rollback_ltv_tolerance}
            step={0.01}
            onCommit={(n) => patch({ auto_rollback_ltv_tolerance: n })}
            disabled={saving}
          />
          <NumberField
            label="Auto-rollback windows"
            value={policy.auto_rollback_windows}
            step={1}
            onCommit={(n) => patch({ auto_rollback_windows: n })}
            disabled={saving}
          />
          <NumberField
            label="Refund-spike delta"
            value={policy.auto_rollback_refund_spike_delta}
            step={0.01}
            onCommit={(n) => patch({ auto_rollback_refund_spike_delta: n })}
            disabled={saving}
          />
        </div>
      </section>

      <p className="text-xs text-zinc-400">
        {saving ? "Saving…" : savedAt ? `Saved at ${savedAt}.` : "Changes save automatically."}
      </p>
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function NumberField({
  label,
  value,
  step,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  disabled?: boolean;
  onCommit: (n: number) => void;
}) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => {
    setLocal(String(value));
  }, [value]);
  const commit = () => {
    const n = Number(local);
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setLocal(String(value));
  };
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        type="number"
        step={step}
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  );
}
