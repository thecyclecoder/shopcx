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
  preview_url: string | null; is_video: boolean;
  reach: number | null; likes: number | null; comments: number | null; saves: number | null; shares: number | null; engagement: number | null;
}
interface Page { id: string; platform: string; meta_page_name: string | null; meta_instagram_id: string | null; }
interface Promo { id: string; name: string; starts_on: string; ends_on: string; brief: string; active: boolean; boost_per_platform_per_day: number | null; emphasis_product_id: string | null; generated_media: { post_type: string; url: string }[]; graphics_status: string; }
interface Product { id: string; title: string; has_isolated: boolean; }
interface Config {
  enabled: boolean; require_approval: boolean; timezone: string;
  cadence: { reel: number; feed: number; story: number };
  min_resource_reuse_days: number; max_posts_per_platform_per_day: number;
  target_meta_page_ids: string[];
}

const card = "rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/50";
const input = "rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
const btnGray = "rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-600";

const badge = (text: string, color: string) => (
  <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>{text}</span>
);
const platformColor = (p: string) => p === "instagram" ? "bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300" : "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300";
const statusColor = (s: string) => ({
  scheduled: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
  draft: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  publishing: "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
  posted: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  cancelled: "bg-zinc-200 text-zinc-500 dark:bg-zinc-600/30 dark:text-zinc-400",
}[s] || "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300");

export default function SocialPublisherPage() {
  const workspace = useWorkspace();
  const [config, setConfig] = useState<Config | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [upcoming, setUpcoming] = useState<Post[]>([]);
  const [recent, setRecent] = useState<Post[]>([]);
  const [promos, setPromos] = useState<Promo[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [freqHint, setFreqHint] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [newPromo, setNewPromo] = useState({ name: "", starts_on: "", ends_on: "", brief: "", boost: "", emphasis_product_id: "" });

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/social`);
    const d = await res.json();
    setConfig(d.config); setPages(d.pages); setUpcoming(d.upcoming); setRecent(d.recent); setPromos(d.promos); setProducts(d.products || []); setFreqHint(d.freqHint || "");
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
    await fetch(`/api/workspaces/${workspace.id}/social/promos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...newPromo, emphasis_product_id: newPromo.emphasis_product_id || null, boost_per_platform_per_day: newPromo.boost ? Number(newPromo.boost) : null }) });
    setNewPromo({ name: "", starts_on: "", ends_on: "", brief: "", boost: "", emphasis_product_id: "" }); load();
  };
  const togglePromo = async (p: Promo, del = false) => {
    await fetch(`/api/workspaces/${workspace.id}/social/promos`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ promo_id: p.id, active: !p.active, delete: del }) });
    load();
  };
  const regenGraphics = async (p: Promo) => {
    await fetch(`/api/workspaces/${workspace.id}/social/promos`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ promo_id: p.id, regenerate: true }) });
    load();
  };

  if (loading || !config) return <div className="p-8 text-zinc-500">Loading…</div>;

  const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const togglePage = (pageId: string) => {
    const ids = config.target_meta_page_ids.includes(pageId) ? config.target_meta_page_ids.filter((x) => x !== pageId) : [...config.target_meta_page_ids, pageId];
    saveConfig({ target_meta_page_ids: ids });
  };

  const PostRow = ({ p, showActions }: { p: Post; showActions: boolean }) => (
    <div className="flex items-start gap-3 border-b border-zinc-200 py-3 last:border-0 dark:border-zinc-800">
      <div className="w-24 shrink-0 text-xs text-zinc-500">{fmt(p.scheduled_at)}</div>
      <a href={p.preview_url || undefined} target="_blank" rel="noreferrer" className="relative block h-24 w-[72px] shrink-0 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800" title="Open full size">
        {p.preview_url ? (
          p.is_video
            ? <video src={p.preview_url} className="h-full w-full object-cover" muted playsInline preload="metadata" />
            : <img src={p.preview_url} alt="" className="h-full w-full object-cover" />
        ) : <div className="flex h-full w-full items-center justify-center text-[9px] text-zinc-400">no media</div>}
        {p.is_video && <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[9px] text-white">▶ reel</span>}
      </a>
      <div className="flex shrink-0 flex-col gap-1">
        {badge(p.platform, platformColor(p.platform))}
        {badge(p.post_type, "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300")}
      </div>
      <div className="min-w-0 flex-1">
        {editId === p.id ? (
          <div className="flex flex-col gap-1">
            <textarea className={`w-full p-2 ${input}`} rows={3} value={editText} onChange={(e) => setEditText(e.target.value)} />
            <div className="flex gap-2">
              <button className="rounded bg-indigo-600 px-2 py-1 text-xs text-white" onClick={() => { postAction(p.id, { caption: editText }); setEditId(null); }}>Save</button>
              <button className={btnGray} onClick={() => setEditId(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{p.caption || <span className="italic text-zinc-400">no caption</span>}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          <span>{p.source_kind}</span>
          {badge(p.status, statusColor(p.status))}
          {p.status === "posted" && p.engagement != null && (
            <span className="text-zinc-600 dark:text-zinc-400">{p.reach != null ? `${p.reach} reach · ` : ""}♥ {p.likes ?? 0} · 💬 {p.comments ?? 0}{p.saves != null ? ` · 🔖 ${p.saves}` : ""}{p.shares != null ? ` · ↗ ${p.shares}` : ""}</span>
          )}
          {p.error && <span className="text-red-500">{p.error}</span>}
          {p.published_permalink && <a href={p.published_permalink} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline dark:text-indigo-400">view ↗</a>}
        </div>
      </div>
      {showActions && editId !== p.id && (
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {["draft", "scheduled", "failed"].includes(p.status) && <button className={btnGray} onClick={() => { setEditId(p.id); setEditText(p.caption || ""); }}>Edit</button>}
          {p.status === "draft" && <button className="rounded bg-emerald-600 px-2 py-1 text-xs text-white" onClick={() => postAction(p.id, { action: "approve" })}>Approve</button>}
          {["draft", "scheduled", "failed"].includes(p.status) && <button className="rounded bg-indigo-600 px-2 py-1 text-xs text-white" onClick={() => postAction(p.id, { action: "post_now" })}>Post now</button>}
          {["draft", "scheduled"].includes(p.status) && <button className="rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-700 hover:bg-red-100 hover:text-red-700 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-red-900 dark:hover:text-red-200" onClick={() => postAction(p.id, { action: "cancel" })}>Cancel</button>}
        </div>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl p-6 text-zinc-900 dark:text-zinc-100">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Social Publisher</h1>
          <p className="text-sm text-zinc-500">Automated organic posts, reels &amp; stories to Facebook + Instagram.</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={planNow} className="rounded bg-zinc-100 px-3 py-1.5 text-sm text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600">Plan next 7 days</button>
          <label className="flex items-center gap-2 text-sm">
            <span className={config.enabled ? "font-medium text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}>{config.enabled ? "On" : "Off"}</span>
            <input type="checkbox" checked={config.enabled} onChange={(e) => saveConfig({ enabled: e.target.checked })} className="h-4 w-4 accent-indigo-600" />
          </label>
        </div>
      </div>

      {/* Settings */}
      <div className={`mb-6 ${card}`}>
        <h2 className="mb-3 text-sm font-semibold">Settings {saving && <span className="text-xs font-normal text-zinc-400">saving…</span>}</h2>
        <div className="mb-3">
          <div className="mb-1 text-xs text-zinc-500">Target pages</div>
          <div className="flex flex-wrap gap-2">
            {pages.map((pg) => (
              <button key={pg.id} onClick={() => togglePage(pg.id)} className={`rounded border px-2 py-1 text-xs ${config.target_meta_page_ids.includes(pg.id) ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200" : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"}`}>
                {pg.meta_page_name || pg.id.slice(0, 8)} · {pg.platform}
              </button>
            ))}
            {!pages.length && <span className="text-xs text-zinc-400">No connected Meta pages.</span>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["reel", "feed", "story"] as const).map((t) => (
            <label key={t} className="text-xs text-zinc-500">{t}/week
              <input type="number" min={0} max={14} value={config.cadence[t]} onChange={(e) => saveConfig({ cadence: { ...config.cadence, [t]: Number(e.target.value) } })} className={`mt-1 w-full px-2 py-1 ${input}`} />
            </label>
          ))}
          <label className="text-xs text-zinc-500">max/platform/day
            <input type="number" min={1} max={10} value={config.max_posts_per_platform_per_day} onChange={(e) => saveConfig({ max_posts_per_platform_per_day: Number(e.target.value) })} className={`mt-1 w-full px-2 py-1 ${input}`} />
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={config.require_approval} onChange={(e) => saveConfig({ require_approval: e.target.checked })} className="accent-indigo-600" /> Require approval before publishing (posts land as drafts)
        </label>
      </div>

      {/* Promos */}
      <div className={`mb-6 ${card}`}>
        <h2 className="mb-3 text-sm font-semibold">Promos &amp; seasonal campaigns</h2>
        {promos.map((p) => (
          <div key={p.id} className="mb-3 border-b border-zinc-100 pb-3 last:border-0 dark:border-zinc-800">
            <div className="flex items-center gap-3 text-sm">
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-zinc-500">{p.starts_on} → {p.ends_on}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{p.brief}</span>
              {badge(p.active ? "active" : "off", p.active ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400")}
              <button className="text-xs text-zinc-500 hover:underline" onClick={() => togglePromo(p)}>{p.active ? "disable" : "enable"}</button>
              <button className="text-xs text-red-500 hover:underline" onClick={() => togglePromo(p, true)}>delete</button>
            </div>
            {p.emphasis_product_id && (
              <div className="mt-2 flex items-center gap-2">
                {p.graphics_status === "generating" && <span className="text-xs text-zinc-500">⏳ generating promo graphics…</span>}
                {p.graphics_status === "failed" && <span className="text-xs text-red-500">graphics failed (product needs an isolated image)</span>}
                {(p.generated_media || []).map((g) => (
                  <a key={g.post_type} href={g.url} target="_blank" rel="noreferrer" className="block h-20 w-16 overflow-hidden rounded border border-zinc-200 dark:border-zinc-700" title={g.post_type}>
                    <img src={g.url} alt={g.post_type} className="h-full w-full object-cover" />
                  </a>
                ))}
                {p.graphics_status === "ready" && <button className="text-xs text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => regenGraphics(p)}>regenerate</button>}
              </div>
            )}
          </div>
        ))}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-6">
          <input placeholder="Name (e.g. July 4th)" value={newPromo.name} onChange={(e) => setNewPromo({ ...newPromo, name: e.target.value })} className={`px-2 py-1 ${input}`} />
          <input type="date" value={newPromo.starts_on} onChange={(e) => setNewPromo({ ...newPromo, starts_on: e.target.value })} className={`px-2 py-1 ${input}`} />
          <input type="date" value={newPromo.ends_on} onChange={(e) => setNewPromo({ ...newPromo, ends_on: e.target.value })} className={`px-2 py-1 ${input}`} />
          <input placeholder="Brief (e.g. up to 60% off)" value={newPromo.brief} onChange={(e) => setNewPromo({ ...newPromo, brief: e.target.value })} className={`px-2 py-1 ${input}`} />
          <select value={newPromo.emphasis_product_id} onChange={(e) => setNewPromo({ ...newPromo, emphasis_product_id: e.target.value })} className={`px-2 py-1 ${input}`}>
            <option value="">No graphic</option>
            {products.filter((pr) => pr.has_isolated).map((pr) => <option key={pr.id} value={pr.id}>🎨 {pr.title}</option>)}
          </select>
          <button onClick={addPromo} className="rounded bg-indigo-600 px-3 py-1 text-sm text-white">Add promo</button>
        </div>
        <p className="mt-1 text-[11px] text-zinc-400">Pick a product (🎨 = has an isolated image) and we’ll auto-generate a 4:5 + story promo graphic for the sale.</p>
      </div>

      {/* Upcoming */}
      <h2 className="mb-2 text-sm font-semibold">Scheduled ({upcoming.length})</h2>
      <div className={`mb-6 px-4 ${card.replace("p-4", "")}`}>
        {upcoming.length ? upcoming.map((p) => <PostRow key={p.id} p={p} showActions />) : <p className="py-6 text-center text-sm text-zinc-400">Nothing scheduled. Turn it on + pick target pages, then “Plan next 7 days”.</p>}
      </div>

      {/* Recent */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Recently posted</h2>
        {freqHint && freqHint !== "no_data" && (
          <span className="text-xs text-zinc-500">
            · engagement trend: {freqHint === "increase" ? "📈 strong — room to post more" : freqHint === "decrease" ? "📉 easing — consider posting less" : "steady"}
          </span>
        )}
      </div>
      <div className={`px-4 ${card.replace("p-4", "")}`}>
        {recent.length ? recent.map((p) => <PostRow key={p.id} p={p} showActions={false} />) : <p className="py-6 text-center text-sm text-zinc-400">No posts yet.</p>}
      </div>
    </div>
  );
}
