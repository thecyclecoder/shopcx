"use client";

/**
 * Shortlink domain (marketing) settings page.
 *
 * One domain per workspace. Used by the text marketing pipeline to
 * build human-typeable URLs like sprfd.co/ABC123 that redirect to
 * landing pages, products, or campaigns. Resolution happens in
 * middleware; clicks are logged to marketing_shortlink_clicks.
 *
 * Same UX pattern as /dashboard/settings/storefront-domain — type
 * the domain, we register it with Vercel, then show the CNAME
 * record the admin needs to add at their DNS provider.
 */

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

export default function ShortlinkDomainPage() {
  const workspace = useWorkspace();
  const [domain, setDomain] = useState("");
  const [currentDomain, setCurrentDomain] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`);
    if (res.ok) {
      const data = await res.json();
      setCurrentDomain(data.shortlink_domain || null);
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { load(); }, [load]);

  const saveDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!domain.trim()) return;
    setSaving(true);
    setError(null);
    setMessage(null);

    const res = await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortlink_domain: domain.trim().toLowerCase() }),
    });

    if (res.ok) {
      setMessage("Domain added to Vercel. Set up the CNAME record below.");
      setCurrentDomain(domain.trim().toLowerCase());
      setDomain("");
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Failed to add domain");
    }
    setSaving(false);
  };

  const removeDomain = async () => {
    if (!confirm("Remove shortlink domain? Any active shortlinks will stop resolving.")) return;
    setRemoving(true);
    setError(null);
    await fetch(`/api/workspaces/${workspace.id}/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortlink_domain: null }),
    });
    setCurrentDomain(null);
    setMessage("Domain removed");
    setRemoving(false);
  };

  if (loading) return <div className="mx-auto max-w-screen-2xl px-4 py-6"><p className="text-sm text-zinc-400">Loading...</p></div>;

  // CNAME name = the host part (e.g. "sprfd" for "sprfd.co", "@" for
  // an apex). Same approximation the storefront-domain page uses.
  const parts = currentDomain ? currentDomain.split(".") : [];
  const cnameName = parts.length === 2 ? "@" : parts.length > 2 ? parts[0] : "@";
  const isApex = cnameName === "@";

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Shortlink Domain</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Configure a short domain (e.g. <span className="font-mono">sprfd.co</span>) used in SMS/MMS marketing
        messages. Each campaign generates a slug, so <span className="font-mono">sprfd.co/ABC123</span> would
        redirect to the campaign&apos;s landing page.
      </p>

      {currentDomain ? (
        <div className="space-y-6">
          <div className="rounded-lg border border-green-200 bg-green-50 p-5 dark:border-green-800 dark:bg-green-950">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-green-800 dark:text-green-200">{currentDomain}</p>
                <p className="mt-1 text-xs text-green-600 dark:text-green-400">Domain configured</p>
              </div>
              <button onClick={removeDomain} disabled={removing}
                className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400">
                {removing ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">DNS Configuration</h2>
            <p className="mb-4 text-xs text-zinc-500">
              Add this record at your DNS provider for <span className="font-mono">{currentDomain}</span>.
              Vercel will issue an SSL certificate automatically once the record propagates.
            </p>

            <div className="rounded-md bg-zinc-50 p-4 dark:bg-zinc-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-500">
                    <th className="pb-2">Type</th>
                    <th className="pb-2">Name</th>
                    <th className="pb-2">Value</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  {isApex ? (
                    // Apex domains (sprfd.co) need an A record at the
                    // root since CNAME-at-apex isn't valid DNS. Vercel
                    // gives us a fixed IP for apex pointing.
                    <tr>
                      <td className="py-1 text-zinc-700 dark:text-zinc-300">A</td>
                      <td className="py-1 text-zinc-700 dark:text-zinc-300">@</td>
                      <td className="py-1">
                        <span className="rounded bg-zinc-200 px-2 py-0.5 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200">
                          76.76.21.21
                        </span>
                      </td>
                    </tr>
                  ) : (
                    <tr>
                      <td className="py-1 text-zinc-700 dark:text-zinc-300">CNAME</td>
                      <td className="py-1 text-zinc-700 dark:text-zinc-300">{cnameName}</td>
                      <td className="py-1">
                        <span className="rounded bg-zinc-200 px-2 py-0.5 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200">
                          cname.vercel-dns.com
                        </span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-[10px] text-zinc-400">
              {isApex
                ? "Apex domains use an A record. Many registrars also need ALIAS or ANAME — check your provider."
                : "DNS propagation usually takes 1–5 minutes. SSL is issued automatically by Vercel."}
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Example URL</h2>
            <p className="text-xs text-zinc-500">
              Once a campaign generates a shortlink, the link in the SMS will look like:
            </p>
            <p className="mt-2 font-mono text-sm text-indigo-600 dark:text-indigo-400">
              https://{currentDomain}/ABC123
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Add Shortlink Domain</h2>
          <p className="mb-4 text-xs text-zinc-500">
            Enter the domain you&apos;ll use in SMS/MMS messages. Short, memorable, easy to type. We&apos;ll
            register it with Vercel automatically and give you the DNS record to add.
          </p>

          <form onSubmit={saveDomain} className="space-y-3">
            <input
              value={domain}
              onChange={e => setDomain(e.target.value)}
              placeholder="e.g. sprfd.co"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            />
            <button type="submit" disabled={saving || !domain.trim()}
              className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
              {saving ? "Adding..." : "Add Domain"}
            </button>
          </form>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
      {message && <p className="mt-4 text-sm text-green-600">{message}</p>}
    </div>
  );
}
