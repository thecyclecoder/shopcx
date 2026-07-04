"use client";

// Marketing → Lander uploads (content-upload-and-lander-build.md Phase 1). Owner-facing surface
// that lists every lander_blueprint in `awaiting_upload` and, per blueprint, one card per open
// lander_content_gap Carrie flagged (a real-evidence asset she'd never ethically fabricate). Each
// card renders her plain-language description + a preview of the block it feeds + a drag-drop
// uploader; on success the card flips to resolved with a thumbnail. When the last gap on a
// blueprint resolves, the row advances to `content_complete` (server-side) and the card lists it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface SkeletonBlock {
  role: string;
  purpose: string;
  levers?: string[];
  notes?: string;
}
interface ContentBlock {
  role: string;
  copy: string;
}
interface Gap {
  id: string;
  asset_role: string;
  block_ref: string;
  description: string;
  status: "open" | "resolved";
  resolved_url?: string | null;
  resolved_caption?: string | null;
}
interface Blueprint {
  id: string;
  product_id: string;
  product: { id: string; title: string | null; handle: string | null } | null;
  funnel_type: string;
  status: string;
  rationale: string | null;
  skeleton: { blocks: SkeletonBlock[]; hypothesis?: string } | null;
  content: { blocks: ContentBlock[]; cta?: string } | null;
  created_at: string;
  gaps: Gap[];
}

const ROLE_LABEL: Record<string, string> = {
  before_after: "Before / after",
  ugc: "Real customer selfie / UGC",
  testimonial_photo: "Testimonial photo",
  press_logo: "Press / certification logo",
  other: "Real-world asset",
};

export default function LanderUploadsPage() {
  const workspace = useWorkspace();
  const [blueprints, setBlueprints] = useState<Blueprint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/marketing/landers/blueprints?workspaceId=${workspace.id}`);
    if (res.status === 403) { setError("Owner-only surface."); setBlueprints([]); return; }
    if (!res.ok) { setError("Couldn't load blueprints."); setBlueprints([]); return; }
    const data = await res.json();
    setBlueprints(data.blueprints || []);
  }, [workspace.id]);

  useEffect(() => { load(); }, [load]);

  const onUploaded = useCallback((blueprintId: string, gapId: string, mediaUrl: string, blueprintComplete: boolean) => {
    setBlueprints((prev) => {
      if (!prev) return prev;
      return prev.map((b) => {
        if (b.id !== blueprintId) return b;
        const nextGaps = b.gaps.map((g): Gap =>
          g.id === gapId ? { ...g, status: "resolved", resolved_url: mediaUrl } : g,
        );
        return {
          ...b,
          status: blueprintComplete ? "content_complete" : b.status,
          gaps: nextGaps,
        };
      });
    });
  }, []);

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Lander content uploads</h1>
      <p className="mb-8 max-w-2xl text-sm text-zinc-500">
        Carrie can't fabricate a real customer&apos;s result or a press logo — she flags them here as
        gaps. Upload the real asset per gap; it becomes permanent product intelligence (reusable
        across future landers), the gap flips resolved, and once every gap on a blueprint is filled
        the build automatically hands off to Ada / Platform.
      </p>

      {error && (
        <div className="mb-6 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
          {error}
        </div>
      )}

      {blueprints === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : blueprints.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No blueprints are waiting for uploads. When Cleo drafts a new lander and Carrie flags
          real-evidence gaps, they&apos;ll show up here.
        </p>
      ) : (
        <div className="space-y-8">
          {blueprints.map((b) => (
            <BlueprintCard key={b.id} blueprint={b} workspaceId={workspace.id} onUploaded={onUploaded} />
          ))}
        </div>
      )}
    </div>
  );
}

function BlueprintCard({
  blueprint,
  workspaceId,
  onUploaded,
}: {
  blueprint: Blueprint;
  workspaceId: string;
  onUploaded: (blueprintId: string, gapId: string, mediaUrl: string, complete: boolean) => void;
}) {
  const openCount = blueprint.gaps.filter((g) => g.status === "open").length;
  const isComplete = blueprint.status === "content_complete";
  const contentByRole = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of blueprint.content?.blocks || []) m.set(c.role, c.copy);
    return m;
  }, [blueprint.content]);

  return (
    <section className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex flex-col gap-1 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800/60">
        <div className="flex items-center justify-between gap-4">
          <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {blueprint.product?.title || "Untitled product"}
          </h2>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
              isComplete
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
            }`}
          >
            {isComplete ? "Content complete — build queued" : `${openCount} upload${openCount === 1 ? "" : "s"} needed`}
          </span>
        </div>
        <p className="text-xs text-zinc-500">
          Funnel: <span className="font-medium text-zinc-600 dark:text-zinc-400">{blueprint.funnel_type}</span>
          {blueprint.product?.handle ? <> · handle <code>{blueprint.product.handle}</code></> : null}
        </p>
        {blueprint.rationale && (
          <p className="mt-2 text-sm italic text-zinc-500 dark:text-zinc-400">
            Carrie: {blueprint.rationale}
          </p>
        )}
      </header>

      <div className="grid gap-4 p-5 md:grid-cols-2">
        {blueprint.gaps.length === 0 ? (
          <p className="text-sm text-zinc-500">No open gaps left — awaiting build handoff.</p>
        ) : (
          blueprint.gaps.map((gap) => (
            <GapCard
              key={gap.id}
              gap={gap}
              blueprintId={blueprint.id}
              workspaceId={workspaceId}
              blockCopy={contentByRole.get(gap.block_ref) || null}
              onUploaded={onUploaded}
            />
          ))
        )}
      </div>
    </section>
  );
}

function GapCard({
  gap,
  blueprintId,
  workspaceId,
  blockCopy,
  onUploaded,
}: {
  gap: Gap;
  blueprintId: string;
  workspaceId: string;
  blockCopy: string | null;
  onUploaded: (blueprintId: string, gapId: string, mediaUrl: string, complete: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState<"idle" | "uploading" | "error">(gap.status === "resolved" ? "idle" : "idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(gap.resolved_url || null);

  const resolved = gap.status === "resolved" || !!resolvedUrl;

  const upload = useCallback(async (file: File) => {
    setStatus("uploading");
    setErrorMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/marketing/landers/gaps/${gap.id}/upload?workspaceId=${workspaceId}`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus("error");
      setErrorMsg(data.error || `Upload failed (${res.status})`);
      return;
    }
    const data = await res.json();
    setResolvedUrl(data.media?.url || null);
    setStatus("idle");
    onUploaded(blueprintId, gap.id, data.media?.url || "", !!data.blueprint_complete);
  }, [blueprintId, gap.id, workspaceId, onUploaded]);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) upload(file);
  }, [upload]);

  const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload(file);
  }, [upload]);

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-zinc-50/40 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300">
            {ROLE_LABEL[gap.asset_role] || gap.asset_role}
          </span>
          <p className="mt-1.5 text-xs text-zinc-500">
            Feeds block <code className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] dark:bg-zinc-800">{gap.block_ref}</code>
          </p>
        </div>
        {resolved && (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            Resolved
          </span>
        )}
      </div>

      <p className="text-sm text-zinc-700 dark:text-zinc-300">{gap.description}</p>

      {blockCopy && (
        <div className="rounded border border-zinc-200 bg-white px-3 py-2 text-xs italic text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-500">
          Block copy: {blockCopy.length > 220 ? `${blockCopy.slice(0, 220)}…` : blockCopy}
        </div>
      )}

      {resolved && resolvedUrl ? (
        <div className="flex items-center gap-3 rounded border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={resolvedUrl}
            alt="Uploaded asset preview"
            className="h-16 w-16 rounded object-cover"
          />
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            Saved to product intelligence.
          </span>
        </div>
      ) : (
        <div
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center text-xs transition ${
            dragOver
              ? "border-indigo-400 bg-indigo-50/60 text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-300"
              : "border-zinc-300 text-zinc-500 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/*,video/mp4,video/quicktime"
            onChange={onPick}
            className="hidden"
            disabled={status === "uploading"}
          />
          {status === "uploading" ? "Uploading…" : "Drag & drop or click to upload"}
        </div>
      )}

      {status === "error" && errorMsg && (
        <p className="text-xs text-rose-600 dark:text-rose-400">{errorMsg}</p>
      )}
    </article>
  );
}
