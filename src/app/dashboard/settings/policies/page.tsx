"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface Policy {
  id: string;
  slug: string;
  name: string;
  version: number;
  customer_summary: string;
  internal_summary: string;
  rules: unknown[];
  effective_at: string;
  updated_at: string;
}

const POLICY_BLURBS: Record<string, string> = {
  returns: "Window, eligibility, return-shipping, refund timing.",
  refunds: "Renewal denial, price-discrepancy carve-out, grandfathered pricing, refund methods.",
  subscriptions: "Cadence, discount, cancellation, pause/skip, modifications, dunning.",
  exchanges: "Damaged / missing / expired / never-received replacements. Shipping Protection framing.",
  crisis: "Out-of-stock substitutions, 3-tier campaign, return path, resolution.",
};

export default function PoliciesSettingsPage() {
  const workspace = useWorkspace();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspace?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/workspaces/${workspace.id}/policies`);
      if (cancelled) return;
      if (!res.ok) { setLoading(false); return; }
      const json = await res.json();
      setPolicies(json.policies || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspace?.id]);

  return (
    <div className="max-w-4xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Policies</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          Canonical source of truth for returns, refunds, subscriptions, exchanges, and crisis handling.
          The AI orchestrator reads <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">internal_summary</code>,
          the storefront <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">/policies/[slug]</code> page reads <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">customer_summary</code>,
          and the playbook executor reads <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">rules</code>.
        </p>
      </header>

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : policies.length === 0 ? (
        <div className="text-sm text-zinc-500">No policies configured yet. Seed via <code>scripts/seed-policies-v1.ts</code>.</div>
      ) : (
        <ul className="space-y-3">
          {policies.map((p) => (
            <li key={p.id}>
              <Link
                href={`/dashboard/settings/policies/${p.slug}`}
                className="block rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-center justify-between mb-1">
                  <h2 className="font-medium text-zinc-900 dark:text-zinc-100">{p.name}</h2>
                  <span className="text-xs text-zinc-500">v{p.version}</span>
                </div>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-2">
                  {POLICY_BLURBS[p.slug] || ""}
                </p>
                <div className="flex gap-4 text-xs text-zinc-500">
                  <span>{p.customer_summary.length} chars customer</span>
                  <span>{p.internal_summary.length} chars internal</span>
                  <span>{(p.rules as unknown[]).length} rules</span>
                  <span>Updated {new Date(p.updated_at).toLocaleDateString()}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
