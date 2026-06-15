"use client";

import { useCallback, useEffect, useState } from "react";

const CTA_TYPES = ["SHOP_NOW", "LEARN_MORE", "GET_OFFER", "ORDER_NOW", "BUY_NOW", "SIGN_UP", "SUBSCRIBE", "GET_QUOTE", "SEE_MORE"];

interface Opt { id: string; name: string }
interface PageOpt extends Opt { instagram_user_id: string | null }
interface PublishJob { id: string; publish_status: string; meta_ad_id: string | null; meta_account_id: string; error: string | null; created_at: string }

export function PublishToMeta({
  workspaceId, campaignId, videoReady, defaultDestinationUrl, publishJobs, onChange,
}: {
  workspaceId: string;
  campaignId: string;
  /** Ready to publish (video OR static media is rendered). */
  videoReady: boolean;
  /** Campaign's default landing URL (ad_campaigns.landing_url) — pre-fills the destination. */
  defaultDestinationUrl?: string;
  publishJobs: PublishJob[];
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [headlines, setHeadlines] = useState<string[]>([""]);
  const [primaryTexts, setPrimaryTexts] = useState<string[]>([""]);
  const [description, setDescription] = useState("");
  const [cta, setCta] = useState("SHOP_NOW");
  const [destUrl, setDestUrl] = useState(defaultDestinationUrl || "");
  const [genBusy, setGenBusy] = useState(false);

  // Pre-fill the destination from the campaign's landing_url once it loads (don't
  // clobber an edit the operator has already started).
  useEffect(() => {
    if (defaultDestinationUrl) setDestUrl((cur) => cur || defaultDestinationUrl);
  }, [defaultDestinationUrl]);

  const [pages, setPages] = useState<PageOpt[]>([]);
  const [accounts, setAccounts] = useState<Opt[]>([]);
  const [campaigns, setCampaigns] = useState<Opt[]>([]);
  const [adsets, setAdsets] = useState<Opt[]>([]);
  const [pageId, setPageId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [metaCampaignId, setMetaCampaignId] = useState("");
  const [adsetId, setAdsetId] = useState("");
  const [publishActive, setPublishActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const metaGet = useCallback(async (resource: string, extra = "") => {
    const res = await fetch(`/api/ads/meta?workspaceId=${workspaceId}&resource=${resource}${extra}`);
    if (!res.ok) { setMsg(`Meta: ${(await res.json().catch(() => ({}))).error || res.status}`); return null; }
    return res.json();
  }, [workspaceId]);

  // Load pages + accounts when the panel opens.
  useEffect(() => {
    if (!open || accounts.length) return;
    (async () => {
      const a = await metaGet("accounts"); if (a) setAccounts(a.accounts || []);
      const p = await metaGet("pages"); if (p) setPages(p.pages || []);
    })();
  }, [open, accounts.length, metaGet]);

  async function onAccount(id: string) {
    setAccountId(id); setMetaCampaignId(""); setAdsetId(""); setCampaigns([]); setAdsets([]);
    if (!id) return;
    const c = await metaGet("campaigns", `&accountId=${id}`); if (c) setCampaigns(c.campaigns || []);
  }
  async function onCampaign(id: string) {
    setMetaCampaignId(id); setAdsetId(""); setAdsets([]);
    const a = await metaGet("adsets", `&accountId=${accountId}${id ? `&campaignId=${id}` : ""}`); if (a) setAdsets(a.adsets || []);
  }

  async function generateCopy() {
    setGenBusy(true); setMsg(null);
    const res = await fetch(`/api/ads/campaigns/${campaignId}/meta-copy`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId }),
    });
    if (res.ok) {
      const d = await res.json();
      setHeadlines(d.headlines?.length ? d.headlines : [""]);
      setPrimaryTexts(d.primaryTexts?.length ? d.primaryTexts : [""]);
      setDescription(d.description || "");
    } else setMsg("Copy generation failed.");
    setGenBusy(false);
  }

  async function publish() {
    setBusy(true); setMsg(null);
    const page = pages.find((p) => p.id === pageId);
    const res = await fetch(`/api/ads/campaigns/${campaignId}/publish`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId, meta_account_id: accountId, meta_campaign_id: metaCampaignId || undefined, meta_adset_id: adsetId,
        meta_page_id: pageId, meta_instagram_user_id: page?.instagram_user_id || undefined,
        headlines: headlines.map((h) => h.trim()).filter(Boolean),
        primary_texts: primaryTexts.map((p) => p.trim()).filter(Boolean),
        description: description.trim() || undefined, cta_type: cta, destination_url: destUrl.trim(),
        publish_active: publishActive,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setMsg(res.ok ? `Publishing to Meta (${publishActive ? "ACTIVE" : "PAUSED"})… check status below.` : `Publish failed: ${d.error || res.status}`);
    setBusy(false);
    if (res.ok) setTimeout(onChange, 1500);
  }

  const canPublish = videoReady && accountId && adsetId && pageId && destUrl.trim() && headlines.some((h) => h.trim()) && primaryTexts.some((p) => p.trim());
  const editList = (list: string[], set: (v: string[]) => void, max: number, label: string, rows: number) => (
    <div className="space-y-2">
      {list.map((v, i) => (
        <textarea key={i} value={v} rows={rows} onChange={(e) => { const n = [...list]; n[i] = e.target.value; set(n); }}
          placeholder={`${label} ${i + 1}`} className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-950" />
      ))}
      {list.length < max && <button onClick={() => set([...list, ""])} className="text-xs text-indigo-600 hover:underline">+ add {label.toLowerCase()}</button>}
    </div>
  );

  return (
    <div className="mt-8">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Publish to Meta</h2>
        {!open && <button onClick={() => setOpen(true)} disabled={!videoReady} className="rounded-md bg-[#1877F2] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40">Publish ad to Meta</button>}
      </div>
      {!videoReady && <p className="text-xs text-zinc-400">Render a video first — then you can publish it.</p>}

      {/* Prior publish jobs */}
      {publishJobs.length > 0 && (
        <div className="mb-3 space-y-1">
          {publishJobs.map((j) => (
            <div key={j.id} className="flex items-center gap-2 text-xs text-zinc-500">
              <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${j.publish_status === "published" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : j.publish_status === "failed" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"}`}>{j.publish_status}</span>
              {j.meta_ad_id && <a href={`https://business.facebook.com/adsmanager/manage/ads?act=${j.meta_account_id.replace(/^act_/, "")}&selected_ad_ids=${j.meta_ad_id}`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">Ad {j.meta_ad_id} ↗</a>}
              {j.error && <span className="text-red-500">{j.error}</span>}
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          {/* Copy */}
          <div className="mb-4 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Ad copy</p>
            <button onClick={generateCopy} disabled={genBusy} className="rounded border border-indigo-300 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-800 dark:text-indigo-300">{genBusy ? "Generating…" : "✨ Generate copy"}</button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Headlines (≤40 chars)</p>{editList(headlines, setHeadlines, 5, "Headline", 1)}</div>
            <div><p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Primary text</p>{editList(primaryTexts, setPrimaryTexts, 5, "Primary text", 3)}</div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div><p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Description (optional)</p><input value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-950" /></div>
            <div><p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">CTA button</p><select value={cta} onChange={(e) => setCta(e.target.value)} className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-950">{CTA_TYPES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}</select></div>
            <div><p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Destination URL</p><input value={destUrl} onChange={(e) => setDestUrl(e.target.value)} placeholder="https://…" className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-950" /></div>
          </div>

          {/* Targeting */}
          <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider text-zinc-500">Where to publish</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Select label="Facebook Page" value={pageId} onChange={setPageId} options={pages.map((p) => ({ id: p.id, name: p.name }))} />
            <Select label="Ad account" value={accountId} onChange={onAccount} options={accounts} />
            <Select label="Campaign" value={metaCampaignId} onChange={onCampaign} options={campaigns} disabled={!accountId} />
            <Select label="Ad set" value={adsetId} onChange={setAdsetId} options={adsets} disabled={!accountId} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button onClick={publish} disabled={busy || !canPublish} className="rounded-md bg-[#1877F2] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40">{busy ? "Publishing…" : publishActive ? "Publish ACTIVE" : "Publish (PAUSED)"}</button>
            <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400"><input type="checkbox" checked={publishActive} onChange={(e) => setPublishActive(e.target.checked)} /> Publish active (spends immediately)</label>
            <button onClick={() => setOpen(false)} className="text-xs text-zinc-500 hover:underline">Close</button>
            {msg && <span className="text-xs text-zinc-500">{msg}</span>}
          </div>
          <p className="mt-2 text-[11px] text-zinc-400">Defaults to PAUSED — the ad is created in your ad set but won&apos;t spend until you turn it on in Ads Manager. The 4 headlines × primary texts are published as a dynamic creative so Meta optimizes across them.</p>
        </div>
      )}
    </div>
  );
}

function Select({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (v: string) => void; options: Opt[]; disabled?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</p>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="w-full rounded-md border border-zinc-300 bg-white p-2 text-xs disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950">
        <option value="">{disabled ? "—" : "Select…"}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );
}
