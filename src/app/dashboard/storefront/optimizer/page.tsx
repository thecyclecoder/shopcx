"use client";

/**
 * Storefront Optimizer — the Growth control surface
 * (docs/brain/specs/storefront-optimizer-activation-gate.md).
 *
 * The owner/Growth on-switch for the storefront optimizer. OFF by default ⇒
 * propose-only: the agent forms hypotheses but stands up zero live experiments,
 * assigns zero live variants, and writes no lander changes. Flipping it on (and
 * scoping the products it may touch) is the explicit "go". Scope is enforced — a
 * product not in scope is never touched even when active. Reads/writes
 * /api/workspaces/[id]/storefront-optimizer-policy.
 */

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Policy {
  workspace_id: string;
  active: boolean;
  product_scope: string[];
  max_concurrent_experiments: number;
  min_sample_sessions: number;
  holdout_pct: number;
  ltv_regression_tolerance: number;
  regression_windows_to_rollback: number;
  refund_spike_delta: number;
  version: number;
  activated_at: string | null;
}

interface Product {
  id: string;
  title: string;
}

const GUARDRAILS: Array<{ key: keyof Policy; label: string; step: number; hint: string }> = [
  { key: "max_concurrent_experiments", label: "Max concurrent experiments", step: 1, hint: "running experiments at once" },
  { key: "min_sample_sessions", label: "Min sample (sessions)", step: 10, hint: "before the bandit/guardrail acts" },
  { key: "holdout_pct", label: "Holdout %", step: 0.01, hint: "sacred control band (0–1)" },
  { key: "ltv_regression_tolerance", label: "LTV regression tolerance", step: 0.01, hint: "below control ⇒ a regression window" },
  { key: "regression_windows_to_rollback", label: "Regression windows → rollback", step: 1, hint: "consecutive windows before auto-rollback" },
  { key: "refund_spike_delta", label: "Refund spike Δ", step: 0.01, hint: "refund-rate excess over control ⇒ immediate rollback" },
];

function ToggleSwitch({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition disabled:opacity-50 ${
        on ? "bg-emerald-600" : "bg-zinc-300 dark:bg-zinc-700"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${on ? "translate-x-6" : "translate-x-1"}`}
      />
    </button>
  );
}

export default function StorefrontOptimizerPage() {
  const workspace = useWorkspace();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [pRes, prodRes] = await Promise.all([
      fetch(`/api/workspaces/${workspace.id}/storefront-optimizer-policy`),
      fetch(`/api/workspaces/${workspace.id}/products?status=active`),
    ]);
    if (pRes.ok) setPolicy((await pRes.json()) as Policy);
    if (prodRes.ok) setProducts(((await prodRes.json()) as Product[]).map((p) => ({ id: p.id, title: p.title })));
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setSaving(true);
      setMsg(null);
      const res = await fetch(`/api/workspaces/${workspace.id}/storefront-optimizer-policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setPolicy((await res.json()) as Policy);
        setMsg("Saved.");
      } else {
        setMsg("Save failed.");
      }
      setSaving(false);
    },
    [workspace.id],
  );

  if (!policy) {
    return (
      <div className="mx-auto w-full max-w-screen-md px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  const inScope = new Set(policy.product_scope);
  const toggleProduct = (id: string) => {
    const next = new Set(inScope);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    patch({ product_scope: [...next] });
  };

  return (
    <div className="mx-auto w-full max-w-screen-md px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Storefront Optimizer</h1>
        <p className="mt-1 text-sm text-zinc-500">
          The on-switch for the autonomous storefront optimizer. OFF by default — the agent proposes what it would test but
          runs zero live experiments and changes nothing customers see.
        </p>
      </header>

      {/* The on-switch */}
      <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                {policy.active ? "Active" : "Off — propose-only"}
              </span>
              <span
                className={`inline-block h-2 w-2 rounded-full ${policy.active ? "bg-emerald-500" : "bg-zinc-400"}`}
                aria-hidden
              />
            </div>
            <p className="mt-1 text-sm text-zinc-500">
              {policy.active
                ? "The optimizer may run live experiments — but only on products in scope below."
                : "Flip on to let the optimizer run live experiments within the guardrails. Until then it only proposes."}
            </p>
          </div>
          <ToggleSwitch on={policy.active} disabled={saving} onChange={() => patch({ active: !policy.active })} />
        </div>
        {policy.active && policy.product_scope.length === 0 && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Active, but no products are in scope — nothing will run until you add one below.
          </p>
        )}
      </section>

      {/* Product scope — the enforced allowlist */}
      <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Product scope</h2>
        <p className="mt-1 mb-3 text-sm text-zinc-500">
          The optimizer can only touch products in this allowlist — enforced, not advisory. Start with Amazing Coffee.
        </p>
        <div className="space-y-1">
          {products.length === 0 && <p className="text-sm text-zinc-400">No active products.</p>}
          {products.map((p) => (
            <label
              key={p.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <input
                type="checkbox"
                checked={inScope.has(p.id)}
                disabled={saving}
                onChange={() => toggleProduct(p.id)}
                className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-sm text-zinc-800 dark:text-zinc-200">{p.title}</span>
              {inScope.has(p.id) && (
                <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  in scope
                </span>
              )}
            </label>
          ))}
        </div>
      </section>

      {/* Guardrails */}
      <section className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Guardrails</h2>
        <p className="mt-1 mb-3 text-sm text-zinc-500">The bounded proxy the optimizer + bandit operate within.</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {GUARDRAILS.map((g) => (
            <div key={g.key as string}>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">{g.label}</label>
              <input
                type="number"
                step={g.step}
                defaultValue={policy[g.key] as number}
                disabled={saving}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v !== (policy[g.key] as number)) patch({ [g.key]: v });
                }}
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
              <p className="mt-1 text-xs text-zinc-400">{g.hint}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-3 text-sm text-zinc-500">
        <span>Policy v{policy.version}</span>
        {policy.activated_at && <span>· activated {new Date(policy.activated_at).toLocaleDateString()}</span>}
        {saving && <span>· saving…</span>}
        {msg && <span>· {msg}</span>}
      </div>
    </div>
  );
}
