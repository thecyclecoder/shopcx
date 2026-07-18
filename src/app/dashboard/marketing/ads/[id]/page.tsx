"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

// ── Read-only ad lifecycle preview ──────────────────────────────────────────
// This page is a READ-ONLY preview of a finished ad and its full lifecycle. Ads
// are authored autonomously by Dahlia (copy + 3 placement statics) and graded by
// Max — this page does NOT create or edit ads. It shows: the full ad preview
// (3 placements + headline/primary-text variations + the FB/IG page it posts as),
// Max's grade + suggestions, and the Meta target it published to
// (account → campaign → adset → ad). No manual-creation controls by design.

interface Campaign {
  id: string;
  name: string;
  status: string;
  script_text: string | null;
  hero_image_url: string | null;
  landing_url: string | null;
  audience_temperature: "cold" | "warm" | "hot" | null;
  concept_tag: string | null;
  author_self_score: AuthorSelfScore | null;
  products?: { title: string } | null;
}

interface AuthorSelfScore {
  lf8?: number;
  schwartz?: number;
  cialdini?: number;
  hopkins?: number;
  sugarman?: number;
  total?: number;
  evidence?: string[];
}

interface AdVideo {
  id: string;
  format: string;
  media_kind: string;
  format_variant_of_id: string | null;
  final_mp4_url: string | null;
  static_jpg_url: string | null;
  status: string;
  meta?: { archetype?: string } | null;
}

interface CopyVariant {
  audience_temperature: "cold" | "warm" | "hot";
  headline: string;
  primary_text: string;
  description: string;
}

interface AngleProvenance {
  mode: "explore" | "exploit";
  source: string;
  competitor_advertiser: string | null;
  competitor_ad_image_url: string | null;
  competitor_hook: string | null;
  lead_benefit: string;
}

interface Angle {
  meta_headline: string | null;
  meta_primary_text: string | null;
  meta_description: string | null;
  copy_pack: { headlines?: string[]; primaryTexts?: string[]; description?: string; frameworks?: string[] } | null;
  provenance: AngleProvenance | null;
}

// Human labels for the own-asset ("exploit") sources.
const EXPLOIT_SOURCE_LABEL: Record<string, string> = {
  ad_angle: "an existing ad angle",
  review_cluster: "a cluster of our reviews",
  transformation: "a real customer transformation",
  benefit: "a proven product benefit",
  ingredient: "an ingredient claim",
  authority: "an authority / expert proof",
};

interface QaVerdict {
  hard_gate_pass: boolean;
  hard_gates: {
    no_fabrication: boolean;
    no_cold_offer: boolean;
    no_competitor_leak: boolean;
    single_promise: boolean;
    render_ok: boolean;
  };
  persuasion_score: number | null;
  persuasion_rubric: { lf8: number; schwartz: number; cialdini: number; hopkins: number; sugarman: number; evidence: string[] } | null;
  scroll_stop: {
    headline_readable_in_3_frames: number;
    visual_hierarchy_supports_headline: number;
    first_line_earns_the_second: number;
    evidence: string[];
  } | null;
  verdict_reason: string;
  retry_index: number;
  created_at: string;
}

interface PublishJob {
  id: string;
  publish_status: string;
  meta_account_id: string | null;
  meta_campaign_id: string | null;
  meta_adset_id: string | null;
  meta_ad_id: string | null;
  meta_creative_id: string | null;
  meta_page_id: string | null;
  meta_instagram_user_id: string | null;
  cta_type: string | null;
  destination_url: string | null;
  publish_active: boolean | null;
  error: string | null;
  created_at: string;
}

interface PageIdentity {
  page_id: string;
  page_name: string | null;
  instagram_id: string | null;
}

const TEMP_LABEL: Record<string, string> = { cold: "Cold", warm: "Warm", hot: "Hot" };
const TEMP_TONE: Record<string, string> = {
  cold: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  warm: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  hot: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
};

// dahlia-authors-distinct-psychological-copy-variations-not-one-broadcast Phase 2 — the five
// conversion-psychology frameworks Dahlia's variations lead with (mirror of AUTHOR_FRAMEWORK_KEYS
// in creative-agent.ts, human-formatted here for the detail-page chip). Unknown tokens fall through
// to the raw string + a neutral zinc chip (see FRAMEWORK_TONE default in the render).
const FRAMEWORK_LABEL: Record<string, string> = {
  lf8: "LF8",
  schwartz: "Schwartz",
  cialdini: "Cialdini",
  hopkins: "Hopkins",
  sugarman: "Sugarman",
};
const FRAMEWORK_TONE: Record<string, string> = {
  lf8: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  schwartz: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  cialdini: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  hopkins: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  sugarman: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
};

// The three Meta placements a Dahlia pack renders, in display order.
const PLACEMENTS: Array<{ key: string; label: string; ratio: string; formats: string[] }> = [
  { key: "feed", label: "Feed", ratio: "4:5", formats: ["feed_4x5"] },
  { key: "stories", label: "Stories / Reels", ratio: "9:16", formats: ["stories_9x16", "reels_9x16"] },
  { key: "right_column", label: "Right column", ratio: "1:1", formats: ["right_column_1x1"] },
];

export default function AdDetailPage() {
  const workspace = useWorkspace();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [videos, setVideos] = useState<AdVideo[]>([]);
  const [copyVariants, setCopyVariants] = useState<CopyVariant[]>([]);
  const [angle, setAngle] = useState<Angle | null>(null);
  const [qa, setQa] = useState<QaVerdict | null>(null);
  const [publishJobs, setPublishJobs] = useState<PublishJob[]>([]);
  const [pageIdentity, setPageIdentity] = useState<PageIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/ads/campaigns/${id}?workspaceId=${workspace.id}`);
    if (res.ok) {
      const d = await res.json();
      setCampaign(d.campaign);
      setVideos(d.videos || []);
      setCopyVariants(d.copyVariants || []);
      setAngle(d.angle || null);
      setQa(d.copyQaVerdict || null);
      setPublishJobs(d.publishJobs || []);
      setPageIdentity(d.pageIdentity || null);
    }
    setLoading(false);
  }, [id, workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-screen-xl px-4 py-6">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="mx-auto w-full max-w-screen-xl px-4 py-6">
        <p className="text-sm text-zinc-500">Ad not found.</p>
        <Link href="/dashboard/marketing/ads" className="text-sm text-indigo-600 hover:underline">
          Back to ads
        </Link>
      </div>
    );
  }

  // Placement statics — the canonical row per format (format_variant_of_id === null wins; else first).
  const statics = videos.filter((v) => v.media_kind === "static" && v.status === "ready");
  const placementImage = (formats: string[]): string | null => {
    const rows = statics.filter((v) => formats.includes(v.format));
    if (!rows.length) return null;
    const canonical = rows.find((v) => v.format_variant_of_id === null) || rows[0];
    return canonical.static_jpg_url;
  };
  const videoOutputs = videos.filter((v) => v.media_kind === "video");

  // Canonical caption for the ad mock — warm variant, else angle canonical.
  const warm = copyVariants.find((v) => v.audience_temperature === "warm");
  const canonical = warm
    ? { headline: warm.headline, primary_text: warm.primary_text, description: warm.description }
    : angle
      ? { headline: angle.meta_headline || "", primary_text: angle.meta_primary_text || "", description: angle.meta_description || "" }
      : null;

  const cta = publishJobs.find((j) => j.cta_type)?.cta_type || "Shop now";
  const ctaLabel = cta.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const destUrl = publishJobs.find((j) => j.destination_url)?.destination_url || campaign.landing_url || null;
  const identityName = pageIdentity?.page_name || "Superfoods Company";

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <Link href="/dashboard/marketing/ads" className="text-xs text-indigo-600 hover:underline">
          ← Ads
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{campaign.name}</h1>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {campaign.status}
          </span>
          {campaign.audience_temperature && (
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${TEMP_TONE[campaign.audience_temperature]}`}>
              {TEMP_LABEL[campaign.audience_temperature]} audience
            </span>
          )}
          {campaign.concept_tag && (
            <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
              {campaign.concept_tag}
            </span>
          )}
        </div>
        <p className="mt-1 flex items-center gap-2 text-sm text-zinc-500">
          <span>{campaign.products?.title || "—"}</span>
          <span className="text-zinc-300 dark:text-zinc-600">·</span>
          <span className="text-xs text-zinc-400">Read-only preview — authored by Dahlia, graded by Max</span>
        </p>
      </div>

      {/* ── Source (explore / exploit) ─────────────────────────────────────── */}
      {angle?.provenance && (
        <Section title="Source" subtitle="What this ad is built from — a competitor ad it explores, or an own asset it exploits">
          {angle.provenance.mode === "explore" ? (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-3 flex items-center gap-2">
                <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                  Explore
                </span>
                <span className="text-sm text-zinc-600 dark:text-zinc-300">
                  Imitating a winning competitor ad{angle.provenance.competitor_advertiser ? ` from ${angle.provenance.competitor_advertiser}` : ""}
                </span>
              </div>
              <div className="flex flex-col gap-4 sm:flex-row">
                {angle.provenance.competitor_ad_image_url ? (
                  <a href={angle.provenance.competitor_ad_image_url} target="_blank" rel="noreferrer" className="shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={angle.provenance.competitor_ad_image_url}
                      alt="Competitor ad"
                      className="h-40 w-40 rounded-md border border-zinc-200 object-cover dark:border-zinc-800"
                    />
                  </a>
                ) : (
                  <div className="flex h-40 w-40 shrink-0 items-center justify-center rounded-md border border-dashed border-zinc-200 text-[11px] text-zinc-400 dark:border-zinc-700">
                    No competitor image
                  </div>
                )}
                <div className="min-w-0">
                  {angle.provenance.competitor_hook && (
                    <>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Their hook (pre-debrand)</p>
                      <p className="mt-0.5 text-sm italic text-zinc-700 dark:text-zinc-300">“{angle.provenance.competitor_hook}”</p>
                    </>
                  )}
                  <p className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Our angle</p>
                  <p className="mt-0.5 text-sm text-zinc-700 dark:text-zinc-300">{angle.provenance.lead_benefit}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  Exploit
                </span>
                <span className="text-sm text-zinc-600 dark:text-zinc-300">
                  Built from {EXPLOIT_SOURCE_LABEL[angle.provenance.source] || "our own product intelligence"}
                </span>
              </div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">The angle</p>
              <p className="mt-0.5 text-sm text-zinc-700 dark:text-zinc-300">{angle.provenance.lead_benefit}</p>
            </div>
          )}
        </Section>
      )}

      {/* ── The ad ─────────────────────────────────────────────────────────── */}
      <Section title="The ad" subtitle="3 placements · the copy variations it rotates · the identity it posts as">
        {/* Placements */}
        <div className="grid gap-4 sm:grid-cols-3">
          {PLACEMENTS.map((p) => {
            const src = placementImage(p.formats);
            return (
              <div key={p.key} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{p.label}</span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{p.ratio}</span>
                </div>
                {src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={src} alt={`${p.label} placement`} className="w-full rounded-md border border-zinc-100 dark:border-zinc-800" />
                ) : (
                  <div className="flex aspect-[4/5] items-center justify-center rounded-md border border-dashed border-zinc-200 text-[11px] text-zinc-400 dark:border-zinc-700">
                    Not rendered
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Ad mock (feed layout) using the canonical copy + the page identity */}
        {canonical && (canonical.headline || canonical.primary_text) && (
          <div className="mt-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Preview</p>
            <div className="mx-auto max-w-md overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center gap-2 p-3">
                <div className="h-8 w-8 shrink-0 rounded-full bg-gradient-to-br from-indigo-400 to-emerald-400" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{identityName}</p>
                  <p className="text-[11px] text-zinc-400">Sponsored</p>
                </div>
              </div>
              {canonical.primary_text && (
                <p className="whitespace-pre-wrap px-3 pb-2 text-sm text-zinc-800 dark:text-zinc-200">{canonical.primary_text}</p>
              )}
              {placementImage(["feed_4x5"]) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={placementImage(["feed_4x5"]) as string} alt="Feed creative" className="w-full" />
              ) : (
                <div className="flex aspect-[4/5] items-center justify-center bg-zinc-50 text-xs text-zinc-400 dark:bg-zinc-950">No feed image</div>
              )}
              <div className="flex items-center justify-between gap-3 bg-zinc-50 p-3 dark:bg-zinc-950">
                <div className="min-w-0">
                  {destUrl && <p className="truncate text-[10px] uppercase tracking-wider text-zinc-400">{hostOf(destUrl)}</p>}
                  {canonical.headline && <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{canonical.headline}</p>}
                  {canonical.description && <p className="truncate text-xs text-zinc-500">{canonical.description}</p>}
                </div>
                <span className="shrink-0 rounded-md bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">{ctaLabel}</span>
              </div>
            </div>
          </div>
        )}

        {/* Copy variations — framework-labeled when Dahlia's per-framework variations landed
            (dahlia-authors-distinct-psychological-copy-variations-not-one-broadcast Phase 2),
            temperature-banded when the temperature path fired, else legacy pack fallback. */}
        <div className="mt-5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Copy variations
            {angle?.copy_pack?.frameworks?.length ? " · framework-led" : copyVariants.length ? " · temperature-banded" : ""}
          </p>
          {angle?.copy_pack?.frameworks?.length ? (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {angle.copy_pack.frameworks.map((framework, i) => {
                const headline = angle.copy_pack?.headlines?.[i] ?? "";
                const primary = angle.copy_pack?.primaryTexts?.[i] ?? "";
                return (
                  <div key={`${framework}-${i}`} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${FRAMEWORK_TONE[framework] ?? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"}`}>
                      {FRAMEWORK_LABEL[framework] ?? framework}
                    </span>
                    <p className="mt-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{headline}</p>
                    <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300">{primary}</p>
                  </div>
                );
              })}
              {angle.copy_pack.description && (
                <div className="rounded-lg border border-dashed border-zinc-200 bg-transparent p-3 text-[11px] italic text-zinc-500 dark:border-zinc-800 dark:text-zinc-400 md:col-span-2 lg:col-span-3">
                  {angle.copy_pack.description}
                </div>
              )}
            </div>
          ) : copyVariants.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-3">
              {copyVariants.map((v) => (
                <div key={v.audience_temperature} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                  <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${TEMP_TONE[v.audience_temperature]}`}>
                    {TEMP_LABEL[v.audience_temperature]}
                  </span>
                  <p className="mt-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{v.headline}</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300">{v.primary_text}</p>
                  {v.description && <p className="mt-1 text-[11px] italic text-zinc-400">{v.description}</p>}
                </div>
              ))}
            </div>
          ) : angle && (angle.copy_pack?.headlines?.length || angle.meta_headline) ? (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <VariationList label="Headlines" items={angle.copy_pack?.headlines?.length ? angle.copy_pack.headlines : [angle.meta_headline || ""]} />
              <VariationList label="Primary texts" items={angle.copy_pack?.primaryTexts?.length ? angle.copy_pack.primaryTexts : [angle.meta_primary_text || ""]} />
              {(angle.copy_pack?.description || angle.meta_description) && (
                <VariationList label="Description" items={[angle.copy_pack?.description || angle.meta_description || ""]} />
              )}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">No copy authored yet.</p>
          )}
        </div>

        {/* Identity */}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span className="font-medium text-zinc-600 dark:text-zinc-400">Posts as:</span>
          {pageIdentity ? (
            <>
              <span className="rounded bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">📘 {pageIdentity.page_name || pageIdentity.page_id}</span>
              {pageIdentity.instagram_id && <span className="rounded bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">📷 IG linked</span>}
            </>
          ) : (
            <span className="text-zinc-400">Not yet published — the FB/IG page is assigned at publish time.</span>
          )}
        </div>
      </Section>

      {/* ── Max's grade ────────────────────────────────────────────────────── */}
      <Section title="Max's grade" subtitle="Dahlia's self-score, then Max's independent copy-QC — hard gates + persuasion + suggestions">
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Dahlia self-score */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Dahlia · self-score</h3>
              {campaign.author_self_score?.total != null && (
                <span className="rounded-md bg-indigo-50 px-2 py-1 text-sm font-semibold text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                  {campaign.author_self_score.total}/10
                </span>
              )}
            </div>
            {campaign.author_self_score ? (
              <>
                <RubricBars score={campaign.author_self_score} />
                {campaign.author_self_score.evidence?.length ? (
                  <ul className="mt-3 space-y-1">
                    {campaign.author_self_score.evidence.map((e, i) => (
                      <li key={i} className="text-[11px] text-zinc-500">• {e}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-zinc-500">Deterministic caption — no author self-score (Dahlia ran in deterministic mode).</p>
            )}
          </div>

          {/* Max QC verdict */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Max · copy-QC</h3>
              {qa && (
                <span className={`rounded-md px-2 py-1 text-xs font-semibold ${qa.hard_gate_pass ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" : "bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"}`}>
                  {qa.hard_gate_pass ? "Passed ✓" : "Held ✕"}
                </span>
              )}
            </div>
            {qa ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(qa.hard_gates).map(([k, v]) => (
                    <span key={k} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${v ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" : "bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"}`}>
                      {v ? "✓" : "✕"} {k.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
                {qa.persuasion_score != null && (
                  <p className="mt-3 text-xs text-zinc-500">
                    Persuasion <span className="font-semibold text-zinc-700 dark:text-zinc-200">{qa.persuasion_score}/10</span>
                    {qa.persuasion_rubric && (
                      <span className="ml-1 text-zinc-400">
                        (LF8 {qa.persuasion_rubric.lf8} · Schwartz {qa.persuasion_rubric.schwartz} · Cialdini {qa.persuasion_rubric.cialdini} · Hopkins {qa.persuasion_rubric.hopkins} · Sugarman {qa.persuasion_rubric.sugarman})
                      </span>
                    )}
                  </p>
                )}
                {qa.scroll_stop && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Scroll-stop: readable {qa.scroll_stop.headline_readable_in_3_frames}/2 · hierarchy {qa.scroll_stop.visual_hierarchy_supports_headline}/2 · first-line {qa.scroll_stop.first_line_earns_the_second}/2
                  </p>
                )}
                {qa.verdict_reason && (
                  <div className="mt-3 rounded-md bg-zinc-50 p-2.5 dark:bg-zinc-950">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Suggestion</p>
                    <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-300">{qa.verdict_reason}</p>
                  </div>
                )}
                <p className="mt-2 text-[10px] text-zinc-400">Attempt {qa.retry_index + 1} · {new Date(qa.created_at).toLocaleString()}</p>
              </>
            ) : (
              <p className="text-sm text-zinc-500">Awaiting Max&apos;s copy-QC.</p>
            )}
          </div>
        </div>
      </Section>

      {/* ── Meta lifecycle ─────────────────────────────────────────────────── */}
      <Section title="Meta lifecycle" subtitle="Where this creative published — account → campaign → adset → ad">
        {publishJobs.length === 0 ? (
          <p className="text-sm text-zinc-500">Not yet published to Meta. When Bianca ships this into a test, its account, campaign, adset and ad appear here.</p>
        ) : (
          <div className="space-y-3">
            {publishJobs.map((j) => (
              <div key={j.id} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="mb-2 flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${publishTone(j.publish_status)}`}>
                    {j.publish_status}
                  </span>
                  {j.publish_active === false && <span className="text-[10px] text-zinc-400">paused</span>}
                  <span className="text-[10px] text-zinc-400">{new Date(j.created_at).toLocaleDateString()}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <TargetNode label="Account" value={j.meta_account_id ? `act_${j.meta_account_id}` : null} />
                  <span className="text-zinc-300 dark:text-zinc-600">→</span>
                  <TargetNode label="Campaign" value={j.meta_campaign_id} />
                  <span className="text-zinc-300 dark:text-zinc-600">→</span>
                  <TargetNode label="Adset" value={j.meta_adset_id} />
                  <span className="text-zinc-300 dark:text-zinc-600">→</span>
                  <TargetNode label="Ad" value={j.meta_ad_id} />
                </div>
                {j.meta_ad_id && j.meta_account_id && (
                  <a
                    href={`https://business.facebook.com/adsmanager/manage/ads?act=${j.meta_account_id}&selected_ad_ids=${j.meta_ad_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-xs text-indigo-600 hover:underline"
                  >
                    Open in Ads Manager ↗
                  </a>
                )}
                {j.error && <p className="mt-2 text-xs text-rose-600">{j.error}</p>}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Legacy video outputs — read-only, only when this campaign has them. */}
      {videoOutputs.length > 0 && (
        <Section title="Video outputs" subtitle="Rendered video formats (read-only)">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {videoOutputs.map((v) => (
              <div key={v.id} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{v.format}</span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{v.status}</span>
                </div>
                {v.final_mp4_url ? (
                  <video controls src={v.final_mp4_url} className="w-full rounded-md" />
                ) : (
                  <p className="text-xs text-zinc-400">Not rendered.</p>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        {subtitle && <p className="text-xs text-zinc-400">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function VariationList({ label, items }: { label: string; items: string[] }) {
  const clean = items.filter(Boolean);
  if (!clean.length) return null;
  return (
    <div className="mb-3 last:mb-0">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">{label}</p>
      <ul className="space-y-1">
        {clean.map((t, i) => (
          <li key={i} className="text-xs text-zinc-700 dark:text-zinc-300">• {t}</li>
        ))}
      </ul>
    </div>
  );
}

function RubricBars({ score }: { score: AuthorSelfScore }) {
  const lenses: Array<[string, number | undefined]> = [
    ["LF8", score.lf8],
    ["Schwartz", score.schwartz],
    ["Cialdini", score.cialdini],
    ["Hopkins", score.hopkins],
    ["Sugarman", score.sugarman],
  ];
  return (
    <div className="space-y-1.5">
      {lenses.map(([name, v]) => (
        <div key={name} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[11px] text-zinc-500">{name}</span>
          <div className="flex gap-0.5">
            {[0, 1].map((i) => (
              <span key={i} className={`h-2 w-6 rounded-sm ${(v ?? 0) > i ? "bg-indigo-500" : "bg-zinc-200 dark:bg-zinc-700"}`} />
            ))}
          </div>
          <span className="text-[11px] text-zinc-400">{v ?? 0}/2</span>
        </div>
      ))}
    </div>
  );
}

function TargetNode({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <span className={`rounded px-1.5 py-0.5 ${value ? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200" : "border border-dashed border-zinc-200 text-zinc-300 dark:border-zinc-700 dark:text-zinc-600"}`}>
      <span className="text-[9px] uppercase tracking-wider text-zinc-400">{label} </span>
      {value ? <span className="font-mono">{value}</span> : "—"}
    </span>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "").toUpperCase();
  } catch {
    return "";
  }
}

function publishTone(status: string): string {
  if (status === "published") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
  if (status === "failed") return "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
}
