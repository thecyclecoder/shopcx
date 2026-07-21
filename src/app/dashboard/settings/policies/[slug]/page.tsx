"use client";

import { use, useEffect, useState } from "react";
import { errText } from "@/lib/error-text";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

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

export default function PolicyDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const workspace = useWorkspace();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [customerSummary, setCustomerSummary] = useState("");
  const [internalSummary, setInternalSummary] = useState("");
  const [rulesJson, setRulesJson] = useState("");
  const [rulesError, setRulesError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/workspaces/${workspace.id}/policies/${slug}`);
      if (cancelled) return;
      if (!res.ok) {
        setError("Failed to load policy");
        setLoading(false);
        return;
      }
      const json = await res.json();
      setPolicy(json.policy);
      setCustomerSummary(json.policy.customer_summary || "");
      setInternalSummary(json.policy.internal_summary || "");
      setRulesJson(JSON.stringify(json.policy.rules || [], null, 2));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspace?.id, slug]);

  async function handleSave() {
    if (!workspace?.id || !policy) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    setRulesError(null);

    let parsedRules: unknown[];
    try {
      parsedRules = JSON.parse(rulesJson);
      if (!Array.isArray(parsedRules)) throw new Error("rules must be an array");
    } catch (e) {
      setRulesError(`Invalid JSON: ${errText(e)}`);
      setSaving(false);
      return;
    }

    const res = await fetch(`/api/workspaces/${workspace.id}/policies/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_summary: customerSummary,
        internal_summary: internalSummary,
        rules: parsedRules,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      setError(text || "Save failed");
      setSaving(false);
      return;
    }
    const json = await res.json();
    setSaved(true);
    setSaving(false);
    // Refetch to show new version
    if (json.version) {
      setPolicy({ ...policy, version: json.version, updated_at: new Date().toISOString() });
    }
    setTimeout(() => setSaved(false), 3000);
  }

  if (loading) return <div className="text-sm text-zinc-500">Loading…</div>;
  if (!policy) return <div className="text-sm text-zinc-500">Policy not found</div>;

  return (
    <div className="max-w-4xl">
      <nav className="mb-3 text-sm text-zinc-500">
        <Link href="/dashboard/settings/policies" className="hover:text-zinc-700 dark:hover:text-zinc-300">Policies</Link>
        <span className="mx-2">/</span>
        <span>{policy.name}</span>
      </nav>

      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{policy.name}</h1>
          <p className="text-xs text-zinc-500 mt-1">
            v{policy.version} · Updated {new Date(policy.updated_at).toLocaleString()}
          </p>
        </div>
        <a
          href={`https://superfoodscompany.com/policies/${policy.slug}`}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-emerald-700 hover:underline"
        >
          View public page →
        </a>
      </header>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Customer-facing summary
          </label>
          <span className="text-xs text-zinc-500">{customerSummary.length} chars · Markdown · renders on storefront</span>
        </div>
        <textarea
          value={customerSummary}
          onChange={(e) => setCustomerSummary(e.target.value)}
          rows={20}
          className="w-full font-mono text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 p-3 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
        />
      </section>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            AI-facing summary
          </label>
          <span className="text-xs text-zinc-500">{internalSummary.length} chars · injected into orchestrator pre-context</span>
        </div>
        <textarea
          value={internalSummary}
          onChange={(e) => setInternalSummary(e.target.value)}
          rows={24}
          className="w-full font-mono text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 p-3 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
        />
      </section>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Structured rules (JSONB)
          </label>
          <span className="text-xs text-zinc-500">consumed by playbook executor — be careful</span>
        </div>
        <textarea
          value={rulesJson}
          onChange={(e) => setRulesJson(e.target.value)}
          rows={14}
          className="w-full font-mono text-xs rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 p-3 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
        />
        {rulesError && <div className="mt-2 text-sm text-red-600">{rulesError}</div>}
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {saved && <span className="text-sm text-emerald-700">Saved — version bumped to v{policy.version}</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
