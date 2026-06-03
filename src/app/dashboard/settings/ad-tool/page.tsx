"use client";

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { LIFE_FORCE_8, CAPTION_STYLES, type AdToolSettings } from "@/lib/ad-tool-config";

export default function AdToolSettingsPage() {
  const workspace = useWorkspace();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [bannedWords, setBannedWords] = useState("");
  const [lf8Allowed, setLf8Allowed] = useState<number[]>([]);
  const [uglyIntensity, setUglyIntensity] = useState<AdToolSettings["ugly_intensity"]>("heavy");
  const [captionStyle, setCaptionStyle] = useState<AdToolSettings["default_caption_style"]>("hormozi_yellow");
  const [pinnedBadges, setPinnedBadges] = useState("");
  const [costCapDollars, setCostCapDollars] = useState("10");

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/ad-tool-settings`);
    if (res.ok) {
      const s: AdToolSettings = await res.json();
      setBannedWords((s.banned_words || []).join("\n"));
      setLf8Allowed(s.lf8_allowed || []);
      setUglyIntensity(s.ugly_intensity);
      setCaptionStyle(s.default_caption_style);
      setPinnedBadges((s.pinned_badges || []).join("\n"));
      setCostCapDollars(((s.cost_cap_cents || 0) / 100).toString());
    }
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  function toggleLf8(slot: number) {
    setLf8Allowed((prev) =>
      prev.includes(slot) ? prev.filter((s) => s !== slot) : [...prev, slot].sort((a, b) => a - b),
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    const payload: Partial<AdToolSettings> = {
      banned_words: bannedWords
        .split("\n")
        .map((w) => w.trim())
        .filter(Boolean),
      lf8_allowed: lf8Allowed,
      ugly_intensity: uglyIntensity,
      default_caption_style: captionStyle,
      pinned_badges: pinnedBadges
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean),
      cost_cap_cents: Math.round(parseFloat(costCapDollars || "0") * 100),
    };
    const res = await fetch(`/api/workspaces/${workspace.id}/ad-tool-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setMessage("Saved.");
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Failed to save");
    }
    setSaving(false);
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <p className="text-sm text-zinc-400">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Ad tool</h1>
      <p className="mb-8 text-sm text-zinc-500">
        Brand guardrails for the ad generator — banned words, which Life Force 8 drives you may
        target, caption style, and cost cap.
      </p>

      <GeminiCard workspaceId={workspace.id} />

      <Section
        title="Banned words"
        subtitle="One per line. The script generator and validator reject any script containing these."
      >
        <textarea
          value={bannedWords}
          onChange={(e) => setBannedWords(e.target.value)}
          rows={6}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
      </Section>

      <Section
        title="Allowed Life Force 8 drives"
        subtitle="Only checked drives are eligible as angle anchors."
      >
        <div className="space-y-2">
          {Object.entries(LIFE_FORCE_8).map(([slotStr, label]) => {
            const slot = Number(slotStr);
            return (
              <label key={slot} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={lf8Allowed.includes(slot)}
                  onChange={() => toggleLf8(slot)}
                  className="mt-0.5"
                />
                <span className="text-zinc-700 dark:text-zinc-300">
                  <span className="font-semibold">#{slot}</span> {label}
                </span>
              </label>
            );
          })}
        </div>
      </Section>

      <Section title="Ugly intensity" subtitle="How raw / disruptive the creative direction leans.">
        <select
          value={uglyIntensity}
          onChange={(e) => setUglyIntensity(e.target.value as AdToolSettings["ugly_intensity"])}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <option value="mild">Mild</option>
          <option value="heavy">Heavy</option>
          <option value="extreme">Extreme</option>
        </select>
      </Section>

      <Section title="Default caption style" subtitle="Applied to new campaigns unless overridden.">
        <select
          value={captionStyle}
          onChange={(e) => setCaptionStyle(e.target.value as AdToolSettings["default_caption_style"])}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          {CAPTION_STYLES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Section>

      <Section
        title="Pinned credibility badges"
        subtitle="One per line, in display order. Used as always-on proof chips."
      >
        <textarea
          value={pinnedBadges}
          onChange={(e) => setPinnedBadges(e.target.value)}
          rows={4}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
      </Section>

      <Section title="Cost cap" subtitle="Maximum spend per ad before the pipeline aborts.">
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={costCapDollars}
            onChange={(e) => setCostCapDollars(e.target.value)}
            className="w-32 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          />
          <span className="text-sm text-zinc-500">per ad</span>
        </div>
      </Section>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        {error && <span className="text-sm text-red-500">{error}</span>}
        {message && <span className="text-sm text-emerald-600">{message}</span>}
      </div>
    </div>
  );
}

// Google AI Studio (Gemini) key — powers Nano Banana Pro holding shots, Veo 3.1
// Fast talking heads, and Lyria music. Without it the ad pipeline can't render.
function GeminiCard({ workspaceId }: { workspaceId: string }) {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/gemini`);
    if (res.ok) {
      const d = await res.json();
      setConnected(!!d.connected);
      setHint(d.hint || null);
      setProjectId(d.project_id || "");
    }
    setLoading(false);
  }, [workspaceId]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setBusy(true); setStatus(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/gemini`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey.trim() || undefined, project_id: projectId.trim() }),
    });
    const d = await res.json().catch(() => ({}));
    setStatus(res.ok ? (d.verified ? "Saved & verified ✓" : `Saved, but verify failed (HTTP ${d.status}).`) : "Save failed.");
    setApiKey("");
    setBusy(false);
    load();
  }
  async function verify() {
    setBusy(true); setStatus(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/gemini`, { method: "PATCH" });
    const d = await res.json().catch(() => ({}));
    setStatus(d.verified ? "Verified ✓" : `Verify failed (HTTP ${d.status}).`);
    setBusy(false);
  }

  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Google AI Studio (Gemini)</h2>
        {!loading && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${connected ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"}`}>
            {connected ? `connected ${hint || ""}` : "not connected"}
          </span>
        )}
      </div>
      <p className="mt-0.5 mb-4 text-xs text-zinc-500">
        Powers Nano Banana Pro holding shots, Veo 3.1 Fast talking heads, and Lyria music. Billing must be enabled on the Google Cloud project.
      </p>
      <div className="space-y-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={connected ? "Enter a new key to replace…" : "API key (AQ.… or AIza…)"}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
        <input
          type="text"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="Project ID (optional)"
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        />
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={busy || (!apiKey.trim() && !projectId.trim())} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
          {connected && <button onClick={verify} disabled={busy} className="text-xs text-indigo-600 hover:underline">Verify key</button>}
          {status && <span className="text-xs text-zinc-500">{status}</span>}
        </div>
      </div>
    </section>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      <p className="mt-0.5 mb-4 text-xs text-zinc-500">{subtitle}</p>
      {children}
    </section>
  );
}
