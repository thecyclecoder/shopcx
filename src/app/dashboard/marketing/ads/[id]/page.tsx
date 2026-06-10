"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { PublishToMeta } from "./PublishToMeta";

interface Campaign {
  id: string;
  name: string;
  status: string;
  script_text: string | null;
  hero_image_url: string | null;
  audio_url: string | null;
  products?: { title: string } | null;
}

interface Video {
  id: string;
  format: string;
  media_kind: string;
  format_variant_of_id: string | null;
  final_mp4_url: string | null;
  static_jpg_url: string | null;
  talking_head_url: string | null;
  duration_sec: number | null;
  status: string;
  meta?: { archetype?: string; error?: string } | null;
}

interface Segment {
  id: string;
  kind: "talking_head" | "broll" | "music";
  seq: number;
  version: number;
  script_text: string | null;
  prompt: string | null;
  model: string | null;
  trim_sec: number | null;
  status: string;
  error: string | null;
  preview_url: string | null;
}

interface BrollSource {
  slot: string;
  alt_text: string | null;
  url: string;
}

interface LibraryClip {
  id: string;
  prompt: string | null;
  model: string | null;
  source_url: string | null;
  preview_url: string | null;
}

export default function AdDetailPage() {
  const workspace = useWorkspace();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [brollSources, setBrollSources] = useState<BrollSource[]>([]);
  const [publishJobs, setPublishJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyStage, setBusyStage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [heroFeedback, setHeroFeedback] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/ads/campaigns/${id}?workspaceId=${workspace.id}`);
    if (res.ok) {
      const d = await res.json();
      setCampaign(d.campaign);
      setVideos(d.videos || []);
      setSegments(d.segments || []);
      setBrollSources(d.brollSources || []);
      setPublishJobs(d.publishJobs || []);
    }
    setLoading(false);
  }, [id, workspace.id]);

  // Add ONE b-roll clip: text-to-video or animate a chosen photo.
  async function addBroll(opts: { mode: "text" | "image"; prompt: string; sourceUrl?: string; model: "fast" | "full" }) {
    setMessage(null);
    const res = await fetch(`/api/ads/campaigns/${id}/broll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, mode: opts.mode, prompt: opts.prompt, source_url: opts.sourceUrl, model: opts.model }),
    });
    setMessage(res.ok ? "Generating a b-roll clip — it'll appear below when ready." : "Failed to queue b-roll.");
    if (res.ok) setTimeout(load, 1500);
  }
  // Reuse an existing library clip in this ad (no regeneration).
  async function reuseBroll(segId: string) {
    const res = await fetch(`/api/ads/campaigns/${id}/broll/reuse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, segId }),
    });
    setMessage(res.ok ? "Added from library." : "Failed to add from library.");
    if (res.ok) load();
  }
  // Generate a static ad (separate process) — one archetype, 3 formats.
  async function generateStatic(archetype: string) {
    setMessage(null);
    const res = await fetch(`/api/ads/campaigns/${id}/static`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, archetype }),
    });
    setMessage(res.ok ? "Generating static ad — appears below when ready." : "Failed to queue static ad.");
    if (res.ok) setTimeout(load, 1500);
  }

  // Discard a clip from this ad's cut (stays in the library).
  async function discardSegment(segId: string) {
    const res = await fetch(`/api/ads/campaigns/${id}/segments/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, segId }),
    });
    if (res.ok) load();
  }

  // Fire a stage (hero / talking-head / broll / render) and refresh.
  const runStage = useCallback(async (stage: string, label: string) => {
    setBusyStage(stage);
    setMessage(null);
    const res = await fetch(`/api/ads/campaigns/${id}/${stage}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    setMessage(res.ok ? `${label} queued — this runs in the background.` : `Failed to queue ${label.toLowerCase()}.`);
    setBusyStage(null);
    setTimeout(load, 1500);
  }, [id, workspace.id, load]);

  // Regenerate the hero with an optional free-text correction.
  async function regenerateHero() {
    setBusyStage("hero");
    setMessage(null);
    const res = await fetch(`/api/ads/campaigns/${id}/hero`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, feedback: heroFeedback.trim() || undefined }),
    });
    setMessage(res.ok ? "Regenerating the hero — check back shortly." : "Failed to queue hero.");
    setBusyStage(null);
    setHeroFeedback("");
    setTimeout(load, 1500);
  }

  async function regenerate(
    seq: number,
    opts: { kind?: "talking_head" | "broll"; model?: "fast" | "full"; newScript?: string; prompt?: string },
  ) {
    const res = await fetch(`/api/ads/campaigns/${id}/segments/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, seq, kind: opts.kind, model: opts.model, new_script: opts.newScript, prompt: opts.prompt }),
    });
    const hq = opts.model === "full";
    setMessage(res.ok ? `Regenerating that clip${hq ? " in HQ Veo 3" : ""} and re-stitching. Check back shortly.` : "Failed to queue regenerate.");
    if (res.ok) setTimeout(load, 1500);
  }

  useEffect(() => {
    load();
  }, [load]);

  // Poll while anything is generating/rendering so the operator watches it finish.
  const inFlight =
    (campaign?.status === "rendering") ||
    segments.some((s) => s.status === "generating") ||
    videos.some((v) => v.status === "rendering");
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [inFlight, load]);

  if (loading) {
    return (
      <div className="mx-auto max-w-screen-xl px-4 py-6">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="mx-auto max-w-screen-xl px-4 py-6">
        <p className="text-sm text-zinc-500">Ad not found.</p>
        <Link href="/dashboard/marketing/ads" className="text-sm text-indigo-600 hover:underline">
          Back to ads
        </Link>
      </div>
    );
  }

  const videoOutputs = videos.filter((v) => v.media_kind === "video");
  const staticOutputs = videos.filter((v) => v.media_kind === "static");

  // ── Production stages (staged, sequential, each points to the next) ─────────
  const talkingReady = segments.filter((s) => s.kind === "talking_head" && s.status === "ready");
  const talkingGenerating = segments.some((s) => s.kind === "talking_head" && s.status === "generating");
  const brollSegments = segments.filter((s) => s.kind === "broll");
  const musicReady = segments.filter((s) => s.kind === "music" && s.status === "ready");
  const musicGenerating = segments.some((s) => s.kind === "music" && s.status === "generating");
  const videoReady = videoOutputs.some((v) => v.status === "ready");
  const isRendering = campaign.status === "rendering" || videos.some((v) => v.status === "rendering");

  type StageState = "done" | "running" | "ready" | "blocked";
  const heroState: StageState = busyStage === "hero" ? "running" : campaign.hero_image_url ? "done" : "ready";
  const thState: StageState = busyStage === "talking-head" || talkingGenerating ? "running" : talkingReady.length ? "done" : campaign.hero_image_url ? "ready" : "blocked";
  const musicState: StageState = busyStage === "music" || musicGenerating ? "running" : musicReady.length ? "done" : "ready";
  const renderState: StageState = busyStage === "render" || isRendering ? "running" : videoReady ? "done" : talkingReady.length ? "ready" : "blocked";

  // B-roll is its own studio (add one at a time) — not a single staged button.
  const stages = [
    { key: "hero", n: 1, title: "Hero shot", detail: "Avatar holding the product (Nano Banana Pro)", state: heroState, action: () => runStage("hero", "Hero"), cta: campaign.hero_image_url ? "Regenerate" : "Generate", blockedNote: "" },
    { key: "talking-head", n: 2, title: "Talking head", detail: `Veo clips that speak the script (${talkingReady.length || "0"} ready)`, state: thState, action: () => runStage("talking-head", "Talking head"), cta: talkingReady.length ? "Regenerate all" : "Generate", blockedNote: "Generate the hero first" },
    { key: "music", n: 3, title: "Background music", detail: musicReady.length ? "Lyria music bed ready (preview below)" : "Lyria music bed — optional; auto-added at render if skipped", state: musicState, action: () => runStage("music", "Music"), cta: musicReady.length ? "Regenerate" : "Generate", blockedNote: "" },
    { key: "render", n: 4, title: "Render", detail: `Stitch talking head + ${brollSegments.filter((b) => b.status === "ready").length} b-roll + music + captions`, state: renderState, action: () => runStage("render", "Render"), cta: videoReady ? "Re-render" : "Render", blockedNote: "Generate the talking head first" },
  ];
  const nextStage = stages.find((s) => s.state === "ready")?.key;

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/dashboard/marketing/ads" className="text-xs text-indigo-600 hover:underline">
            ← Ads
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">{campaign.name}</h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-zinc-500">
            <span>{campaign.products?.title || "—"}</span>
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider dark:bg-zinc-800">
              {campaign.status}
            </span>
          </p>
        </div>
        {videoReady && (
          <span className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
            Ad ready ✓
          </span>
        )}
      </div>

      {message && <p className="mb-4 text-sm text-emerald-600">{message}</p>}

      {/* Production — staged, in order. Each stage lights up the next. */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Production</h2>
        <div className="space-y-2">
          {stages.map((s) => (
            <StageRow key={s.key} stage={s} isNext={nextStage === s.key} busy={busyStage !== null} />
          ))}
        </div>
        <p className="mt-3 text-xs text-zinc-400">
          Generate in order: hero → talking head → b-roll (optional) → render. Music is added automatically at render. Each stage runs in the background; this page updates itself.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Hero — the holding-product shot every Veo clip is built from.
            Add a comment + regenerate to fix anatomy/framing issues. */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Hero shot</h2>
          {campaign.hero_image_url ? (
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={campaign.hero_image_url}
                alt="Hero"
                className="w-full rounded-md border border-zinc-200 dark:border-zinc-800"
              />
              <a
                href={campaign.hero_image_url}
                download
                className="mt-2 inline-block text-xs text-indigo-600 hover:underline"
              >
                Download hero
              </a>
              <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Not quite right? Describe the fix and regenerate</label>
                <textarea
                  value={heroFeedback}
                  onChange={(e) => setHeroFeedback(e.target.value)}
                  rows={2}
                  placeholder="e.g. the hands look wrong relative to the arms; show both hands gripping the pouch naturally"
                  className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                />
                <button
                  onClick={regenerateHero}
                  disabled={busyStage !== null}
                  className="mt-2 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {busyStage === "hero" ? "Regenerating…" : "Regenerate hero"}
                </button>
                <p className="mt-1 text-[11px] text-zinc-400">Regenerating the hero won&apos;t change talking-head clips already made — re-generate those if you want them to use the new hero.</p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-400">No hero image yet — generate it in Production above.</p>
          )}
        </div>

        {/* Script */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Script</h2>
          <pre className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
            {campaign.script_text || "—"}
          </pre>
        </div>
      </div>

      {/* B-roll studio — add clips one at a time (text-to-video, animate a photo,
          or reuse from the library). Keep or discard. Any number works (incl. 0). */}
      <BrollStudio
        workspaceId={workspace.id}
        campaignId={id}
        clips={brollSegments}
        sources={brollSources}
        onAdd={addBroll}
        onReuse={reuseBroll}
        onRegenerate={regenerate}
        onDiscard={discardSegment}
      />

      {/* Creative library — the talking + music pieces. Refresh one beat (e.g. a
          fatigued hook) and re-stitch without rebuilding everything. */}
      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Talking head & music</h2>
        <span className="text-xs text-zinc-400">Refresh one beat → re-stitch (reuses every other piece)</span>
      </div>
      {segments.filter((s) => s.kind !== "broll").length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">No talking-head clips yet. Generate them in Production above.</p>
      ) : (
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {segments.filter((s) => s.kind !== "broll").map((s) => (
            <SegmentCard key={s.id} s={s} onRegenerate={regenerate} />
          ))}
        </div>
      )}

      {/* Video outputs */}
      <h2 className="mt-8 mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Video formats</h2>
      {videoOutputs.length === 0 ? (
        <p className="text-sm text-zinc-500">No video outputs yet. Render to produce them.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {videoOutputs.map((v) => (
            <VideoCard key={v.id} v={v} />
          ))}
        </div>
      )}

      {/* Publish the rendered video to Meta (Facebook/Instagram) ads. */}
      <PublishToMeta workspaceId={workspace.id} campaignId={id} videoReady={videoReady} publishJobs={publishJobs} onChange={load} />

      {/* Static ads — a separate, design-led process (not video frames). */}
      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Static ads</h2>
        <span className="text-xs text-zinc-400">Designed stills from your product data — 1:1 / 4:5 / 9:16</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {[
          { k: "review", label: "Review screenshot" },
          { k: "offer", label: "Offer card" },
          { k: "benefit_authority", label: "Benefit / authority" },
        ].map((a) => (
          <button
            key={a.k}
            onClick={() => generateStatic(a.k)}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            + {a.label}
          </button>
        ))}
      </div>
      {staticOutputs.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">No static ads yet. Generate one above — each makes 3 formats.</p>
      ) : (
        ["review", "offer", "benefit_authority"].map((arch) => {
          const rows = staticOutputs.filter((v) => v.meta?.archetype === arch);
          if (!rows.length) return null;
          const label = arch === "review" ? "Review screenshot" : arch === "offer" ? "Offer card" : "Benefit / authority";
          return (
            <div key={arch} className="mt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((v) => (
                  <StaticCard key={v.id} v={v} />
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

interface Stage {
  key: string;
  n: number;
  title: string;
  detail: string;
  state: "done" | "running" | "ready" | "blocked";
  action: () => void;
  cta: string;
  blockedNote: string;
}

function StageRow({ stage, isNext, busy }: { stage: Stage; isNext: boolean; busy: boolean }) {
  const dot =
    stage.state === "done" ? "bg-emerald-500" : stage.state === "running" ? "bg-amber-500 animate-pulse" : stage.state === "ready" ? "bg-indigo-500" : "bg-zinc-300 dark:bg-zinc-700";
  const disabled = busy || stage.state === "running" || stage.state === "blocked";
  return (
    <div className={`flex items-center gap-3 rounded-md border p-3 ${isNext ? "border-indigo-300 bg-indigo-50/50 dark:border-indigo-800 dark:bg-indigo-950/30" : "border-zinc-200 dark:border-zinc-800"}`}>
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ${dot}`}>
        {stage.state === "done" ? "✓" : stage.n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{stage.title}</span>
          {stage.state === "running" && <span className="text-[10px] uppercase tracking-wider text-amber-600">working…</span>}
          {isNext && stage.state === "ready" && <span className="text-[10px] uppercase tracking-wider text-indigo-600">next</span>}
        </div>
        <p className="truncate text-xs text-zinc-500">{stage.state === "blocked" ? stage.blockedNote : stage.detail}</p>
      </div>
      <button
        onClick={stage.action}
        disabled={disabled}
        className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${
          isNext ? "bg-indigo-600 text-white hover:bg-indigo-500" : "border border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        }`}
      >
        {stage.state === "running" ? "Working…" : stage.cta}
      </button>
    </div>
  );
}

function SegmentCard({ s, onRegenerate, onDiscard }: { s: Segment; onRegenerate: (seq: number, opts: { kind?: "talking_head" | "broll"; model?: "fast" | "full"; newScript?: string; prompt?: string }) => Promise<void>; onDiscard?: (segId: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.script_text || "");
  const [promptDraft, setPromptDraft] = useState(s.prompt || "");
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const kindLabel = s.kind === "talking_head" ? `Hook beat #${s.seq + 1}` : s.kind === "broll" ? `B-roll #${s.seq + 1}` : "Music bed";
  const isVeo = s.kind === "talking_head" || s.kind === "broll";
  const fast = (s.model || "").includes("fast");
  async function run(opts: { kind?: "talking_head" | "broll"; model?: "fast" | "full"; newScript?: string; prompt?: string }) {
    setBusy(true);
    await onRegenerate(s.seq, opts);
    setBusy(false);
    setEditing(false);
    setEditingPrompt(false);
  }
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{kindLabel}</span>
        {s.version > 1 && <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">v{s.version}</span>}
        {isVeo && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{fast ? "Veo Fast" : "Veo 3 HQ"}</span>}
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{s.status}</span>
        {s.trim_sec ? <span className="text-[10px] text-zinc-400">{s.trim_sec.toFixed(1)}s</span> : null}
      </div>
      {s.preview_url ? (
        s.kind === "music" ? (
          <audio controls src={s.preview_url} className="w-full" />
        ) : (
          <video controls src={s.preview_url} className="w-full rounded-md" />
        )
      ) : (
        <p className="text-xs text-zinc-400">{s.status === "generating" ? "Generating…" : s.status === "failed" ? `Failed${s.error ? `: ${s.error}` : ""}` : "No preview."}</p>
      )}
      {s.kind === "talking_head" && (
        <div className="mt-2">
          {s.script_text && <p className="mb-1 text-xs italic text-zinc-500">“{s.script_text}”</p>}
          {editing ? (
            <div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                placeholder="New words for this beat…"
              />
              <div className="mt-1 flex gap-2">
                <button
                  disabled={busy || !draft.trim()}
                  onClick={() => run({ kind: "talking_head", model: "fast", newScript: draft.trim() })}
                  className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {busy ? "Queuing…" : "Regenerate & re-stitch"}
                </button>
                <button onClick={() => setEditing(false)} className="text-xs text-zinc-500 hover:underline">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={() => setEditing(true)} disabled={busy} className="text-xs text-indigo-600 hover:underline disabled:opacity-50">Refresh this hook</button>
              <button onClick={() => run({ kind: "talking_head", model: "full" })} disabled={busy} className="text-xs text-indigo-600 hover:underline disabled:opacity-50">
                {busy ? "Queuing…" : "Regenerate in HQ (Veo 3)"}
              </button>
            </div>
          )}
        </div>
      )}
      {s.kind === "broll" && (
        <div className="mt-2">
          {editingPrompt ? (
            <div>
              <textarea
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                rows={4}
                className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                placeholder="Describe the shot + motion (e.g. slow push-in on the pouch, warm daylight, no morphing)…"
              />
              <div className="mt-1 flex flex-wrap gap-2">
                <button disabled={busy || !promptDraft.trim()} onClick={() => run({ kind: "broll", model: "fast", prompt: promptDraft.trim() })} className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{busy ? "Queuing…" : "Regenerate"}</button>
                <button disabled={busy || !promptDraft.trim()} onClick={() => run({ kind: "broll", model: "full", prompt: promptDraft.trim() })} className="rounded border border-indigo-300 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-800 dark:text-indigo-300">HQ (Veo 3)</button>
                <button onClick={() => setEditingPrompt(false)} className="text-xs text-zinc-500 hover:underline">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={() => run({ kind: "broll", model: "fast" })} disabled={busy} className="text-xs text-indigo-600 hover:underline disabled:opacity-50">Regenerate</button>
              <button onClick={() => run({ kind: "broll", model: "full" })} disabled={busy} className="text-xs text-indigo-600 hover:underline disabled:opacity-50">{busy ? "Queuing…" : "Regenerate in HQ (Veo 3)"}</button>
              <button onClick={() => { setPromptDraft(s.prompt || ""); setEditingPrompt(true); }} disabled={busy} className="text-xs text-zinc-500 hover:underline disabled:opacity-50">Edit shot prompt</button>
              {onDiscard && <button onClick={() => onDiscard(s.id)} disabled={busy} className="text-xs text-red-500 hover:underline disabled:opacity-50">Discard</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BrollStudio({
  workspaceId, campaignId, clips, sources, onAdd, onReuse, onRegenerate, onDiscard,
}: {
  workspaceId: string;
  campaignId: string;
  clips: Segment[];
  sources: BrollSource[];
  onAdd: (opts: { mode: "text" | "image"; prompt: string; sourceUrl?: string; model: "fast" | "full" }) => Promise<void>;
  onReuse: (segId: string) => Promise<void>;
  onRegenerate: (seq: number, opts: { kind?: "talking_head" | "broll"; model?: "fast" | "full"; newScript?: string; prompt?: string }) => Promise<void>;
  onDiscard: (segId: string) => void;
}) {
  const [mode, setMode] = useState<"text" | "photo" | "library">("text");
  const [prompt, setPrompt] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [model, setModel] = useState<"fast" | "full">("fast");
  const [busy, setBusy] = useState(false);
  const [library, setLibrary] = useState<LibraryClip[] | null>(null);

  async function openLibrary() {
    setMode("library");
    if (library === null) {
      const res = await fetch(`/api/ads/broll-library?workspaceId=${workspaceId}&excludeCampaign=${campaignId}`);
      setLibrary(res.ok ? (await res.json()).clips || [] : []);
    }
  }
  async function add() {
    setBusy(true);
    if (mode === "text") await onAdd({ mode: "text", prompt: prompt.trim(), model });
    else if (mode === "photo" && picked) await onAdd({ mode: "image", prompt: prompt.trim(), sourceUrl: picked, model });
    setBusy(false);
    setPrompt("");
    setPicked(null);
  }
  const tab = (k: "text" | "photo" | "library", label: string) => (
    <button
      onClick={() => (k === "library" ? openLibrary() : setMode(k))}
      className={`rounded-md px-3 py-1.5 text-xs font-medium ${mode === k ? "bg-indigo-600 text-white" : "border border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="mt-8">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">B-roll</h2>
        <span className="text-xs text-zinc-400">Add clips one at a time — any number works (or none)</span>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 flex flex-wrap gap-2">
          {tab("text", "Describe (text → video)")}
          {tab("photo", "Animate a photo")}
          {tab("library", "From library")}
        </div>

        {mode === "library" ? (
          library === null ? (
            <p className="text-xs text-zinc-400">Loading library…</p>
          ) : library.length === 0 ? (
            <p className="text-xs text-zinc-400">No reusable b-roll yet. Make some with Describe or Animate a photo.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {library.map((c) => (
                <div key={c.id} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                  {c.preview_url ? <video src={c.preview_url} className="w-full rounded" muted loop onMouseOver={(e) => e.currentTarget.play()} onMouseOut={(e) => e.currentTarget.pause()} /> : <div className="h-24 rounded bg-zinc-100 dark:bg-zinc-800" />}
                  <button onClick={() => onReuse(c.id)} className="mt-1 w-full rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500">Add to this ad</button>
                </div>
              ))}
            </div>
          )
        ) : (
          <div>
            {mode === "photo" && (
              <div className="mb-3">
                <p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Pick a photo to animate</p>
                {sources.length === 0 ? (
                  <p className="text-xs text-zinc-400">No product photos available.</p>
                ) : (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {sources.map((src) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={src.url}
                        src={src.url}
                        alt={src.alt_text || src.slot}
                        onClick={() => setPicked(src.url)}
                        className={`h-20 w-20 shrink-0 cursor-pointer rounded-md object-cover ${picked === src.url ? "ring-2 ring-indigo-500" : "border border-zinc-200 dark:border-zinc-800"}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder={mode === "text" ? "Describe the b-roll scene (e.g. close-up of coffee being poured into a mug, steam rising, warm morning light)…" : "Optional: guide the motion (e.g. slow push-in, gentle drift, no morphing)…"}
              className="w-full rounded-md border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                <input type="radio" checked={model === "fast"} onChange={() => setModel("fast")} /> Veo Fast
              </label>
              <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                <input type="radio" checked={model === "full"} onChange={() => setModel("full")} /> Veo 3 HQ
              </label>
              <button
                onClick={add}
                disabled={busy || (mode === "text" && !prompt.trim()) || (mode === "photo" && !picked)}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {busy ? "Queuing…" : "Add b-roll clip"}
              </button>
            </div>
          </div>
        )}
      </div>

      {clips.length > 0 && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {clips.map((s) => (
            <SegmentCard key={s.id} s={s} onRegenerate={onRegenerate} onDiscard={onDiscard} />
          ))}
        </div>
      )}
    </div>
  );
}

function FormatHeader({ v }: { v: Video }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
        {v.format}
      </span>
      {v.format_variant_of_id && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
          variant
        </span>
      )}
      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">
        {v.status}
      </span>
    </div>
  );
}

function VideoCard({ v }: { v: Video }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <FormatHeader v={v} />
      {v.final_mp4_url ? (
        <>
          <video controls src={v.final_mp4_url} className="w-full rounded-md" />
          <a href={v.final_mp4_url} download className="mt-2 inline-block text-xs text-indigo-600 hover:underline">
            Download MP4
          </a>
        </>
      ) : (
        <p className="text-xs text-zinc-400">Not rendered yet.</p>
      )}
    </div>
  );
}

function StaticCard({ v }: { v: Video }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <FormatHeader v={v} />
      {v.static_jpg_url ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={v.static_jpg_url} alt={v.format} className="w-full rounded-md" />
          <a href={v.static_jpg_url} download className="mt-2 inline-block text-xs text-indigo-600 hover:underline">
            Download JPG
          </a>
        </>
      ) : (
        <p className="text-xs text-zinc-400">Not produced yet.</p>
      )}
    </div>
  );
}
