"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

export default function SettingsPage() {
  const workspace = useWorkspace();

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Settings</h1>
      <p className="mt-2 text-sm text-zinc-500">Manage your workspace configuration.</p>

      <div className="mt-8 max-w-xl space-y-4">
        <Link
          href="/dashboard/settings/integrations"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Integrations</h2>
            <p className="mt-1 text-sm text-zinc-500">Connect Resend, Shopify, Stripe, and more</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/rules"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Rules</h2>
            <p className="mt-1 text-sm text-zinc-500">Automate ticket tagging, assignment, replies, and more</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/journeys"
          className="flex items-center justify-between rounded-lg border border-cyan-200 bg-cyan-50 p-5 transition-colors hover:border-cyan-300 dark:border-cyan-800 dark:bg-cyan-950 dark:hover:border-cyan-700"
        >
          <div>
            <h2 className="text-sm font-medium text-cyan-900 dark:text-cyan-100">Journeys</h2>
            <p className="mt-1 text-sm text-cyan-600 dark:text-cyan-400">Customer-facing retention flows — cancellation, win-back, pause, and more</p>
          </div>
          <svg className="h-5 w-5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/ai"
          className="flex items-center justify-between rounded-lg border border-violet-200 bg-violet-50 p-5 transition-colors hover:border-violet-300 dark:border-violet-800 dark:bg-violet-950 dark:hover:border-violet-700"
        >
          <div>
            <h2 className="text-sm font-medium text-violet-900 dark:text-violet-100">AI Agent</h2>
            <p className="mt-1 text-sm text-violet-600 dark:text-violet-400">Knowledge base, macros, personalities, channel config, and AI workflows</p>
          </div>
          <svg className="h-5 w-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/macros"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Macros</h2>
            <p className="mt-1 text-sm text-zinc-500">Saved responses for common customer inquiries</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/workflows"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Workflows</h2>
            <p className="mt-1 text-sm text-zinc-500">Automated multi-step responses to order tracking, cancellations, and more</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/patterns"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Smart Patterns</h2>
            <p className="mt-1 text-sm text-zinc-500">Auto-tag tickets based on message content patterns</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/coupons"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Coupons</h2>
            <p className="mt-1 text-sm text-zinc-500">Map Shopify discounts for AI and agent use, set VIP tiers</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/fraud"
          className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-5 transition-colors hover:border-red-300 dark:border-red-800 dark:bg-red-950 dark:hover:border-red-700"
        >
          <div>
            <h2 className="text-sm font-medium text-red-900 dark:text-red-100">Fraud Detection</h2>
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">Configure fraud detection rules, thresholds, and severity levels</p>
          </div>
          <svg className="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/chargebacks"
          className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-5 transition-colors hover:border-red-300 dark:border-red-800 dark:bg-red-950 dark:hover:border-red-700"
        >
          <div>
            <h2 className="text-sm font-medium text-red-900 dark:text-red-100">Chargeback Automation</h2>
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">Auto-cancel subscriptions, evidence reminders, and dispute handling</p>
          </div>
          <svg className="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/views"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Ticket Views</h2>
            <p className="mt-1 text-sm text-zinc-500">Manage saved views and sidebar hierarchy</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/tags"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Tags</h2>
            <p className="mt-1 text-sm text-zinc-500">Manage ticket tags used across your workspace</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/team"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Team</h2>
            <p className="mt-1 text-sm text-zinc-500">Manage members, roles, and invitations</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <Link
          href="/dashboard/settings/import"
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <div>
            <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Import Data</h2>
            <p className="mt-1 text-sm text-zinc-500">Upload CSV files for subscriptions and other data</p>
          </div>
          <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        <HelpCenterEditor workspaceId={workspace.id} />
        <ResponseDelayEditor workspaceId={workspace.id} />
        <AutoCloseReplyEditor workspaceId={workspace.id} />

        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Workspace</h2>
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-sm font-medium text-zinc-500">Name</label>
              <p className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">{workspace.name}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-500">Your Role</label>
              <p className="mt-1 text-sm capitalize text-zinc-900 dark:text-zinc-100">
                {workspace.role.replace("_", " ")}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-500">Workspace ID</label>
              <p className="mt-1 font-mono text-sm text-zinc-400">{workspace.id}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HelpCenterEditor({ workspaceId }: { workspaceId: string }) {
  const [helpUrl, setHelpUrl] = useState("");
  const [helpSlug, setHelpSlug] = useState("");
  const [slugMessage, setSlugMessage] = useState("");
  const [scraping, setScraping] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/integrations`)
      .then(r => r.json())
      .then(d => { setHelpUrl(d.help_center_url || ""); setHelpSlug(d.help_slug || ""); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspaceId]);

  if (loading) return null;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Help Center Import</h2>
      <p className="mt-1 text-sm text-zinc-500">Enter your existing help center URL to import articles into the Knowledge Base.</p>
      <div className="mt-3 flex items-center gap-2">
        <input
          value={helpUrl}
          onChange={(e) => setHelpUrl(e.target.value)}
          placeholder="https://help.yourcompany.com"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <button
          onClick={async () => {
            if (!helpUrl.trim()) return;
            setScraping(true);
            setMessage("");
            const res = await fetch(`/api/workspaces/${workspaceId}/scrape-help-center`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: helpUrl }),
            });
            if (res.ok) {
              setMessage("Scraping started! Check Knowledge Base for imported articles.");
            } else {
              setMessage("Failed to start scraping.");
            }
            setScraping(false);
          }}
          disabled={scraping || !helpUrl.trim()}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {scraping ? "Starting..." : "Import Articles"}
        </button>
      </div>
      {message && <p className="mt-2 text-sm text-indigo-600 dark:text-indigo-400">{message}</p>}

      {/* Help center slug */}
      <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-700">
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Help Center URL Slug</label>
        <p className="mt-0.5 text-xs text-zinc-400">Your public help center will be available at <strong>{helpSlug || "yourslug"}.shopcx.ai</strong></p>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={helpSlug}
            onChange={(e) => { setHelpSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); setSlugMessage(""); }}
            placeholder="e.g. superfoods"
            className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <button
            onClick={async () => {
              if (!helpSlug.trim()) return;
              const res = await fetch(`/api/workspaces/${workspaceId}/integrations`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ help_slug: helpSlug }),
              });
              if (res.ok) {
                setSlugMessage("Saved!");
              } else {
                const data = await res.json();
                setSlugMessage(data.error || "Failed to save");
              }
            }}
            className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Save
          </button>
        </div>
        {slugMessage && <p className={`mt-1 text-sm ${slugMessage === "Saved!" ? "text-emerald-600" : "text-red-500"}`}>{slugMessage}</p>}
        {helpSlug && (
          <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Your Help Center</p>
            <a href={`https://${helpSlug}.shopcx.ai`} className="mt-1 block text-sm text-indigo-600 hover:underline" target="_blank" rel="noopener noreferrer">
              {helpSlug}.shopcx.ai
            </a>
            <CustomDomainSetup workspaceId={workspaceId} />
          </div>
        )}

        {/* Logo upload */}
        <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-700">
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Help Center Logo</label>
          <p className="mt-0.5 text-xs text-zinc-400">Upload your logo for the branded help center mini-site.</p>
          <input
            type="file"
            accept="image/*"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const { createClient } = await import("@/lib/supabase/client");
              const supabase = createClient();
              const fileName = `${workspaceId}/help-logo-${Date.now()}.${file.name.split(".").pop()}`;
              const { error } = await supabase.storage.from("imports").upload(fileName, file, { upsert: true });
              if (!error) {
                const { data: { publicUrl } } = supabase.storage.from("imports").getPublicUrl(fileName);
                await fetch(`/api/workspaces/${workspaceId}/integrations`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ help_logo_url: publicUrl }),
                });
                alert("Logo uploaded!");
              }
            }}
            className="mt-2 block text-sm text-zinc-500 file:mr-4 file:rounded-md file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-indigo-600 hover:file:bg-indigo-100"
          />
        </div>

        {/* Primary color */}
        <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-700">
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Primary Color</label>
          <p className="mt-0.5 text-xs text-zinc-400">Used for buttons and accents on your help center.</p>
          <div className="mt-2 flex items-center gap-3">
            <input
              type="color"
              defaultValue="#4f46e5"
              onChange={(e) => {
                const color = e.target.value;
                (e.target as HTMLInputElement).dataset.color = color;
              }}
              className="h-9 w-9 cursor-pointer rounded border border-zinc-300 dark:border-zinc-700"
            />
            <button
              onClick={async (e) => {
                const colorInput = (e.target as HTMLElement).previousElementSibling as HTMLInputElement;
                const color = colorInput?.dataset?.color || colorInput?.value;
                if (!color) return;
                await fetch(`/api/workspaces/${workspaceId}/integrations`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ help_primary_color: color }),
                });
                alert("Primary color saved!");
              }}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomDomainSetup({ workspaceId }: { workspaceId: string }) {
  const [domain, setDomain] = useState("");
  const [savedDomain, setSavedDomain] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/integrations`)
      .then(r => r.json())
      .then(d => {
        if (d.help_custom_domain) {
          setDomain(d.help_custom_domain);
          setSavedDomain(d.help_custom_domain);
        }
      })
      .catch(() => {});
  }, [workspaceId]);

  const handleSave = async () => {
    const cleaned = domain.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!cleaned || !cleaned.includes(".")) {
      setError("Enter a valid domain like help.yourdomain.com");
      return;
    }
    setSaving(true);
    setError("");
    const res = await fetch(`/api/workspaces/${workspaceId}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ help_custom_domain: cleaned }),
    });
    if (res.ok) {
      setSavedDomain(cleaned);
      setDomain(cleaned);
    } else {
      const data = await res.json();
      setError(data.error || "Failed to add domain");
    }
    setSaving(false);
  };

  // Parse domain parts for CNAME instructions
  const parts = (savedDomain || "").split(".");
  const subdomain = parts.length > 2 ? parts[0] : "";
  const parentDomain = parts.length > 2 ? parts.slice(1).join(".") : savedDomain || "";

  return (
    <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Custom Domain (optional)</p>
      <p className="mt-1 text-xs text-zinc-500">Use your own domain for the help center instead of the subdomain.</p>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="help.yourdomain.com"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Adding..." : savedDomain ? "Update" : "Add Domain"}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}

      {savedDomain && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
          <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Domain registered with Vercel. Now add this DNS record:</p>
          <div className="mt-2 rounded bg-white p-2 dark:bg-zinc-800">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-zinc-400"><th className="pb-1">Type</th><th className="pb-1">Name</th><th className="pb-1">Target</th></tr></thead>
              <tbody>
                <tr className="font-mono text-zinc-700 dark:text-zinc-300">
                  <td>CNAME</td>
                  <td>{subdomain || savedDomain}</td>
                  <td>cname.vercel-dns.com</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
            Add this record in your DNS provider for <strong>{parentDomain}</strong>. SSL will be provisioned automatically once DNS propagates.
          </p>
        </div>
      )}
    </div>
  );
}

function ResponseDelayEditor({ workspaceId }: { workspaceId: string }) {
  const [delays, setDelays] = useState<Record<string, number>>({ email: 60, chat: 5, sms: 10, meta_dm: 10, help_center: 5, social_comments: 10 });
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/integrations`)
      .then(r => r.json())
      .then(d => { if (d.response_delays) setDelays(d.response_delays); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const handleSave = async () => {
    await fetch(`/api/workspaces/${workspaceId}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_delays: delays }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return null;

  const channels = [
    { key: "email", label: "Email" },
    { key: "chat", label: "Live Chat" },
    { key: "sms", label: "SMS" },
    { key: "meta_dm", label: "Social DMs" },
    { key: "help_center", label: "Help Center" },
    { key: "social_comments", label: "Social Comments" },
  ];

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Response Delay</h2>
      <p className="mt-1 text-sm text-zinc-500">How long workflows and AI wait before sending auto-replies. Prevents instant robotic-feeling responses.</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {channels.map(ch => (
          <div key={ch.key}>
            <label className="block text-sm text-zinc-500">{ch.label}</label>
            <div className="mt-1 flex items-center gap-1.5">
              <input
                type="number"
                value={delays[ch.key] || 0}
                onChange={(e) => setDelays({ ...delays, [ch.key]: parseInt(e.target.value) || 0 })}
                className="w-20 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              <span className="text-sm text-zinc-400">seconds</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={handleSave} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">Save</button>
        {saved && <span className="text-sm text-emerald-600">Saved!</span>}
      </div>
    </div>
  );
}

function AutoCloseReplyEditor({ workspaceId }: { workspaceId: string }) {
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/integrations`)
      .then(r => r.json())
      .then(d => { setMessage(d.auto_close_reply || "You're welcome! If you need anything else, we're always here to help."); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const handleSave = async () => {
    await fetch(`/api/workspaces/${workspaceId}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_close_reply: message }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return null;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Auto-Close Reply</h2>
      <p className="mt-1 text-sm text-zinc-500">Message sent when a customer confirms with &ldquo;thanks&rdquo; or similar after a workflow reply.</p>
      <textarea
        rows={2}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        className="mt-3 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      <div className="mt-2 flex items-center gap-2">
        <button onClick={handleSave} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
          Save
        </button>
        {saved && <span className="text-sm text-emerald-600">Saved!</span>}
      </div>
    </div>
  );
}
