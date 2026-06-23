"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar } from "@/components/agents/persona-chip";

// The human-readable EOD recap detail page (director-loop-grading spec, Phase 5).
// `/dashboard/agents/recap/[function]/[date]` — the director's day narrated: the headline standup
// counts plus that day's director_activity rows grouped into readable sections (what it fixed + why ·
// which goal it moved · what it escalated). Reached by clicking a row in the M1 Daily Summaries tab.
// A pure query over the activity log (GET /api/developer/agents/recap) — never hand-maintained.

interface RecapActivityLine {
  kind: string;
  label: string;
  specSlug: string | null;
  reason: string;
  createdAt: string;
}
interface RecapSection {
  id: string;
  title: string;
  lines: RecapActivityLine[];
}
interface DirectorDayDetail {
  ok: boolean;
  reason?: string;
  date: string;
  function: string;
  isCeo: boolean;
  personaName: string;
  personaRole: string;
  personaEmoji: string;
  summaryLine: string;
  totalActions: number;
  sections: RecapSection[];
}

function timeOfDay(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  } catch {
    return "";
  }
}

function DetailBody({ detail }: { detail: DirectorDayDetail }) {
  const persona = getPersona(detail.function);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <PersonaAvatar persona={persona} size={56} />
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {detail.personaName}
            <span className="text-base font-normal text-zinc-400">· {detail.personaRole}</span>
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            EOD recap · <span className="font-mono">{detail.date}</span> (UTC)
          </p>
        </div>
      </div>

      {/* The headline standup line — the same counts as the #directors board recap post. */}
      <div className="mt-5 rounded-lg border border-indigo-200 bg-indigo-50/40 px-4 py-3 dark:border-indigo-900/40 dark:bg-indigo-900/10">
        <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
          {detail.personaEmoji} {detail.summaryLine}.
        </p>
      </div>

      {detail.sections.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-400">
          No detailed activity was logged for this day — the headline counts come from merged builds and
          approvals rather than the director&apos;s own action log.
        </p>
      ) : (
        <div className="mt-6 space-y-6">
          {detail.sections.map((section) => (
            <div key={section.id}>
              <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                {section.title}
                <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                  {section.lines.length}
                </span>
              </h2>
              <ul className="space-y-2">
                {section.lines.map((line, i) => (
                  <li
                    key={i}
                    className="flex gap-2.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{line.label}</span>
                        <span className="shrink-0 font-mono text-[10px] text-zinc-400">{timeOfDay(line.createdAt)}</span>
                      </span>
                      {line.reason && (
                        <span className="mt-0.5 block whitespace-pre-wrap text-[12px] text-zinc-500 dark:text-zinc-400">
                          {line.reason}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RecapDetailPage() {
  const params = useParams<{ function: string; date: string }>();
  const fn = decodeURIComponent(params.function);
  const date = decodeURIComponent(params.date);
  const workspace = useWorkspace();
  const [detail, setDetail] = useState<DirectorDayDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  const load = useCallback(
    () =>
      fetch(`/api/developer/agents/recap?function=${encodeURIComponent(fn)}&date=${encodeURIComponent(date)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: DirectorDayDetail) => {
          setDetail(d);
          setErr(false);
        })
        .catch(() => setErr(true))
        .finally(() => setLoading(false)),
    [fn, date],
  );

  useEffect(() => {
    if (workspace.role !== "owner") return;
    load();
  }, [workspace.role, load]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Agents</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-lg p-6">
      <div className="mb-5 flex items-center gap-2 text-[12px] text-zinc-400">
        <Link href="/dashboard/agents" className="hover:text-zinc-700 dark:hover:text-zinc-200">
          Agents
        </Link>
        <span>/</span>
        <span className="text-zinc-500 dark:text-zinc-300">recap · {fn} · {date}</span>
      </div>

      {loading && !detail ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading recap…</div>
      ) : err && !detail ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Couldn&apos;t load the recap.
        </div>
      ) : detail ? (
        <DetailBody detail={detail} />
      ) : null}
    </div>
  );
}
