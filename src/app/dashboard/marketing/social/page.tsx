"use client";

/**
 * Social Publisher — the automated organic content scheduler.
 * View what's posted + queued, tune cadence/target pages, declare promos.
 * See docs/brain/specs/automated-social-scheduler.md.
 */

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Post {
  id: string; platform: string; post_type: string; source_kind: string;
  caption: string | null; scheduled_at: string; status: string;
  published_permalink: string | null; error: string | null; media_url: string | null;
}
interface Page { id: string; platform: string; meta_page_name: string | null; meta_instagram_id: string | null; }
interface Promo { id: string; name: string; starts_on: string; ends_on: string; brief: string; active: boolean; boost_per_platform_per_day: number | null; }
interface Config {
  enabled: boolean; require_approval: boolean; timezone: string;
  cadence: { reel: number; feed: number; story: number };
  min_resource_reuse_days: number; max_posts_per_platform_per_day: number;
  target_meta_page_ids: string[];
}

const badge = (text: string, color: string) => (
  <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>{text}</span>
);
const platformColor = (p: string) => p === "instagram" ? "bg-pink-500/15 text-pink-300" : "bg-blue-500/15 text-blue-300";
const statusColor = (s: string) => ({
  scheduled: "bg-indigo-500/15 text-indigo-300", draft: "bg-amber-500/15 text-amber-300",
  publishing: "bg-cyan-500/15 text-cyan-300", posted: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-red-500/15 text-red-300", cancelled: "bg-zinc-600/30 text-zinc-400",
}[s] || "bg-zinc-700 text-zinc-300");

export default function SocialPublisherPage() {
  const workspace = useWorkspace();
  const [config, setConfig] = useState<Config | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [upcoming, setUpcoming] = useState<Post[]>([]);
  const [recent, setRecent] = useState<Post[]>([]);
  const [promos, setPromos] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [newPromo, setNewPromo] = useState({ name: "", starts_on: "", ends_on: "", brief: "", boost: "" });

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/social`);
    const d = await res.json();
    setConfig(d.config); setPages(d.pages); setUpcoming(d.upcoming); setRecent(d.recent); setPromos(d.promos);
    setLoading(false);
  }, [workspace.id]);
  useEffect(() => { load(); }, [load]);

  const saveConfig = async (patch: Partial<Config>) => {
    if (!config) return;
    setSaving(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/social`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const d = await res.json(); setConfig(d.config); setSaving(false);
  };
  const planNow = async () => { await fetch(`/api/workspaces/${workspace.id}/social`, { method: "POST" }); setTimeout(load, 2500); };
  const postAction = async (postId: string, body: Record<string, unknown>) => {
    await fetch(`/api/workspaces/${workspace.id}/social/posts/${postId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    load();
  };
  const addPromo = async () => {
    if (!newPromo.name || !newPromo.starts_on || !newPromo.ends_on || !newPromo.brief) return;
    await fetch(`/api/workspaces/${workspace.id}/social/promos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...newPromo, boost_per_platform_per_day: newPromo.boost ? Number(newPromo.boost) : null }) });
    setNewPromo({ name: "", starts_on: "", ends_on: "", brief: "", boost: "" }); load();
  };
  const togglePromo = async (p: Promo, del = false) => {
    await fetch(`/api/workspaces/${workspace.id}/social/promos`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ promo_id: p.id, active: !p.active, delete: del }) });
    load();
  };

  if (loading || !config) return <div className="p-8 text-zinc-400">Loading…</div>;

  const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const togglePage = (pageId: string) => {
    const ids = config.target_meta_page_ids.includes(pageId) ? config.target_meta_page_ids.filter((x) => x !== pageId) : [...config.target_meta_page_ids, pageId];
    saveConfig({ target_meta_page_ids: ids });
  };

  const PostRow = ({ p, showActions }: { p: Post; showActions: boolean }) => (
    <div className="flex items-start gap-3 border-b border-zinc-800 py-3">
      <div className="w-28 shrink-0 text-xs text-zinc-400">{fmt(p.scheduled_at)}</div>
      <div className="flex shrink-0 flex-col gap-1">
        {badge(p.platform, platformColor(p.platform))}
        {badge(p.post_type, "bg-zinc-700 text-zinc-300")}
      </div>
      <div className="min-w-0 flex-1">
        {editId === p.id ? (
          <div className="flex flex-col gap-1">
            <textarea className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100" rows={3} value={editText} onChange={(e) => setEditText(e.target.value)} />
            <div className="flex gap-2">
              <button className="rounded bg-indigo-600 px-2 py-1 text-xs" onClick={() => { postAction(p.id, { caption: editText }); setEditId(null); }}>Save</button>
              <button className="rounded bg-zinc-700 px-2 py-1 text-xs" onClick={() => setEditId(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-sm text-zinc-200">{p.caption || <span className="text-zinc-500 italic">no caption</span>}</p>
        )}
        <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
          <span>{p.source_kind}</span>
          {badge(p.status, statusColor(p.status))}
          {p.error && <span className="text-red-400">{p.error}</span>}
          {p.published_permalink && <a href={p.published_permalink} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">view ↗</a>}
        </div>
      </div>
      {showActions && editId !== p.id && (
        <div className="flex shrink-0 gap-1.5">
          {["draft", "scheduled", "failed"].includes(p.status) && <button className="rounded bg-zinc-700 px-2 py-1 text-xs hover:bg-zinc-600" onClick={() => { setEditId(p.id); setEditText(p.caption || ""); }}>Edit</button>}
          {p.status === "draft" && <button className="rounded bg-emerald-600 px-2 py-1 text-xs" onClick={() => postAction(p.id, { action: "approve" })}>Approve</button>}
          {["draft", "scheduled", "failed"].includes(p.status) && <button className="rounded bg-indigo-600 px-2 py-1 text-xs" onClick={() => postAction(p.id, { action: "post_now" })}>Post now</button>}
          {["draft", "scheduled"].includes(p.status) && <button className="rounded bg-zinc-700 px-2 py-1 text-xs hover:bg-red-900" onClick={() => postAction(p.id, { action: "cancel" })}>Cancel</button>}
        </div>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl p-6 text-zinc-100">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Social Publisher</h1>
          <p className="text-sm text-zinc-400">Automated organic posts, reels & stories to Facebook + Instagram.</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={planNow} className="rounded bg-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-600">Plan next 7 days</button>
          <label className="flex items-center gap-2 text-sm">
            <span className={config.enabled ? "text-emerald-400" : "text-zinc-500"}>{config.enabled ? "On" : "Off"}</span>
            <input type="checkbox" checked={config.enabled} onChange={(e) => saveConfig({ enabled: e.target.checked })} className="h-4 w-4" />
          </label>
        </div>
      </div>

      {/* Settings */}
      <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Settings {saving && <span className="text-xs text-zinc-500">saving…</span>}</h2>
        <div className="mb-3">
          <div className="mb-1 text-xs text-zinc-400">Target pages</div>
          <div className="flex flex-wrap gap-2">
            {pages.map((pg) => (
              <button key={pg.id} onClick={() => togglePage(pg.id)} className={`rounded border px-2 py-1 text-xs ${config.target_meta_page_ids.includes(pg.id) ? "border-indigo-500 bg-indigo-500/15 text-indigo-200" : "border-zinc-700 text-zinc-400"}`}>
                {pg.meta_page_name || pg.id.slice(0, 8)} · {pg.platform}
              </button>
            ))}
            {!pages.length && <span className="text-xs text-zinc-500">No connected Meta pages.</span>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["reel", "feed", "story"] as const).map((t) => (
            <label key={t} className="text-xs text-zinc-400">{t}/week
              <input type="number" min={0} max={14} value={config.cadence[t]} onChange={(e) => saveConfig({ cadence: { ...config.cadence, [t]: Number(e.target.value) } })} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" />
            </label>
          ))}
          <label className="text-xs text-zinc-400">max/platform/day
            <input type="number" min={1} max={10} value={config.max_posts_per_platform_per_day} onChange={(e) => saveConfig({ max_posts_per_platform_per_day: Number(e.target.value) })} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" />
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
          <input type="checkbox" checked={config.require_approval} onChange={(e) => saveConfig({ require_approval: e.target.checked })} /> Require approval before publishing (posts land as drafts)
        </label>
      </div>

      {/* Promos */}
      <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Promos & seasonal campaigns</h2>
        {promos.map((p) => (
          <div key={p.id} className="mb-2 flex items-center gap-3 text-sm">
            <span className="font-medium">{p.name}</span>
            <span className="text-xs text-zinc-500">{p.starts_on} → {p.ends_on}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{p.brief}</span>
            {badge(p.active ? "active" : "off", p.active ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-700 text-zinc-400")}
            <button className="text-xs text-zinc-400 hover:underline" onClick={() => togglePromo(p)}>{p.active ? "disable" : "enable"}</button>
            <button className="text-xs text-red-400 hover:underline" onClick={() => togglePromo(p, true)}>delete</button>
          </div>
        ))}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <input placeholder="Name (e.g. July 4th)" value={newPromo.name} onChange={(e) => setNewPromo({ ...newPromo, name: e.target.value })} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm" />
          <input type="date" value={newPromo.starts_on} onChange={(e) => setNewPromo({ ...newPromo, starts_on: e.target.value })} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm" />
          <input type="date" value={newPromo.ends_on} onChange={(e) => setNewPromo({ ...newPromo, ends_on: e.target.value })} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm" />
          <input placeholder="Brief (offer/angle/CTA)" value={newPromo.brief} onChange={(e) => setNewPromo({ ...newPromo, brief: e.target.value })} className="col-span-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm sm:col-span-1" />
          <button onClick={addPromo} className="rounded bg-indigo-600 px-3 py-1 text-sm sm:col-span-1">Add promo</button>
        </div>
      </div>

      {/* Upcoming */}
      <h2 className="mb-2 text-sm font-semibold text-zinc-300">Scheduled ({upcoming.length})</h2>
      <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/30 px-4">
        {upcoming.length ? upcoming.map((p) => <PostRow key={p.id} p={p} showActions />) : <p className="py-6 text-center text-sm text-zinc-500">Nothing scheduled. Turn it on + pick target pages, then “Plan next 7 days”.</p>}
      </div>

      {/* Recent */}
      <h2 className="mb-2 text-sm font-semibold text-zinc-300">Recently posted</h2>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 px-4">
        {recent.length ? recent.map((p) => <PostRow key={p.id} p={p} showActions={false} />) : <p className="py-6 text-center text-sm text-zinc-500">No posts yet.</p>}
      </div>
    </div>
  );
}
