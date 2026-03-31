"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

export default function KnowledgeBasePage() {
  const workspace = useWorkspace();
  const [helpUrl, setHelpUrl] = useState("");
  const [helpSlug, setHelpSlug] = useState("");
  const [slugMessage, setSlugMessage] = useState("");
  const [scraping, setScraping] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [customDomain, setCustomDomain] = useState("");
  const [savedDomain, setSavedDomain] = useState<string | null>(null);
  const [domainSaving, setDomainSaving] = useState(false);
  const [domainError, setDomainError] = useState("");

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/integrations`)
      .then(r => r.json())
      .then(d => {
        setHelpUrl(d.help_center_url || "");
        setHelpSlug(d.help_slug || "");
        if (d.help_custom_domain) {
          setCustomDomain(d.help_custom_domain);
          setSavedDomain(d.help_custom_domain);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspace.id]);

  if (loading) return <div className="p-6"><div className="animate-pulse h-60 bg-zinc-100 dark:bg-zinc-800 rounded-xl" /></div>;

  const parts = (savedDomain || "").split(".");
  const subdomain = parts.length > 2 ? parts[0] : "";

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Knowledge Base</h1>
      <p className="mt-2 text-sm text-zinc-500">Help center import, subdomain, branding, and custom domain.</p>

      <div className="mt-6 space-y-6">
        {/* Import */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Help Center Import</h2>
          <p className="mt-1 text-sm text-zinc-500">Enter your existing help center URL to import articles.</p>
          <div className="mt-3 flex items-center gap-2">
            <input value={helpUrl} onChange={(e) => setHelpUrl(e.target.value)} placeholder="https://help.yourcompany.com"
              className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
            <button onClick={async () => {
              if (!helpUrl.trim()) return;
              setScraping(true); setMessage("");
              const res = await fetch(`/api/workspaces/${workspace.id}/scrape-help-center`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: helpUrl }) });
              setMessage(res.ok ? "Scraping started! Check Knowledge Base for imported articles." : "Failed to start scraping.");
              setScraping(false);
            }} disabled={scraping || !helpUrl.trim()}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
              {scraping ? "Starting..." : "Import Articles"}
            </button>
          </div>
          {message && <p className="mt-2 text-sm text-emerald-600">{message}</p>}
        </div>

        {/* Subdomain */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Subdomain</h2>
          <p className="mt-1 text-xs text-zinc-400">Your public sites will be at <strong>{helpSlug || "yourslug"}.shopcx.ai</strong></p>
          <div className="mt-2 flex items-center gap-2">
            <input value={helpSlug} onChange={(e) => { setHelpSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); setSlugMessage(""); }}
              placeholder="e.g. superfoods" className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
            <button onClick={async () => {
              if (!helpSlug.trim()) return;
              const res = await fetch(`/api/workspaces/${workspace.id}/integrations`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ help_slug: helpSlug }) });
              setSlugMessage(res.ok ? "Saved!" : ((await res.json()).error || "Failed"));
            }} className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900">Save</button>
          </div>
          {slugMessage && <p className={`mt-1 text-sm ${slugMessage === "Saved!" ? "text-emerald-600" : "text-red-500"}`}>{slugMessage}</p>}
        </div>

        {/* Custom Domain */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Custom Domain</h2>
          <p className="mt-1 text-xs text-zinc-400">Use your own domain for the help center instead of the subdomain.</p>
          <div className="mt-2 flex items-center gap-2">
            <input value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} placeholder="help.yourdomain.com"
              className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100" />
            <button onClick={async () => {
              const cleaned = customDomain.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
              if (!cleaned || !cleaned.includes(".")) { setDomainError("Enter a valid domain"); return; }
              setDomainSaving(true); setDomainError("");
              const res = await fetch(`/api/workspaces/${workspace.id}/integrations`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ help_custom_domain: cleaned }) });
              if (res.ok) { setSavedDomain(cleaned); setCustomDomain(cleaned); } else { setDomainError((await res.json()).error || "Failed"); }
              setDomainSaving(false);
            }} disabled={domainSaving} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
              {domainSaving ? "Adding..." : savedDomain ? "Update" : "Add Domain"}
            </button>
          </div>
          {domainError && <p className="mt-1 text-xs text-red-500">{domainError}</p>}
          {savedDomain && (
            <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Add this DNS record:</p>
              <p className="mt-1 font-mono text-xs text-zinc-700 dark:text-zinc-300">CNAME {subdomain || savedDomain} → cname.vercel-dns.com</p>
            </div>
          )}
        </div>

        {/* Branding */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Branding</h2>
          <div className="mt-3 space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Logo</label>
              <input type="file" accept="image/*" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const { createClient } = await import("@/lib/supabase/client");
                const supabase = createClient();
                const fileName = `${workspace.id}/help-logo-${Date.now()}.${file.name.split(".").pop()}`;
                const { error } = await supabase.storage.from("imports").upload(fileName, file, { upsert: true });
                if (!error) {
                  const { data: { publicUrl } } = supabase.storage.from("imports").getPublicUrl(fileName);
                  await fetch(`/api/workspaces/${workspace.id}/integrations`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ help_logo_url: publicUrl }) });
                  alert("Logo uploaded!");
                }
              }} className="mt-1 block text-sm text-zinc-500 file:mr-4 file:rounded-md file:border-0 file:bg-zinc-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-200 dark:file:bg-zinc-800 dark:file:text-zinc-300" />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Primary Color</label>
              <div className="mt-1 flex items-center gap-3">
                <input type="color" defaultValue="#4f46e5" onChange={(e) => { (e.target as HTMLInputElement).dataset.color = e.target.value; }}
                  className="h-9 w-9 cursor-pointer rounded border border-zinc-300 dark:border-zinc-700" />
                <button onClick={async (e) => {
                  const colorInput = (e.target as HTMLElement).previousElementSibling as HTMLInputElement;
                  const color = colorInput?.dataset?.color || colorInput?.value;
                  if (!color) return;
                  await fetch(`/api/workspaces/${workspace.id}/integrations`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ help_primary_color: color }) });
                  alert("Color saved!");
                }} className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900">Save</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
