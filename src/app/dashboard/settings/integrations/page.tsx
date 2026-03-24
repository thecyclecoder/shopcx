"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

export default function IntegrationsPage() {
  const workspace = useWorkspace();
  const searchParams = useSearchParams();
  const canEdit = ["owner", "admin"].includes(workspace.role);

  // Resend state
  const [resendKey, setResendKey] = useState("");
  const [resendDomain, setResendDomain] = useState("");
  const [resendHint, setResendHint] = useState<string | null>(null);
  const [resendConnected, setResendConnected] = useState(false);

  // Shopify state
  const [shopifyClientId, setShopifyClientId] = useState("");
  const [shopifyClientSecret, setShopifyClientSecret] = useState("");
  const [shopifyDomain, setShopifyDomain] = useState("");
  const [shopifyConnected, setShopifyConnected] = useState(false);
  const [shopifyHasCredentials, setShopifyHasCredentials] = useState(false);
  const [shopifyMyshopifyDomain, setShopifyMyshopifyDomain] = useState<string | null>(null);
  const [shopifyScopes, setShopifyScopes] = useState<string | null>(null);

  // Support emails + webhook
  const [supportEmail, setSupportEmail] = useState("");
  const [supportEmails, setSupportEmails] = useState<{ id: string; email: string; label: string | null; is_default: boolean }[]>([]);
  const [newSupportEmail, setNewSupportEmail] = useState("");
  const [newSupportLabel, setNewSupportLabel] = useState("");
  const [webhookConfigured, setWebhookConfigured] = useState(false);
  const [webhookLoading, setWebhookLoading] = useState(false);

  // Sandbox
  const [sandboxMode, setSandboxMode] = useState(true);

  // General state
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/integrations`)
      .then((res) => res.json())
      .then((data) => {
        setResendConnected(data.resend_connected);
        setResendHint(data.resend_api_key_hint);
        setSupportEmail(data.support_email || "");
        setResendDomain(data.resend_domain || "");
        setSandboxMode(data.sandbox_mode ?? true);
        if (data.resend_connected) {
          fetch(`/api/workspaces/${workspace.id}/integrations/resend/webhook`)
            .then((r) => r.json())
            .then((wh) => setWebhookConfigured(wh.configured));
          fetch(`/api/workspaces/${workspace.id}/support-emails`)
            .then((r) => r.json())
            .then((emails) => { if (Array.isArray(emails)) setSupportEmails(emails); });
        }
        setShopifyConnected(data.shopify_connected);
        setShopifyHasCredentials(data.shopify_has_credentials);
        setShopifyDomain(data.shopify_domain || "");
        setShopifyMyshopifyDomain(data.shopify_myshopify_domain);
        setShopifyScopes(data.shopify_scopes);
        setLoading(false);
      });
  }, [workspace.id]);

  // Handle Shopify OAuth return
  useEffect(() => {
    const shopifyStatus = searchParams.get("shopify");
    if (shopifyStatus === "connected") {
      setMessage("Shopify connected successfully!");
      setShopifyConnected(true);
      // Refresh to get latest data
      fetch(`/api/workspaces/${workspace.id}/integrations`)
        .then((res) => res.json())
        .then((data) => {
          setShopifyMyshopifyDomain(data.shopify_myshopify_domain);
          setShopifyScopes(data.shopify_scopes);
        });
    } else if (shopifyStatus === "error") {
      const reason = searchParams.get("reason") || "unknown";
      setMessage(`Shopify connection failed: ${reason}`);
    }
  }, [searchParams, workspace.id]);

  const patchIntegrations = async (body: Record<string, unknown>) => {
    setSaving(true);
    setMessage("");
    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!res.ok) {
      try {
        const data = await res.json();
        setMessage(data.error || `Failed (HTTP ${res.status})`);
      } catch {
        setMessage(`Failed (HTTP ${res.status})`);
      }
      return false;
    }
    return true;
  };

  // Resend handlers
  const handleSaveResend = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: Record<string, string> = {};
    if (resendKey) body.resend_api_key = resendKey;
    if (resendDomain) body.resend_domain = resendDomain;
    body.support_email = supportEmail;
    if (await patchIntegrations(body)) {
      setMessage("Resend configuration saved");
      setResendConnected(true);
      setResendHint(resendKey ? `re_...${resendKey.slice(-4)}` : resendHint);
      setResendKey("");
    }
  };

  const handleDisconnectResend = async () => {
    if (await patchIntegrations({ resend_api_key: null, resend_domain: null })) {
      setResendConnected(false);
      setResendHint(null);
      setResendDomain("");
      setMessage("Resend disconnected");
    }
  };

  // Shopify handlers
  const handleSaveShopifyCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shopifyClientId || !shopifyClientSecret || !shopifyDomain) return;
    if (await patchIntegrations({
      shopify_client_id: shopifyClientId,
      shopify_client_secret: shopifyClientSecret,
      shopify_domain: shopifyDomain,
    })) {
      setMessage("Shopify credentials saved. Click 'Connect Shopify' to authorize.");
      setShopifyHasCredentials(true);
      setShopifyClientId("");
      setShopifyClientSecret("");
    }
  };

  const handleConnectShopify = async () => {
    setSaving(true);
    setMessage("");
    const res = await fetch("/api/shopify/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace.id }),
    });
    if (res.ok) {
      const { url } = await res.json();
      window.location.href = url;
    } else {
      try {
        const data = await res.json();
        setMessage(data.error || "Failed to start OAuth");
      } catch {
        setMessage("Failed to start OAuth");
      }
      setSaving(false);
    }
  };

  const handleDisconnectShopify = async () => {
    if (await patchIntegrations({ shopify_disconnect: true })) {
      setShopifyConnected(false);
      setShopifyHasCredentials(false);
      setShopifyMyshopifyDomain(null);
      setShopifyScopes(null);
      setShopifyDomain("");
      setMessage("Shopify disconnected");
    }
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

      {message && (
        <div className="mb-6 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300">
          {message}
        </div>
      )}

      <div className="max-w-xl space-y-6">
        {/* ── Sandbox Mode ── */}
        <div className={`rounded-lg border p-4 ${sandboxMode ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950" : "border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950"}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className={`text-sm font-medium ${sandboxMode ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                {sandboxMode ? "Sandbox Mode" : "Live Mode"}
              </p>
              <p className={`mt-0.5 text-xs ${sandboxMode ? "text-amber-600 dark:text-amber-500" : "text-emerald-600 dark:text-emerald-500"}`}>
                {sandboxMode
                  ? "Replies to forwarded support email tickets will not be sent to customers. Only direct inbound@ tickets get real replies."
                  : "All ticket replies will be sent to customers."}
              </p>
            </div>
            <button
              onClick={async () => {
                const newValue = !sandboxMode;
                const res = await patchIntegrations({ sandbox_mode: newValue });
                if (res) {
                  setSandboxMode(newValue);
                  setMessage(newValue ? "Sandbox mode enabled" : "Live mode enabled — replies will be sent to customers");
                }
              }}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                sandboxMode
                  ? "bg-emerald-600 text-white hover:bg-emerald-500"
                  : "bg-amber-600 text-white hover:bg-amber-500"
              }`}
            >
              {sandboxMode ? "Go Live" : "Enable Sandbox"}
            </button>
          </div>
        </div>

        {/* ── Shopify ── */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#96bf48]/10">
                <svg className="h-5 w-5 text-[#96bf48]" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15.34 15.57c-.18-.07-3.34-1.59-3.34-1.59l-.2-.07-.12.19c-.15.24-.42.62-.52.75-.1.13-.19.15-.35.08-.18-.08-1.52-.56-2.89-1.68-1.07-.9-1.79-2.01-2-2.36-.21-.35-.02-.54.16-.71.16-.16.35-.42.53-.63.18-.21.24-.36.36-.59.12-.24.06-.45-.03-.63-.09-.18-.82-1.96-1.12-2.68-.3-.72-.6-.62-.82-.63h-.7c-.24 0-.63.09-.96.45-.33.36-1.26 1.23-1.26 3s1.29 3.48 1.47 3.72c.18.24 2.54 3.87 6.15 5.43.86.37 1.53.59 2.05.76.86.27 1.65.23 2.27.14.69-.1 2.13-.87 2.43-1.71.3-.84.3-1.56.21-1.71-.09-.15-.33-.24-.69-.42z" />
                </svg>
              </div>
              <div>
                <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Shopify</h2>
                <p className="text-xs text-zinc-500">Customer data, orders, and product sync</p>
              </div>
            </div>
            {shopifyConnected && (
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                Connected
              </span>
            )}
          </div>

          {canEdit && !shopifyConnected && (
            <>
              {/* Step 1: Enter credentials */}
              {!shopifyHasCredentials && (
                <form onSubmit={handleSaveShopifyCredentials} className="mt-5 space-y-4">
                  <p className="text-xs text-zinc-500">
                    Create a custom app in your Shopify Partners dashboard with scopes:{" "}
                    <code className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] dark:bg-zinc-800">
                      read_customers, read_orders, read_products, read_inventory
                    </code>
                  </p>
                  <div>
                    <label className="block text-xs font-medium text-zinc-500">Client ID</label>
                    <input
                      type="text"
                      value={shopifyClientId}
                      onChange={(e) => setShopifyClientId(e.target.value)}
                      placeholder="App Client ID"
                      required
                      className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-500">Client Secret</label>
                    <input
                      type="password"
                      value={shopifyClientSecret}
                      onChange={(e) => setShopifyClientSecret(e.target.value)}
                      placeholder="App Client Secret"
                      required
                      className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-500">Store Subdomain</label>
                    <div className="mt-1 flex items-center">
                      <input
                        type="text"
                        value={shopifyDomain}
                        onChange={(e) => setShopifyDomain(e.target.value)}
                        placeholder="your-store"
                        required
                        className="block w-full rounded-l-md border border-r-0 border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
                      />
                      <span className="inline-flex items-center rounded-r-md border border-l-0 border-zinc-300 bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
                        .myshopify.com
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-400">
                      Enter the subdomain you use to log in (even if your store has a custom domain)
                    </p>
                  </div>
                  <button
                    type="submit"
                    disabled={saving || !shopifyClientId || !shopifyClientSecret || !shopifyDomain}
                    className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {saving ? "Saving..." : "Save Credentials"}
                  </button>
                </form>
              )}

              {/* Step 2: Authorize */}
              {shopifyHasCredentials && (
                <div className="mt-5 space-y-4">
                  <p className="text-xs text-zinc-500">
                    Credentials saved for <strong>{shopifyDomain}.myshopify.com</strong>.
                    Click below to authorize ShopCX.AI to access your store.
                  </p>
                  <p className="text-xs text-zinc-400">
                    Make sure your app&apos;s redirect URL is set to:{" "}
                    <code className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] dark:bg-zinc-800">
                      {typeof window !== "undefined" ? window.location.origin : "https://shopcx.ai"}/api/shopify/callback
                    </code>
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={handleConnectShopify}
                      disabled={saving}
                      className="rounded-md bg-[#008060] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#006e52] disabled:opacity-50"
                    >
                      {saving ? "Redirecting..." : "Connect Shopify"}
                    </button>
                    <button
                      onClick={handleDisconnectShopify}
                      disabled={saving}
                      className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Connected state */}
          {canEdit && shopifyConnected && (
            <div className="mt-5 space-y-3">
              <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-800">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-500">Store</span>
                    <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                      {shopifyMyshopifyDomain || shopifyDomain}
                    </span>
                  </div>
                  {shopifyMyshopifyDomain && shopifyMyshopifyDomain !== `${shopifyDomain}.myshopify.com` && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-zinc-500">Canonical domain</span>
                      <span className="font-mono text-[10px] text-zinc-400">{shopifyMyshopifyDomain}</span>
                    </div>
                  )}
                  {shopifyScopes && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-zinc-500">Scopes</span>
                      <span className="text-[10px] text-zinc-400">{shopifyScopes}</span>
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={handleDisconnectShopify}
                disabled={saving}
                className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
              >
                Disconnect Shopify
              </button>
              <a
                href="/dashboard/settings/integrations/shopify"
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Order Source Mapping
              </a>
            </div>
          )}

          {!canEdit && (
            <p className="mt-4 text-xs text-zinc-400">Only owners and admins can manage integrations.</p>
          )}
        </div>

        {/* ── Resend ── */}
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
                <label className="block text-xs font-medium text-zinc-500">Sending Domain</label>
                <input
                  type="text"
                  value={resendDomain}
                  onChange={(e) => setResendDomain(e.target.value)}
                  placeholder="shopcx.ai"
                  className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-500"
                />
                <p className="mt-1 text-xs text-zinc-400">Must be verified in your Resend dashboard</p>
              </div>
              {/* Support emails list */}
              {resendConnected && webhookConfigured && (
                <div className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
                  <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Support Email Addresses</p>
                  <p className="text-[10px] text-zinc-400">
                    Add email addresses that customers can contact. Forward each to <strong>inbound@{resendDomain}</strong>. The default is used as Reply-To on outbound emails.
                  </p>

                  {supportEmails.length > 0 && (
                    <div className="divide-y divide-zinc-200 rounded border border-zinc-200 bg-white dark:divide-zinc-700 dark:border-zinc-700 dark:bg-zinc-900">
                      {supportEmails.map((se) => (
                        <div key={se.id} className="flex items-center justify-between px-3 py-2">
                          <div>
                            <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{se.email}</span>
                            {se.label && <span className="ml-2 text-[10px] text-zinc-400">({se.label})</span>}
                            {se.is_default && (
                              <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                                Reply-To
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={async () => {
                              await fetch(`/api/workspaces/${workspace.id}/support-emails?email_id=${se.id}`, { method: "DELETE" });
                              setSupportEmails((prev) => prev.filter((e) => e.id !== se.id));
                            }}
                            className="text-xs text-zinc-400 hover:text-red-500"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <input
                        type="email"
                        value={newSupportEmail}
                        onChange={(e) => setNewSupportEmail(e.target.value)}
                        placeholder="support@company.com"
                        className="block w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      />
                    </div>
                    <div className="w-24">
                      <input
                        type="text"
                        value={newSupportLabel}
                        onChange={(e) => setNewSupportLabel(e.target.value)}
                        placeholder="Label"
                        className="block w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 placeholder-zinc-400 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={!newSupportEmail}
                      onClick={async () => {
                        const res = await fetch(`/api/workspaces/${workspace.id}/support-emails`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            email: newSupportEmail,
                            label: newSupportLabel || null,
                            is_default: supportEmails.length === 0,
                          }),
                        });
                        if (res.ok) {
                          const created = await res.json();
                          setSupportEmails((prev) => [...prev, created]);
                          setNewSupportEmail("");
                          setNewSupportLabel("");
                        } else {
                          const data = await res.json();
                          setMessage(data.error || "Failed to add email");
                        }
                      }}
                      className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}

              {/* Inbound email setup */}
              {resendConnected && (
                <div className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Inbound Emails</p>
                    {webhookConfigured ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Active</span>
                    ) : (
                      <button
                        type="button"
                        disabled={webhookLoading}
                        onClick={async () => {
                          setWebhookLoading(true);
                          const res = await fetch(`/api/workspaces/${workspace.id}/integrations/resend/webhook`, { method: "POST" });
                          const data = await res.json();
                          if (res.ok) {
                            setWebhookConfigured(true);
                            setMessage("Inbound email webhook created");
                          } else {
                            setMessage(data.error || "Failed to create webhook");
                          }
                          setWebhookLoading(false);
                        }}
                        className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                      >
                        {webhookLoading ? "Setting up..." : "Enable Inbound Emails"}
                      </button>
                    )}
                  </div>

                  {webhookConfigured && resendDomain && (
                    <div>
                      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Inbound Address</p>
                      <p className="mt-0.5 rounded bg-white px-2 py-1 font-mono text-xs text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
                        inbound@{resendDomain}
                      </p>
                      <p className="mt-1 text-[10px] text-zinc-400">
                        Forward your support emails to this address to create tickets automatically.
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={saving || (!resendKey && !resendDomain && !supportEmail)}
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                {resendConnected && (
                  <button
                    type="button"
                    onClick={handleDisconnectResend}
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
            <p className="mt-4 text-xs text-zinc-400">Only owners and admins can manage integrations.</p>
          )}
        </div>

        {/* ── Stripe — placeholder ── */}
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

        {/* ── Meta — placeholder ── */}
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
