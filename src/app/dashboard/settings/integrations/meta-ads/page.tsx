"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface MetaAccount {
  id: string;
  name: string;
  currency: string;
  timezone: string;
}

interface SavedAccount {
  id: string;
  meta_account_id: string;
  meta_account_name: string;
  is_active: boolean;
  last_sync_at: string | null;
}

export default function MetaAdsSettingsPage() {
  const workspace = useWorkspace();
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [userName, setUserName] = useState<string | null>(null);
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);
  const [availableAccounts, setAvailableAccounts] = useState<MetaAccount[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/meta-ads`);
    if (res.ok) {
      const data = await res.json();
      setConnected(data.connected);
      setUserName(data.user_name);
      setSavedAccounts(data.accounts || []);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [workspace.id]);

  const handleConnect = async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/meta-ads?action=login-url`);
    const { url } = await res.json();
    window.location.href = url;
  };

  const handleLoadAccounts = async () => {
    setShowPicker(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/meta-ads?action=accounts`);
    if (res.ok) {
      const data = await res.json();
      setAvailableAccounts(data.accounts || []);
      setSelectedIds(new Set(data.selected || []));
    }
  };

  const toggleAccount = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const handleSave = async () => {
    setSaving(true);
    const accounts = availableAccounts.filter(a => selectedIds.has(a.id));
    await fetch(`/api/workspaces/${workspace.id}/meta-ads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save-accounts", accounts }),
    });
    setShowPicker(false);
    setSaving(false);
    await load();
  };

  const handleSync = async (days: number) => {
    setSyncing(true);
    setMessage(null);
    const res = await fetch(`/api/workspaces/${workspace.id}/meta-ads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sync", days }),
    });
    const data = await res.json();
    setMessage(data.message || "Sync triggered");
    setSyncing(false);
  };

  if (loading) {
    return <div className="mx-auto max-w-screen-2xl px-4 py-8"><p className="text-sm text-zinc-400">Loading...</p></div>;
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Meta Ads</h1>
        <p className="mt-1 text-sm text-zinc-500">Connect your Meta ad accounts to track spend for ROAS calculations.</p>
      </div>

      {/* Connection status */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Connection</h2>
            {connected ? (
              <p className="mt-1 text-sm text-emerald-600 dark:text-emerald-400">
                Connected as {userName || "Meta User"}
              </p>
            ) : (
              <p className="mt-1 text-sm text-zinc-500">Not connected</p>
            )}
          </div>
          <button
            onClick={handleConnect}
            className={`rounded-md px-4 py-2 text-sm font-medium ${
              connected
                ? "border border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {connected ? "Reconnect" : "Connect Meta Ads"}
          </button>
        </div>
      </div>

      {/* Ad accounts */}
      {connected && (
        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Ad Accounts</h2>
              <p className="mt-0.5 text-xs text-zinc-400">
                {savedAccounts.filter(a => a.is_active).length} active account(s)
              </p>
            </div>
            <button
              onClick={handleLoadAccounts}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {savedAccounts.length > 0 ? "Manage Accounts" : "Select Accounts"}
            </button>
          </div>

          {/* Saved accounts list */}
          {savedAccounts.filter(a => a.is_active).length > 0 && !showPicker && (
            <div className="space-y-2">
              {savedAccounts.filter(a => a.is_active).map(a => (
                <div key={a.id} className="flex items-center justify-between rounded-md border border-zinc-100 px-3 py-2 dark:border-zinc-800">
                  <div>
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{a.meta_account_name}</span>
                    <span className="ml-2 text-xs text-zinc-400">act_{a.meta_account_id}</span>
                  </div>
                  {a.last_sync_at && (
                    <span className="text-[10px] text-zinc-400">
                      Last sync: {new Date(a.last_sync_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Account picker */}
          {showPicker && (
            <div className="mt-3 space-y-2">
              {availableAccounts.length === 0 ? (
                <p className="text-sm text-zinc-400">No active ad accounts found.</p>
              ) : (
                <>
                  {availableAccounts.map(a => (
                    <div
                      key={a.id}
                      onClick={() => toggleAccount(a.id)}
                      className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition-colors ${
                        selectedIds.has(a.id)
                          ? "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30"
                          : "border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50"
                      }`}
                    >
                      <div className={`flex h-4 w-4 items-center justify-center rounded border ${
                        selectedIds.has(a.id) ? "border-blue-600 bg-blue-600 text-white" : "border-zinc-300 dark:border-zinc-600"
                      }`}>
                        {selectedIds.has(a.id) && (
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <div className="flex-1">
                        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{a.name}</span>
                        <span className="ml-2 text-xs text-zinc-400">{a.currency} / {a.timezone}</span>
                      </div>
                    </div>
                  ))}
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      {saving ? "Saving..." : "Save Selection"}
                    </button>
                    <button
                      onClick={() => setShowPicker(false)}
                      className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Sync */}
      {connected && savedAccounts.filter(a => a.is_active).length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Sync Ad Spend</h2>
          <p className="mb-3 text-xs text-zinc-400">Pull spend data from Meta. Runs automatically daily at 6 AM Central.</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => handleSync(7)} disabled={syncing}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
              Last 7 days
            </button>
            <button onClick={() => handleSync(30)} disabled={syncing}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
              Last 30 days
            </button>
            <button onClick={() => handleSync(90)} disabled={syncing}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
              Last 90 days
            </button>
          </div>
          {message && <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{message}</p>}
        </div>
      )}
    </div>
  );
}
