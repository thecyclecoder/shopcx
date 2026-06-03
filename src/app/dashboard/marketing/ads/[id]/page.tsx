"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

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
}

interface Segment {
  id: string;
  kind: "talking_head" | "broll" | "music";
  seq: number;
  version: number;
  script_text: string | null;
  model: string | null;
  trim_sec: number | null;
  status: string;
  preview_url: string | null;
}

export default function AdDetailPage() {
  const workspace = useWorkspace();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/ads/campaigns/${id}?workspaceId=${workspace.id}`);
    if (res.ok) {
      const d = await res.json();
      setCampaign(d.campaign);
      setVideos(d.videos || []);
      setSegments(d.segments || []);
    }
    setLoading(false);
  }, [id, workspace.id]);

  async function regenerate(seq: number, newScript: string) {
    const res = await fetch(`/api/ads/campaigns/${id}/segments/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, seq, new_script: newScript }),
    });
    setMessage(res.ok ? "Refreshing that beat and re-stitching. Check back shortly." : "Failed to queue refresh.");
    if (res.ok) load();
  }

  useEffect(() => {
    load();
  }, [load]);

  async function render() {
    setRendering(true);
    setMessage(null);
    const res = await fetch(`/api/ads/campaigns/${id}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    setMessage(res.ok ? "Render queued. Check back shortly." : "Failed to queue render.");
    setRendering(false);
  }

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
        <button
          onClick={render}
          disabled={rendering}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {rendering ? "Queuing…" : "Render"}
        </button>
      </div>

      {message && <p className="mb-4 text-sm text-emerald-600">{message}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Hero + audio */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Hero & audio</h2>
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
            </div>
          ) : (
            <p className="text-xs text-zinc-400">No hero image yet.</p>
          )}
          {campaign.audio_url ? (
            <div className="mt-4">
              <audio controls src={campaign.audio_url} className="w-full" />
              <a
                href={campaign.audio_url}
                download
                className="mt-1 inline-block text-xs text-indigo-600 hover:underline"
              >
                Download audio
              </a>
            </div>
          ) : (
            <p className="mt-4 text-xs text-zinc-400">No audio yet.</p>
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

      {/* Creative library — the pieces that make up this ad. Refresh one beat
          (e.g. a fatigued hook) and re-stitch without rebuilding everything. */}
      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Creative library</h2>
        <span className="text-xs text-zinc-400">Refresh one beat → re-stitch (reuses every other piece)</span>
      </div>
      {segments.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">No segments yet. Generate the talking head, b-roll, and render.</p>
      ) : (
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {segments.map((s) => (
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

      {/* Static outputs */}
      <h2 className="mt-8 mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Static formats</h2>
      {staticOutputs.length === 0 ? (
        <p className="text-sm text-zinc-500">No static outputs yet.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {staticOutputs.map((v) => (
            <StaticCard key={v.id} v={v} />
          ))}
        </div>
      )}
    </div>
  );
}

function SegmentCard({ s, onRegenerate }: { s: Segment; onRegenerate: (seq: number, script: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.script_text || "");
  const [busy, setBusy] = useState(false);
  const kindLabel = s.kind === "talking_head" ? `Hook beat #${s.seq + 1}` : s.kind === "broll" ? `B-roll #${s.seq + 1}` : "Music bed";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{kindLabel}</span>
        {s.version > 1 && <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">v{s.version}</span>}
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
        <p className="text-xs text-zinc-400">{s.status === "generating" ? "Generating…" : "No preview."}</p>
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
                  onClick={async () => { setBusy(true); await onRegenerate(s.seq, draft.trim()); setBusy(false); setEditing(false); }}
                  className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {busy ? "Queuing…" : "Regenerate & re-stitch"}
                </button>
                <button onClick={() => setEditing(false)} className="text-xs text-zinc-500 hover:underline">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setEditing(true)} className="text-xs text-indigo-600 hover:underline">Refresh this hook</button>
          )}
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
