"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar, StatusBadge, WorkerStatusBadge, type WorkerLiveness } from "@/components/agents/persona-chip";

// Director Guide (director-guide-tab spec) — a SUPER human-readable, self-updating intro to one director,
// written for a non-technical founder skimming it. Everything is runtime-derived from the live system
// (GET /api/developer/agents/guide → getOrgChart + getLeashGuide), polled on an interval, so a newly
// registered agent or a new director's capabilities appear here automatically with zero hand-maintenance.

type GoalStatus = "proposed" | "greenlit" | "complete";

interface LeashLine {
  title: string;
  detail: string;
}
interface GuidePayload {
  slug: string;
  title: string;
  summary: string;
  status: "offline" | "live" | "autonomous";
  statusPlain: string;
  live: boolean;
  autonomous: boolean;
  leash: { defined: boolean; autonomous: LeashLine[]; escalates: LeashLine[] };
  team: { kind: string; label: string; status: WorkerLiveness; statusReason: string; flagged: boolean }[];
  goals: { slug: string; title: string; pct: number; status: GoalStatus }[];
  specCount: number;
}

const POLL_MS = 45_000; // self-updating: re-read the live system every 45s

function SectionHeading({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{children}</h2>
      {hint && <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}

function LeashList({ items, tone }: { items: LeashLine[]; tone: "auto" | "escalate" }) {
  const dot = tone === "auto" ? "bg-emerald-500" : "bg-amber-500";
  return (
    <ul className="space-y-2.5">
      {items.map((b, i) => (
        <li
          key={i}
          className="flex gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{b.title}</span>
            <span className="mt-0.5 block text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">{b.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function goalStatusChip(status: GoalStatus, pct: number): { label: string; cls: string } {
  if (status === "complete")
    return { label: "Done", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" };
  if (status === "proposed")
    return { label: "Proposed · awaiting your greenlight", cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" };
  return { label: `In progress · ${pct}%`, cls: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300" };
}

export function DirectorGuide({ slug }: { slug: string }) {
  const [data, setData] = useState<GuidePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/developer/agents/guide?slug=${encodeURIComponent(slug)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: GuidePayload) => {
          if (alive) {
            setData(d);
            setErr(false);
            setLoading(false);
          }
        })
        .catch(() => {
          if (alive) {
            setErr(true);
            setLoading(false);
          }
        });
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug]);

  if (loading && !data) return <p className="py-8 text-center text-sm text-zinc-400">Loading guide…</p>;
  if (err && !data)
    return (
      <div className="rounded-xl border border-dashed border-zinc-200 py-10 text-center text-sm text-zinc-400 dark:border-zinc-800">
        Couldn&apos;t load the guide.
      </div>
    );
  if (!data) return null;

  const persona = getPersona(data.slug, data.title);

  return (
    <div className="space-y-10">
      {/* 1 ─ Who this is */}
      <section className="rounded-2xl border border-zinc-200 bg-gradient-to-br from-white to-zinc-50 p-6 dark:border-zinc-800 dark:from-zinc-900 dark:to-zinc-950">
        <div className="flex flex-wrap items-start gap-4">
          <PersonaAvatar persona={persona} size={64} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{persona.name}</h1>
              <span className="text-base font-normal text-zinc-400">· {persona.role} Director</span>
              <StatusBadge status={data.status} />
            </div>
            <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-300">
              {persona.personality}
            </p>
            {data.summary && data.summary !== persona.personality && (
              <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-zinc-500 dark:text-zinc-400">{data.summary}</p>
            )}
          </div>
        </div>
        {/* Status, in plain words */}
        <div className="mt-5 flex items-start gap-2.5 rounded-xl bg-white/70 px-4 py-3 text-[13px] text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-900/60 dark:text-zinc-300 dark:ring-zinc-800">
          <span
            className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
              data.status === "autonomous" ? "bg-emerald-500" : data.status === "live" ? "bg-sky-500" : "bg-zinc-400"
            }`}
          />
          <span>{data.statusPlain}</span>
        </div>
      </section>

      {/* 2 ─ What I do on my own vs. bring to you */}
      <section>
        <SectionHeading hint="Her auto-approve envelope, in plain English — kept in sync with the code that enforces it.">
          What {persona.name} handles vs. what comes to you
        </SectionHeading>
        {data.leash.defined ? (
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                <span aria-hidden>✓</span> I handle these myself
              </h3>
              {data.leash.autonomous.length ? (
                <LeashList items={data.leash.autonomous} tone="auto" />
              ) : (
                <p className="text-[13px] text-zinc-400">Nothing auto-approved yet.</p>
              )}
            </div>
            <div>
              <h3 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                <span aria-hidden>↑</span> I bring these to you
              </h3>
              <LeashList items={data.leash.escalates} tone="escalate" />
            </div>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-5 text-[13px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            Leash not yet defined — {persona.name} doesn&apos;t have an auto-approve envelope yet, so for now
            everything she would touch routes to you.
          </p>
        )}
        {!data.autonomous && data.leash.defined && (
          <p className="mt-3 text-[13px] text-zinc-400">
            She isn&apos;t live + autonomous yet, so until you flip her on, even the &quot;I handle these myself&quot;
            calls come to you for approval.
          </p>
        )}
      </section>

      {/* 3 ─ My team */}
      <section>
        <SectionHeading hint="The agents she supervises. This list updates itself as new agents come online.">
          {persona.name}&apos;s team · {data.team.length} agent{data.team.length === 1 ? "" : "s"}
        </SectionHeading>
        {data.team.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.team.map((w) => {
              const wp = getPersona(w.kind, w.label);
              const blurb = wp.responsibilities?.[0] ?? wp.personality;
              return (
                <Link
                  key={w.kind}
                  href={`/dashboard/agents/${encodeURIComponent(w.kind)}`}
                  className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-white p-4 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/30"
                >
                  <PersonaAvatar persona={wp} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{wp.name}</span>
                      <span className="text-[12px] text-zinc-400">· {wp.role}</span>
                      <WorkerStatusBadge status={w.status} reason={w.statusReason} />
                    </div>
                    <p className="mt-1 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">{blurb}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-5 text-[13px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            No agents on her team yet — they&apos;ll appear here automatically as soon as one is registered.
          </p>
        )}
      </section>

      {/* 4 ─ What I'm working on */}
      <section>
        <SectionHeading hint="The company goals she owns or contributes to.">
          What {persona.name} is working on
        </SectionHeading>
        {data.goals.length ? (
          <ul className="space-y-2">
            {data.goals.map((g) => {
              const chip = goalStatusChip(g.status, g.pct);
              return (
                <li
                  key={g.slug}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <span className="text-sm text-zinc-800 dark:text-zinc-200">{g.title}</span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${chip.cls}`}>{chip.label}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-zinc-400">No goals assigned right now.</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          <span>
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">{data.specCount}</span> spec
            {data.specCount === 1 ? "" : "s"} on her plate
          </span>
          <Link
            href={`/dashboard/agents/${encodeURIComponent(data.slug)}?s=activity`}
            className="text-indigo-600 hover:underline dark:text-indigo-400"
          >
            See her live activity →
          </Link>
        </div>
      </section>

      {/* 5 ─ self-updating footer */}
      <p className="border-t border-zinc-200 pt-5 text-[12px] leading-relaxed text-zinc-400 dark:border-zinc-800">
        This guide updates itself — it reads the live system, so new agents and capabilities appear here
        automatically, with no manual maintenance.
      </p>
    </div>
  );
}
