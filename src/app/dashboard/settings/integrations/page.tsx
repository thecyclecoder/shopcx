"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

export default function IntegrationsPage() {
  const workspace = useWorkspace();
  const canEdit = ["owner", "admin"].includes(workspace.role);

  const [resendKey, setResendKey] = useState("");
  const [resendDomain, setResendDomain] = useState("");
  const [resendHint, setResendHint] = useState<string | null>(null);
  const [resendConnected, setResendConnected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/integrations`)
      .then((res) => res.json())
      .then((data) => {
        setResendConnected(data.resend_connected);
        setResendHint(data.resend_api_key_hint);
        setResendDomain(data.resend_domain || "");
        setLoading(false);
      });
  }, [workspace.id]);

  const handleSaveResend = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage("");

    const body: Record<string, string> = {};
    if (resendKey) body.resend_api_key = resendKey;
    if (resendDomain) body.resend_domain = resendDomain;

    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setMessage("Resend configuration saved");
      setResendConnected(true);
      setResendHint(resendKey ? `re_...${resendKey.slice(-4)}` : resendHint);
      setResendKey("");
    } else {
      try {
        const data = await res.json();
        setMessage(data.error || "Failed to save");
      } catch {
        setMessage(`Failed to save (HTTP ${res.status})`);
      }
    }
    setSaving(false);
  };

  const handleDisconnect = async () => {
    setSaving(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resend_api_key: null, resend_domain: null }),
    });

    if (res.ok) {
      setResendConnected(false);
      setResendHint(null);
      setResendDomain("");
      setMessage("Resend disconnected");
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Integrations</h1>
        <p className="mt-2 text-sm text-zinc-500">Connect external services to your workspace.</p>
      </div>

      <div className="max-w-xl space-y-6">
        {/* Resend */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
                <svg className="h-5 w-5 text-zinc-600 dark:text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                </svg>
              </div>
              <div>
                <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Resend</h2>
                <p className="text-xs text-zinc-500">Email delivery for invites, notifications, and marketing</p>
              </div>
            </div>
            {resendConnected && (
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                Connected
              </span>
            )}
          </div>

          {canEdit && (
            <form onSubmit={handleSaveResend} className="mt-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-500">API Key</label>
                <input
                  type="password"
                  value={resendKey}
                  onChange={(e) => setResendKey(e.target.value)}
                  placeholder={resendHint || "re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
                />
                {resendHint && (
                  <p className="mt-1 text-xs text-zinc-400">Current key: {resendHint}</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-500">
                  Sending Domain
                </label>
                <input
                  type="text"
                  value={resendDomain}
                  onChange={(e) => setResendDomain(e.target.value)}
                  placeholder="shopcx.ai"
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
                />
                <p className="mt-1 text-xs text-zinc-400">
                  Must be verified in your Resend dashboard
                </p>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={saving || (!resendKey && !resendDomain)}
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                {resendConnected && (
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    disabled={saving}
                    className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </form>
          )}

          {!canEdit && (
            <p className="mt-4 text-xs text-zinc-400">
              Only owners and admins can manage integrations.
            </p>
          )}

          {message && (
            <p className="mt-3 text-sm text-indigo-600 dark:text-indigo-400">{message}</p>
          )}
        </div>

        {/* Shopify - placeholder */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 opacity-60 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
              <svg className="h-5 w-5 text-zinc-600 dark:text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5V6a3.75 3.75 0 10-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 01-1.12-1.243l1.264-12A1.125 1.125 0 015.513 7.5h12.974c.576 0 1.059.435 1.119 1.007z" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Shopify</h2>
              <p className="text-xs text-zinc-500">Coming in Phase 2</p>
            </div>
          </div>
        </div>

        {/* Stripe - placeholder */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 opacity-60 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
              <svg className="h-5 w-5 text-zinc-600 dark:text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Stripe</h2>
              <p className="text-xs text-zinc-500">Coming in Phase 7</p>
            </div>
          </div>
        </div>

        {/* Meta - placeholder */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 opacity-60 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
              <svg className="h-5 w-5 text-zinc-600 dark:text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Meta</h2>
              <p className="text-xs text-zinc-500">Coming in Phase 6</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
