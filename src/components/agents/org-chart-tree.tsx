/**
 * Visual org-chart (employee) tree (agents-hub-role-inboxes spec, Phase 4).
 *
 * Renders the company team page — CEO at top → Directors → their Workers — as a real
 * org-tree layout, not a flat list. Each node shows the persona avatar + name + role
 * and is clickable: it routes to that role's profile detail page (`/dashboard/agents/
 * [role]`, Phase 5). The data is the same brain-driven OrgChart the left nav reads
 * (functions/*.md directors + their box agent_jobs worker lanes), so a new function or
 * a renamed persona reflects here with no code change. Workers have no persona until
 * Phase 5, so they fall back to the neutral 🤖 mascot via getPersona().
 *
 * Pure client component — takes the OrgChart payload as a prop (the page already
 * fetched it from GET /api/developer/agents). See docs/brain/dashboard/agents.md.
 */
import Link from "next/link";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar, StatusBadge } from "@/components/agents/persona-chip";
import type { AgentStatus } from "@/components/agents/persona-chip";
import type { AgentPersona } from "@/lib/agents/personas";

// Minimal shape the tree needs — structurally compatible with OrgChart in org-chart.ts,
// re-declared here so this client component pulls in no server-only imports.
interface WorkerLane {
  kind: string;
  label: string;
  description: string;
}
interface DirectorNode {
  slug: string;
  title: string;
  workers: WorkerLane[];
  status: AgentStatus;
}
interface OrgChartData {
  ceo: { goals: { slug: string; title: string; pct: number }[] };
  directors: DirectorNode[];
}

/** Every profile node links to its Phase-5 detail page. */
function profileHref(role: string) {
  return `/dashboard/agents/${encodeURIComponent(role)}`;
}

/** A clickable role node — avatar + name + role, used for CEO + directors. */
function PersonNode({
  persona,
  role,
  status,
  size = 44,
}: {
  persona: AgentPersona;
  /** the [role] param for the Phase-5 profile route */
  role: string;
  status?: AgentStatus;
  size?: number;
}) {
  return (
    <Link
      href={profileHref(role)}
      className="group flex w-36 flex-col items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-3 text-center shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-900/60 dark:hover:bg-indigo-950/30"
    >
      <PersonaAvatar persona={persona} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-zinc-900 group-hover:text-indigo-700 dark:text-zinc-100 dark:group-hover:text-indigo-300">
          {persona.name}
        </span>
        <span className="block truncate text-[11px] text-zinc-400">{persona.role}</span>
      </span>
      {status && <StatusBadge status={status} />}
    </Link>
  );
}

/** A compact clickable worker node — neutral mascot until Phase 5 gives workers personas. */
function WorkerNode({ worker }: { worker: WorkerLane }) {
  const persona = getPersona(worker.kind, worker.label);
  return (
    <Link
      href={profileHref(worker.kind)}
      title={worker.description}
      className="group flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-900/60 dark:hover:bg-indigo-950/30"
    >
      <PersonaAvatar persona={persona} size={22} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-zinc-700 group-hover:text-indigo-700 dark:text-zinc-200 dark:group-hover:text-indigo-300">
          {worker.label}
        </span>
        <span className="block truncate font-mono text-[10px] text-zinc-400">{worker.kind}</span>
      </span>
    </Link>
  );
}

export function OrgChartTree({ org }: { org: OrgChartData }) {
  const ceoPersona = getPersona("ceo");
  return (
    <div className="overflow-x-auto pb-2">
      <div className="mx-auto flex min-w-fit flex-col items-center">
        {/* CEO seat */}
        <PersonNode persona={ceoPersona} role="ceo" size={52} />

        {/* Trunk down from the CEO to the directors bar */}
        <span aria-hidden className="h-6 w-px bg-zinc-300 dark:bg-zinc-700" />

        {/* Directors row — each column carries a connector tick up to a shared bar */}
        <div className="relative flex flex-wrap justify-center gap-x-6 gap-y-8 pt-px">
          {/* the horizontal bar joining all directors to the trunk */}
          {org.directors.length > 1 && (
            <span
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-0 hidden h-px -translate-x-1/2 bg-zinc-300 sm:block dark:bg-zinc-700"
              style={{ width: "calc(100% - 9rem)" }}
            />
          )}
          {org.directors.map((d) => {
            const persona = getPersona(d.slug, d.title);
            return (
              <div key={d.slug} className="flex flex-col items-center">
                {/* tick from the bar down to this director */}
                <span aria-hidden className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
                <PersonNode persona={persona} role={d.slug} status={d.status} />
                {/* Workers beneath the director */}
                {d.workers.length > 0 && (
                  <>
                    <span aria-hidden className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
                    <div className="w-44 space-y-1.5">
                      {d.workers.map((w) => (
                        <WorkerNode key={w.kind} worker={w} />
                      ))}
                    </div>
                  </>
                )}
                {d.workers.length === 0 && (
                  <p className="mt-2 w-44 text-center text-[11px] italic text-zinc-400">No workers yet</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
