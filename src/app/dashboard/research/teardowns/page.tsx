"use client";

// Research › Lander Teardowns — the owner-facing viewer for competitor funnels captured by the
// Landing Page Scout (the UI half of [[funnel-teardown-scout]], productized version of the manual
// Erth teardown). Reads GET /api/ads/lander-teardowns (owner-only). Renders, per competitor
// funnel: the ordered step map (advertorial → PDP → …), each step's deconstructed skeleton
// (big_promise / offer_structure / beats / tactics), and the chapter filmstrip via signed URLs.
// Handles the pre-deconstruction case gracefully (chapters render even when skeleton is null).

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface SkeletonBeat {
  beat: string;
  does: string;
  chapters: number[];
}
interface LanderSkeleton {
  offer_structure: string | null;
  big_promise: string | null;
  beats: SkeletonBeat[];
  tactics: string[];
}
interface ChapterShot {
  index: number | null;
  label: string | null;
  signed_url: string | null;
}
interface TeardownStep {
  id: string;
  url: string;
  brand: string | null;
  status: string;
  funnel_step: number;
  page_type: string | null;
  skeleton: LanderSkeleton | null;
  cta_target_url: string | null;
  captured_at: string | null;
  chapters: ChapterShot[];
}
interface TeardownFunnel {
  key: string;
  competitor_id: string | null;
  product_id: string | null;
  brand: string | null;
  root_url: string;
  captured_at: string | null;
  steps: TeardownStep[];
}

function shortHost(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}
function pathOf(u: string): string {
  try {
    const p = new URL(u).pathname;
    return p === "/" ? "" : p;
  } catch {
    return "";
  }
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function FunnelMap({ steps }: { steps: TeardownStep[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2">
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
              Step {s.funnel_step}
            </div>
            <div className="font-medium text-zinc-900 dark:text-zinc-100">
              {s.page_type ?? "unknown"}
            </div>
            <div className="text-[11px] text-zinc-500" title={s.url}>
              {shortHost(s.url)}
              {pathOf(s.url)}
            </div>
          </div>
          {i < steps.length - 1 && <span className="text-zinc-400">→</span>}
        </div>
      ))}
    </div>
  );
}

function SkeletonPanel({ step }: { step: TeardownStep }) {
  const sk = step.skeleton;
  if (!sk) {
    return (
      <div className="rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-3 py-3 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
        Not yet deconstructed — the vision pass hasn&apos;t analyzed this step. Chapters below are the
        raw capture.
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div>
        {sk.big_promise && (
          <div className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            &ldquo;{sk.big_promise}&rdquo;
          </div>
        )}
        {sk.offer_structure && (
          <div className="mt-1 text-xs text-zinc-500">Offer · {sk.offer_structure}</div>
        )}
      </div>
      {sk.beats.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            Beats
          </div>
          <ol className="space-y-1">
            {sk.beats.map((b, i) => (
              <li
                key={`${b.beat}-${i}`}
                className="flex items-start gap-2 rounded border border-zinc-100 px-2 py-1 text-xs dark:border-zinc-900"
              >
                <span className="mt-0.5 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {b.beat}
                </span>
                <span className="flex-1 text-zinc-700 dark:text-zinc-300">{b.does}</span>
                {b.chapters.length > 0 && (
                  <span className="text-[10px] text-zinc-500">ch {b.chapters.join(",")}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {sk.tactics.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            Tactics
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sk.tactics.map((t) => (
              <span
                key={t}
                className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChapterFilmstrip({ chapters }: { chapters: ChapterShot[] }) {
  if (chapters.length === 0) {
    return <div className="text-xs text-zinc-500">No chapters captured for this step.</div>;
  }
  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {chapters.map((ch, i) => (
        <div key={i} className="w-32 shrink-0 sm:w-40">
          <div className="mb-1 flex items-center justify-between gap-1 text-[10px] text-zinc-500">
            <span className="rounded bg-zinc-100 px-1 py-0.5 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              ch {ch.index ?? i}
            </span>
            {ch.label && <span className="truncate" title={ch.label}>{ch.label}</span>}
          </div>
          {ch.signed_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={ch.signed_url}
              alt={ch.label ?? `chapter ${ch.index ?? i}`}
              className="w-full rounded border border-zinc-200 dark:border-zinc-800"
              loading="lazy"
            />
          ) : (
            <div className="flex aspect-[9/16] w-full items-center justify-center rounded border border-dashed border-zinc-200 bg-zinc-50 text-[10px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
              image unavailable
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function StepCard({ step }: { step: TeardownStep }) {
  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            Step {step.funnel_step} · {step.page_type ?? "unknown"}
          </div>
          <a
            href={step.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
          >
            {shortHost(step.url)}
            {pathOf(step.url)}
          </a>
        </div>
        <div className="text-[11px] text-zinc-500">
          {step.status !== "captured" && (
            <span className="mr-2 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              {step.status}
            </span>
          )}
          {fmtDate(step.captured_at)}
        </div>
      </div>
      {step.cta_target_url && (
        <div className="text-[11px] text-zinc-500">
          CTA →{" "}
          <a
            href={step.cta_target_url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-zinc-700 hover:underline dark:text-zinc-300"
          >
            {shortHost(step.cta_target_url)}
            {pathOf(step.cta_target_url)}
          </a>
        </div>
      )}
      <SkeletonPanel step={step} />
      <ChapterFilmstrip chapters={step.chapters} />
    </div>
  );
}

function FunnelCard({ funnel }: { funnel: TeardownFunnel }) {
  return (
    <div className="space-y-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {funnel.brand ?? shortHost(funnel.root_url)}
          </h2>
          <div className="text-xs text-zinc-500" title={funnel.root_url}>
            entry · {shortHost(funnel.root_url)}
            {pathOf(funnel.root_url)}
          </div>
        </div>
        <div className="text-[11px] text-zinc-500">
          {funnel.steps.length} step{funnel.steps.length === 1 ? "" : "s"} · captured{" "}
          {fmtDate(funnel.captured_at)}
        </div>
      </div>
      <FunnelMap steps={funnel.steps} />
      <div className="space-y-3">
        {funnel.steps.map((s) => (
          <StepCard key={s.id} step={s} />
        ))}
      </div>
    </div>
  );
}

export default function ResearchTeardownsPage() {
  const workspace = useWorkspace();
  const [funnels, setFunnels] = useState<TeardownFunnel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isOwner = workspace.role === "owner";

  const load = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ workspaceId: workspace.id });
      const res = await fetch(`/api/ads/lander-teardowns?${qs.toString()}`);
      const body = (await res.json().catch(() => ({}))) as {
        funnels?: TeardownFunnel[];
        error?: string;
      };
      if (!res.ok) {
        setError(body.error ?? `error ${res.status}`);
        setFunnels([]);
      } else {
        setFunnels(body.funnels ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
      setFunnels([]);
    } finally {
      setLoading(false);
    }
  }, [isOwner, workspace.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isOwner) {
    return (
      <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
        <h1 className="mb-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Lander Teardowns</h1>
        <p className="text-sm text-zinc-500">This surface is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Lander Teardowns</h1>
      <p className="mb-6 text-sm text-zinc-500">
        The captured competitor funnels — ordered step map, each step&apos;s page-type-aware
        skeleton, and the mobile chapter filmstrip. Read-only; capture runs on the box.
      </p>

      {loading && funnels === null && (
        <div className="rounded-lg border border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          Loading captured funnels…
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {funnels !== null && funnels.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          No competitor funnels captured yet. The box script{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5 text-[11px] dark:bg-zinc-800">
            scripts/landing-page-snapshot.ts
          </code>{" "}
          feeds this surface.
        </div>
      )}

      {funnels && funnels.length > 0 && (
        <div className="space-y-6">
          {funnels.map((f) => (
            <FunnelCard key={f.key} funnel={f} />
          ))}
        </div>
      )}
    </div>
  );
}
