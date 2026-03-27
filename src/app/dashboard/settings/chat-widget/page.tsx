"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

export default function ChatWidgetSettingsPage() {
  const workspace = useWorkspace();
  const [enabled, setEnabled] = useState(false);
  const [color, setColor] = useState("#4f46e5");
  const [greeting, setGreeting] = useState("Hi! How can we help you today?");
  const [position, setPosition] = useState("bottom-right");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<{ success?: boolean; error?: string; already?: boolean; theme?: string } | null>(null);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/widget-settings`)
      .then((r) => r.json())
      .then((data) => {
        if (data.widget_enabled != null) setEnabled(data.widget_enabled);
        if (data.widget_color) setColor(data.widget_color);
        if (data.widget_greeting) setGreeting(data.widget_greeting);
        if (data.widget_position) setPosition(data.widget_position);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspace.id]);

  const handleSave = async () => {
    setSaving(true);
    await fetch(`/api/workspaces/${workspace.id}/widget-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        widget_enabled: enabled,
        widget_color: color,
        widget_greeting: greeting,
        widget_position: position,
      }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const embedCode = `<script src="https://shopcx.ai/widget.js" data-workspace="${workspace.id}"></script>`;

  const handleCopy = () => {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="h-6 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center gap-2">
        <Link href="/dashboard/settings" className="text-sm text-zinc-400 hover:text-zinc-600">Settings</Link>
        <span className="text-zinc-300">/</span>
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Live Chat Widget</h1>
      </div>

      <div className="max-w-xl space-y-6">
        {/* Enable toggle */}
        <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Enable Chat Widget</p>
            <p className="text-sm text-zinc-500">Allow customers to chat from your website</p>
          </div>
          <button
            onClick={() => setEnabled(!enabled)}
            className={`relative h-6 w-11 rounded-full transition-colors ${enabled ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-600"}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5.5 left-[22px]" : "left-0.5"}`} />
          </button>
        </div>

        {/* Color picker */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100">Widget Color</label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-10 w-10 cursor-pointer rounded border-0"
            />
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <div className="h-8 w-8 rounded-full shadow-sm" style={{ backgroundColor: color }} />
          </div>
        </div>

        {/* Greeting */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100">Greeting Message</label>
          <textarea
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </div>

        {/* Position */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100">Position</label>
          <div className="flex gap-3">
            {["bottom-right", "bottom-left"].map((pos) => (
              <button
                key={pos}
                onClick={() => setPosition(pos)}
                className={`rounded-md border px-4 py-2 text-sm font-medium transition-colors ${
                  position === pos
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400"
                    : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400"
                }`}
              >
                {pos === "bottom-right" ? "Bottom Right" : "Bottom Left"}
              </button>
            ))}
          </div>
        </div>

        {/* Shopify Auto-Install */}
        {enabled && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950">
            <label className="mb-2 block text-sm font-medium text-emerald-900 dark:text-emerald-100">Shopify Auto-Install</label>
            <p className="mb-3 text-sm text-emerald-700 dark:text-emerald-400">
              One click to inject the chat widget into your Shopify theme. Automatically passes logged-in customer data (name, email, Shopify ID) so customers don&apos;t need to re-enter their info.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  setInstalling(true);
                  setInstallResult(null);
                  const res = await fetch(`/api/workspaces/${workspace.id}/widget-install`, { method: "POST" });
                  const data = await res.json();
                  if (data.already_installed) {
                    setInstallResult({ already: true, theme: data.theme });
                  } else if (data.success) {
                    setInstallResult({ success: true, theme: data.theme });
                  } else {
                    setInstallResult({ error: data.error || "Install failed" });
                  }
                  setInstalling(false);
                }}
                disabled={installing}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {installing ? "Installing..." : "Install on Shopify"}
              </button>
              <button
                onClick={async () => {
                  setInstalling(true);
                  setInstallResult(null);
                  const res = await fetch(`/api/workspaces/${workspace.id}/widget-install`, { method: "DELETE" });
                  const data = await res.json();
                  setInstallResult(data.success ? { success: true, theme: "removed" } : { error: data.error });
                  setInstalling(false);
                }}
                disabled={installing}
                className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Remove from Shopify
              </button>
            </div>
            {installResult && (
              <p className={`mt-2 text-sm ${installResult.error ? "text-red-600" : installResult.already ? "text-amber-600" : "text-emerald-600"}`}>
                {installResult.error || (installResult.already ? `Already installed on theme "${installResult.theme}"` : `Installed on theme "${installResult.theme}"!`)}
              </p>
            )}
            <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">Requires read_themes + write_themes Shopify scopes.</p>
          </div>
        )}

        {/* Manual Embed code */}
        {enabled && (
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <label className="mb-2 block text-sm font-medium text-zinc-900 dark:text-zinc-100">Manual Embed Code</label>
            <p className="mb-2 text-sm text-zinc-500">Or manually add this script to any website, just before &lt;/body&gt;.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {embedCode}
              </code>
              <button
                onClick={handleCopy}
                className="shrink-0 rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
