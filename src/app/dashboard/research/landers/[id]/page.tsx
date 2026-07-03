"use client";

// Research › Landers › [id] — the teardown board for ONE lander
// (docs/brain/specs/research-landers-viewer.md, Phase 2). Reads GET /api/research/landers/[id]
// (owner-only). Renders Rhea's structured TeardownRecipe as an architecture flow, a reason
// sequence, tagged lever chips with evidence, an offer anatomy panel, and the transferable
// pattern — WITH the captured chapter screenshots (signed URLs from the private research-shots
// bucket) shown alongside so the recipe sits next to the real page. Handles a lander with no
// teardown (shows classification + rationale, no board) and an `unviewable` one (notes it
// couldn't be rendered) gracefully.

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

type Appeal = "emotion" | "logic";

interface ArchitectureChapter {
  chapter_role: string;
  purpose: string;
}
interface ReasonEntry {
  order: number;
  benefit: string;
  appeal: Appeal;
  mechanism: string;
}
interface LeverEntry {
  lever: string;
  evidence: string;
}
interface OfferAnatomy {
  discount?: string | null;
  bundle?: string | null;
  bonuses?: string[] | null;
  guarantee?: string | null;
  urgency?: string | null;
  options: number;
}
interface TeardownRecipe {
  funnel_type: string;
  strategy: string;
  architecture: ArchitectureChapter[];
  reason_sequence?: ReasonEntry[];
  levers: LeverEntry[];
  offer: OfferAnatomy;
  transferable_pattern: string;
}

interface ChapterShot {
  index: number;
  label: string;
  path: string;
  signed_url: string | null;
}

interface Lander {
  id: string;
  url: string;
  brand: string | null;
  domain: string;
  classification: string | null;
  ad_count: number;
  teardown_verdict: string;
  rationale: string | null;
  first_seen: string | null;
  last_seen: string | null;
  capture_ref: string | null;
  classified_at: string | null;
  classified_by: string | null;
  teardown: TeardownRecipe | null;
  chapters: ChapterShot[];
}

const CLASSIFICATION_BADGE: Record<string, string> = {
  advertorial: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  quiz: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  generic_pdp: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  homepage: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  spam: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  unviewable: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  excluded: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  checkout: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

const VERDICT_BADGE: Record<string, string> = {
  worthy: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  not_worthy: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  unreviewed: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

const LEVER_BADGE: Record<string, string> = {
  authority: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  social_proof: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  ugc: "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  urgency: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  price_anchor: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  risk_reversal: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  value_stack: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  objection_handling: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  specificity: "bg-lime-50 text-lime-700 dark:bg-lime-950 dark:text-lime-300",
  bandwagon: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  choice_simplicity: "bg-cyan-50 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
};

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

function ArchitectureFlow({ chapters }: { chapters: ArchitectureChapter[] }) {
  if (chapters.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Funnel architecture
      </h3>
      <div className="flex flex-wrap items-stretch gap-2">
        {chapters.map((c, i) => (
          <div key={`${c.chapter_role}-${i}`} className="flex items-stretch gap-2">
            <div className="min-w-[10rem] max-w-[16rem] rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                Chapter {i + 1}
              </div>
              <div className="font-medium text-zinc-900 dark:text-zinc-100">{c.chapter_role}</div>
              <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{c.purpose}</div>
            </div>
            {i < chapters.length - 1 && (
              <span className="self-center text-zinc-400">→</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReasonSequence({ entries }: { entries: ReasonEntry[] }) {
  if (!entries || entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.order - b.order);
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Reason sequence
      </h3>
      <ol className="space-y-2">
        {sorted.map((r) => (
          <li
            key={r.order}
            className="rounded border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="font-medium text-zinc-900 dark:text-zinc-100">
                {r.order}. {r.benefit}
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  r.appeal === "emotion"
                    ? "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                    : "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300"
                }`}
              >
                {r.appeal}
              </span>
            </div>
            <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{r.mechanism}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function LeverChips({ levers }: { levers: LeverEntry[] }) {
  if (!levers || levers.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Levers</h3>
      <div className="flex flex-col gap-2">
        {levers.map((l, i) => (
          <div
            key={`${l.lever}-${i}`}
            className="flex items-start gap-3 rounded border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                LEVER_BADGE[l.lever] ||
                "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {l.lever}
            </span>
            <span className="flex-1 text-zinc-700 dark:text-zinc-300">{l.evidence}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OfferPanel({ offer }: { offer: OfferAnatomy }) {
  const rows: Array<{ label: string; value: string }> = [];
  if (offer.discount) rows.push({ label: "Discount", value: offer.discount });
  if (offer.bundle) rows.push({ label: "Bundle", value: offer.bundle });
  if (offer.bonuses && offer.bonuses.length) rows.push({ label: "Bonuses", value: offer.bonuses.join(" · ") });
  if (offer.guarantee) rows.push({ label: "Guarantee", value: offer.guarantee });
  if (offer.urgency) rows.push({ label: "Urgency", value: offer.urgency });
  rows.push({ label: "Options", value: String(offer.options) });
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Offer anatomy
      </h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map((r) => (
          <div
            key={r.label}
            className="rounded border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              {r.label}
            </div>
            <div className="text-zinc-900 dark:text-zinc-100">{r.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TransferablePattern({ pattern }: { pattern: string }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Transferable pattern
      </h3>
      <div className="whitespace-pre-wrap rounded border border-zinc-200 bg-white px-3 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
        {pattern}
      </div>
    </div>
  );
}

function ChapterFilmstrip({ chapters }: { chapters: ChapterShot[] }) {
  if (chapters.length === 0) {
    return (
      <div className="text-xs text-zinc-500">
        No chapters captured for this lander (capture_ref is empty).
      </div>
    );
  }
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Captured chapters
      </h3>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {chapters.map((ch, i) => (
          <div key={`${ch.path}-${i}`} className="w-32 shrink-0 sm:w-40">
            <div className="mb-1 flex items-center justify-between gap-1 text-[10px] text-zinc-500">
              <span className="rounded bg-zinc-100 px-1 py-0.5 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                ch {ch.index}
              </span>
              {ch.label && (
                <span className="truncate" title={ch.label}>
                  {ch.label}
                </span>
              )}
            </div>
            {ch.signed_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={ch.signed_url}
                alt={ch.label || `chapter ${ch.index}`}
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
    </div>
  );
}

export default function ResearchLanderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const workspace = useWorkspace();
  const [lander, setLander] = useState<Lander | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const isOwner = workspace.role === "owner";

  const load = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const qs = new URLSearchParams({ workspaceId: workspace.id });
      const res = await fetch(`/api/research/landers/${id}?${qs.toString()}`);
      if (res.status === 404) {
        setNotFound(true);
        setLander(null);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { lander?: Lander; error?: string };
      if (!res.ok) {
        setError(body.error ?? `error ${res.status}`);
        return;
      }
      setLander(body.lander ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [isOwner, workspace.id, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isOwner) {
    return (
      <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
        <h1 className="mb-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Lander</h1>
        <p className="text-sm text-zinc-500">This surface is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <div className="mb-4">
        <Link
          href="/dashboard/research/landers"
          className="text-xs text-zinc-500 hover:underline"
        >
          ← All landers
        </Link>
      </div>

      {loading && !lander && (
        <div className="rounded-lg border border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          Loading lander…
        </div>
      )}

      {notFound && (
        <div className="rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          Lander not found (or not in this workspace).
        </div>
      )}

      {error && !notFound && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {lander && (
        <div className="space-y-6">
          <header className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                  {lander.brand || shortHost(lander.url)}
                </h1>
                <a
                  href={lander.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-sm text-zinc-500 hover:underline"
                >
                  {shortHost(lander.url)}
                  {pathOf(lander.url)}
                </a>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {lander.classification && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      CLASSIFICATION_BADGE[lander.classification] ||
                      "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    }`}
                  >
                    {lander.classification}
                  </span>
                )}
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    VERDICT_BADGE[lander.teardown_verdict] || ""
                  }`}
                >
                  {lander.teardown_verdict}
                </span>
                <span className="text-[11px] text-zinc-500">
                  ad_count {lander.ad_count} · seen {fmtDate(lander.first_seen)}–
                  {fmtDate(lander.last_seen)}
                </span>
              </div>
            </div>
            {lander.rationale && (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                <span className="font-semibold">Rationale:</span> {lander.rationale}
              </p>
            )}
          </header>

          {lander.classification === "unviewable" && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              This lander was classified <strong>unviewable</strong> — Rhea&apos;s headless capture
              couldn&apos;t render the page after retries (bot-block or persistent nav failure). No
              teardown board is available.
            </div>
          )}

          {lander.teardown ? (
            <>
              <section className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  Funnel type
                </div>
                <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                  {lander.teardown.funnel_type}
                </div>
                <div className="text-sm text-zinc-600 dark:text-zinc-400">
                  {lander.teardown.strategy}
                </div>
              </section>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div className="space-y-6">
                  <ArchitectureFlow chapters={lander.teardown.architecture} />
                  {lander.teardown.reason_sequence && lander.teardown.reason_sequence.length > 0 && (
                    <ReasonSequence entries={lander.teardown.reason_sequence} />
                  )}
                  <LeverChips levers={lander.teardown.levers} />
                  <OfferPanel offer={lander.teardown.offer} />
                  <TransferablePattern pattern={lander.teardown.transferable_pattern} />
                </div>
                <div>
                  <ChapterFilmstrip chapters={lander.chapters} />
                </div>
              </div>
            </>
          ) : (
            lander.classification !== "unviewable" && (
              <div className="rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-6 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
                <div className="mb-2 font-medium text-zinc-900 dark:text-zinc-100">
                  No teardown recipe yet.
                </div>
                <p>
                  This lander is{" "}
                  <strong>{lander.classification || "unclassified"}</strong> with verdict{" "}
                  <strong>{lander.teardown_verdict}</strong>. Rhea only writes a structured
                  TeardownRecipe for landers her verdict rated worthy — this row hasn&apos;t
                  reached that stage.
                </p>
                <div className="mt-4">
                  <ChapterFilmstrip chapters={lander.chapters} />
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
