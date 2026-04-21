"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { useSearchParams } from "next/navigation";

export default function GoogleSEOPage() {
  const workspace = useWorkspace();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Google Ads state
  const [adsConnected, setAdsConnected] = useState(false);
  const [adsCustomerId, setAdsCustomerId] = useState("");
  const [adsClientId, setAdsClientId] = useState("");
  const [adsDevToken, setAdsDevToken] = useState("");
  const [adsClientSecret, setAdsClientSecret] = useState("");

  // Search Console state
  const [scConnected, setScConnected] = useState(false);
  const [scSiteUrl, setScSiteUrl] = useState("");
  const [scCredentials, setScCredentials] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`);
    if (res.ok) {
      const data = await res.json();
      setAdsConnected(!!data.google_ads_connected);
      setAdsCustomerId(data.google_ads_customer_id || "");
      setAdsClientId(data.google_ads_client_id || "");
      setScConnected(!!data.google_search_console_connected);
      setScSiteUrl(data.google_search_console_site_url || "");
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { load(); }, [load]);

  // Check for OAuth callback results
  useEffect(() => {
    const success = searchParams.get("success");
    const error = searchParams.get("error");
    if (success === "google_ads_connected") {
      setMessage("Google Ads connected successfully!");
      setAdsConnected(true);
    }
    if (error) {
      setMessage(`Connection failed: ${error.replace(/_/g, " ")}`);
    }
  }, [searchParams]);

  const saveAdsConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {};
    if (adsCustomerId) body.google_ads_customer_id = adsCustomerId;
    if (adsClientId) body.google_ads_client_id = adsClientId;
    if (adsDevToken) body.google_ads_developer_token = adsDevToken;
    if (adsClientSecret) body.google_ads_client_secret = adsClientSecret;

    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setMessage("Google Ads settings saved");
      setAdsDevToken("");
      setAdsClientSecret("");
      load();
    }
    setSaving(false);
  };

  const connectGoogleAds = () => {
    window.location.href = `/api/auth/google-ads?workspace_id=${workspace.id}`;
  };

  const saveSCConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {};
    if (scSiteUrl) body.google_search_console_site_url = scSiteUrl;
    if (scCredentials) body.google_search_console_credentials = scCredentials;

    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setMessage("Search Console settings saved");
      setScCredentials("");
      setScConnected(true);
      load();
    }
    setSaving(false);
  };

  if (loading) return <div className="mx-auto max-w-3xl px-4 py-6"><p className="text-sm text-zinc-400">Loading...</p></div>;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Google SEO Tools</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Connect Google Ads Keyword Planner for search volume data and Search Console for existing rankings.
      </p>

      {message && (
        <div className={`mb-4 rounded-lg border p-3 text-sm ${message.includes("fail") || message.includes("error") ? "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300" : "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300"}`}>
          {message}
        </div>
      )}

      {/* Google Ads Keyword Planner */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Google Ads — Keyword Planner</h2>
          {adsConnected ? (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">Connected</span>
          ) : (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800">Not connected</span>
          )}
        </div>
        <p className="mb-4 text-xs text-zinc-500">
          Real search volume, competition, and CPC data for keyword research. Requires a Google Ads account with API access.
        </p>

        <form onSubmit={saveAdsConfig} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Customer ID</span>
            <input value={adsCustomerId} onChange={e => setAdsCustomerId(e.target.value)}
              placeholder="733-009-2025"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">OAuth Client ID</span>
            <input value={adsClientId} onChange={e => setAdsClientId(e.target.value)}
              placeholder="xxxxxxx.apps.googleusercontent.com"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">OAuth Client Secret (leave blank to keep current)</span>
            <input type="password" value={adsClientSecret} onChange={e => setAdsClientSecret(e.target.value)}
              placeholder="GOCSPX-..."
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Developer Token (leave blank to keep current)</span>
            <input type="password" value={adsDevToken} onChange={e => setAdsDevToken(e.target.value)}
              placeholder="Developer token from Google Ads API Center"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
          </label>

          <div className="flex gap-2">
            <button type="submit" disabled={saving}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
              Save Settings
            </button>

            {adsClientId && (
              <button type="button" onClick={connectGoogleAds}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500">
                {adsConnected ? "Re-authorize" : "Connect Google Ads"}
              </button>
            )}
          </div>
        </form>

        {!adsConnected && adsClientId && (
          <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
            Save your settings above, then click "Connect Google Ads" to authorize access. You'll be redirected to Google to approve.
          </p>
        )}
      </div>

      {/* Google Search Console */}
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Google Search Console</h2>
          {scConnected ? (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">Connected</span>
          ) : (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800">Not connected</span>
          )}
        </div>
        <p className="mb-4 text-xs text-zinc-500">
          Shows what keywords you already rank for — clicks, impressions, CTR, and position. Uses a service account for authentication.
        </p>

        <form onSubmit={saveSCConfig} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Site URL</span>
            <input value={scSiteUrl} onChange={e => setScSiteUrl(e.target.value)}
              placeholder="https://superfoodscompany.com"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Service Account JSON (leave blank to keep current)</span>
            <textarea value={scCredentials} onChange={e => setScCredentials(e.target.value)}
              placeholder='Paste the full service account JSON here...'
              rows={4}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
          </label>

          <button type="submit" disabled={saving}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
            Save Settings
          </button>
        </form>

        {scConnected && scSiteUrl && (
          <p className="mt-3 text-xs text-green-600 dark:text-green-400">
            Connected to {scSiteUrl}. Make sure the service account email has read access in Search Console.
          </p>
        )}
      </div>
    </div>
  );
}
