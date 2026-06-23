"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar, StatusBadge } from "@/components/agents/persona-chip";
import { INBOX_TABS, type InboxTab, type InboxItem, type InboxPayload } from "@/lib/agents/inbox";

// Agents hub (agents-hub-role-inboxes spec) — the owner-only org-chart surface.
// Left: CEO → Directors → Workers, read from functions/+goals/ via brain-roadmap.
// Right: the selected role's three-tab inbox shell (Messages · Approval Requests ·
// Daily Summaries). CEO inbox is live; director inboxes route up to the CEO (M1).

interface WorkerLane {
  kind: string;
  label: string;
  description: string;
}
interface DirectorMandate {
  name: string;
  metric?: string;
  specCount: number;
}
interface DirectorNode {
  slug: string;
  title: string;
  summary: string;
  mandates: DirectorMandate[];
  goalSlugs: string[];
  workers: WorkerLane[];
  status: "offline" | "live" | "autonomous";
}
interface OrgChart {
  ceo: { goals: { slug: string; title: string; pct: number }[] };
  directors: DirectorNode[];
}

function elapsed(iso: string | null | undefined): string {
  if (!iso) return "";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ── Left nav ──────────────────────────────────────────────────────────────────

function RoleNav({
  org,
  selected,
  onSelect,
}: {
  org: OrgChart;
  selected: string;
  onSelect: (role: string) => void;
}) {
  const ceo = getPersona("ceo");
  return (
    <nav className="space-y-1">
      <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">CEO</p>
      <button
        onClick={() => onSelect("ceo")}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${
          selected === "ceo"
            ? "bg-indigo-50 dark:bg-indigo-950"
            : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
        }`}
      >
        <PersonaAvatar persona={ceo} size={30} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{ceo.name}</span>
            <span className="text-[11px] text-zinc-400">{ceo.role}</span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {org.ceo.goals.length} active goal{org.ceo.goals.length === 1 ? "" : "s"}
          </span>
        </span>
      </button>

      <p className="px-1 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Directors</p>
      <div className="space-y-1">
        {org.directors.map((d) => {
          const persona = getPersona(d.slug, d.title);
          const isSel = selected === d.slug;
          return (
            <div key={d.slug}>
              <button
                onClick={() => onSelect(d.slug)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${
                  isSel ? "bg-indigo-50 dark:bg-indigo-950" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                <PersonaAvatar persona={persona} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{persona.name}</span>
                    <span className="text-[11px] text-zinc-400">{persona.role}</span>
                  </span>
                  <span className="mt-0.5 block">
                    <StatusBadge status={d.status} />
                  </span>
                </span>
              </button>
              {/* Workers — the box agent_jobs lanes this director owns. */}
              {d.workers.length > 0 && (
                <ul className="ml-9 mt-0.5 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                  {d.workers.map((w) => (
                    <li
                      key={w.kind}
                      title={w.description}
                      className="truncate py-0.5 text-[11px] text-zinc-500 dark:text-zinc-400"
                    >
                      <span className="font-mono text-[10px] text-zinc-400">{w.kind}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

// ── Inbox shell ─────────────────────────────────────────────────────────────

function InboxShell({ role, title }: { role: string; title: string }) {
  const [payload, setPayload] = useState<InboxPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [tab, setTab] = useState<InboxTab>("messages");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState("");

  const refresh = useCallback(
    () =>
      fetch(`/api/developer/agents/inbox?role=${encodeURIComponent(role)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: InboxPayload) => {
          setPayload(d);
          setErr(false);
        })
        .catch(() => setErr(true))
        .finally(() => setLoading(false)),
    [role],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const items = useMemo(() => payload?.items ?? [], [payload]);
  const countByTab = useMemo(() => {
    const c: Record<InboxTab, number> = { messages: 0, approvals: 0, summaries: 0 };
    for (const it of items) c[it.tab]++;
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(
      (it) =>
        it.tab === tab &&
        (!unreadOnly || !it.read) &&
        (!needle || it.title.toLowerCase().includes(needle) || (it.body ?? "").toLowerCase().includes(needle)),
    );
  }, [items, tab, unreadOnly, q]);

  const activeTabDef = INBOX_TABS.find((t) => t.id === tab)!;

  return (
    <div>
      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {INBOX_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            {t.label}
            {countByTab[t.id] > 0 && (
              <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                {countByTab[t.id]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter…"
          className="w-44 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-sm text-zinc-700 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        />
        <label className="flex items-center gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} className="rounded border-zinc-300 dark:border-zinc-600" />
          Unread only
        </label>
        <button
          onClick={refresh}
          className="ml-auto rounded-md border border-zinc-300 px-2.5 py-1 text-[12px] font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>

      {/* Body */}
      <div className="mt-3">
        {loading && !payload ? (
          <div className="py-12 text-center text-sm text-zinc-400">Loading inbox…</div>
        ) : err ? (
          <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
            Couldn&apos;t load the inbox.
          </div>
        ) : payload?.routesToCeo ? (
          <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{title} isn&apos;t live yet.</p>
            <p className="mx-auto mt-1 max-w-sm text-[12px] text-zinc-400">
              No director is automated, so everything this director would own routes up to the{" "}
              <span className="font-medium">CEO inbox</span>. The approval-routing engine (M2) flips this on.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">No {activeTabDef.label.toLowerCase()} yet.</p>
            <p className="mx-auto mt-1 max-w-sm text-[12px] text-zinc-400">{activeTabDef.emptyHint}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map((it) => (
              <InboxRow key={it.id} item={it} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  const inner = (
    <div
      className={`rounded-lg border p-3 ${
        item.read
          ? "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
          : "border-indigo-200 bg-indigo-50/40 dark:border-indigo-900/40 dark:bg-indigo-900/10"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            {!item.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />}
            <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title}</span>
          </span>
          {item.body && <p className="mt-0.5 line-clamp-2 text-[12px] text-zinc-500 dark:text-zinc-400">{item.body}</p>}
        </span>
        <span className="shrink-0 text-[10px] text-zinc-400">{elapsed(item.createdAt)}</span>
      </div>
    </div>
  );
  return <li>{item.link ? <Link href={item.link}>{inner}</Link> : inner}</li>;
}

// ── Right pane header ─────────────────────────────────────────────────────────

function RoleHeader({ org, role }: { org: OrgChart; role: string }) {
  if (role === "ceo") {
    const persona = getPersona("ceo");
    return (
      <div className="mb-4">
        <div className="flex items-center gap-3">
          <PersonaAvatar persona={persona} size={42} />
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              {persona.name} <span className="text-sm font-normal text-zinc-400">· {persona.role}</span>
            </h2>
            <p className="text-[12px] text-zinc-500 dark:text-zinc-400">{persona.personality}</p>
          </div>
        </div>
        {org.ceo.goals.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {org.ceo.goals.map((g) => (
              <Link
                key={g.slug}
                href={`/dashboard/roadmap/goals`}
                className="rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {g.title} · {g.pct}%
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  const d = org.directors.find((x) => x.slug === role);
  if (!d) return null;
  const persona = getPersona(d.slug, d.title);
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <PersonaAvatar persona={persona} size={42} />
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {persona.name} <span className="text-sm font-normal text-zinc-400">· {persona.role}</span>
            <StatusBadge status={d.status} />
          </h2>
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400">{persona.personality}</p>
        </div>
        <Link
          href={`/dashboard/roadmap/map`}
          className="ml-auto text-[12px] text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          {d.slug} →
        </Link>
      </div>
      {d.mandates.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {d.mandates.map((m) => (
            <span
              key={m.name}
              className="rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
            >
              {m.name}
              {m.specCount > 0 && <span className="ml-1 text-zinc-400">· {m.specCount}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const workspace = useWorkspace();
  const [org, setOrg] = useState<OrgChart | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [role, setRole] = useState("ceo");

  useEffect(() => {
    if (workspace.role !== "owner") return;
    fetch("/api/developer/agents")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: OrgChart) => {
        setOrg(d);
        setErr(false);
      })
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }, [workspace.role]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Agents</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const title = role === "ceo" ? "CEO" : getPersona(role, org?.directors.find((d) => d.slug === role)?.title).name;

  return (
    <div className="mx-auto w-full max-w-screen-xl p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Agents</h1>
        <Link
          href="/dashboard/developer/control-tower"
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Control Tower →
        </Link>
      </div>
      <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
        The org chart — CEO · Directors · Workers — read live from the brain, each role with the same three-tab
        inbox. No director is automated yet, so every approval routes to one CEO inbox.
      </p>

      {loading && !org ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading the org chart…</div>
      ) : err && !org ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Couldn&apos;t load the Agents hub.
        </div>
      ) : org ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
          <aside className="lg:border-r lg:border-zinc-200 lg:pr-4 dark:lg:border-zinc-800">
            <RoleNav org={org} selected={role} onSelect={setRole} />
          </aside>
          <section>
            <RoleHeader org={org} role={role} />
            <InboxShell key={role} role={role} title={title} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
