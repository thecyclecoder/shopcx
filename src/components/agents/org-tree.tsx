/**
 * Visual org-tree — the "company team page" (agents-hub-role-inboxes spec, Phase 4).
 *
 * Renders the live org chart as a real tree (NOT a flat list): CEO at top → the
 * `functions/*.md` Directors row → each director's Workers (the box agent_jobs lanes)
 * beneath it. Every node shows the persona avatar + name + role, and every node is
 * clickable. Brain-driven — the tree is the same `getOrgChart()` payload the inbox
 * nav reads (no hand-maintained second copy of the org chart).
 *
 * Click target (Phase 5): every node links to that role's profile detail page
 * (`/dashboard/agents/[role]`) — avatar + persona + responsibilities. Same profile
 * page reached from the Directors/Workers rosters, so no node click is a dead end.
 *
 * Pure presentational client component — personas come from the reskinnable
 * src/lib/agents/personas.ts. See docs/brain/dashboard/agents.md.
 */
import Link from "next/link";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar, StatusBadge, WorkerStatusBadge, type WorkerLiveness } from "@/components/agents/persona-chip";

interface WorkerLane {
  kind: string;
  label: string;
  description: string;
  status: WorkerLiveness;
  statusReason?: string;
}
interface DirectorNode {
  slug: string;
  title: string;
  workers: WorkerLane[];
  status: "offline" | "live" | "autonomous";
}
export interface OrgChart {
  ceo: {
    goals: { slug: string; title: string; pct: number }[];
    /**
     * CEO-owned workers rendered UNDER the CEO seat — the founder's own agents (Eve today,
     * god-mode-becomes-ceo-executive-assistant-agent Phase 2). Same shape as a director's
     * workers list so the tree can render them symmetrically without a second code path.
     */
    workers: WorkerLane[];
  };
  directors: DirectorNode[];
}

// A single clickable node card — avatar + name + role, sized by tier. Links to the
// role's profile detail page (Phase 5).
function Node({
  slug,
  label,
  size,
  subtitle,
  badge,
}: {
  slug: string;
  label?: string;
  size: "ceo" | "director" | "worker";
  subtitle?: string;
  badge?: React.ReactNode;
}) {
  const persona = getPersona(slug, label);
  const avatarSize = size === "ceo" ? 48 : size === "director" ? 38 : 24;
  const pad = size === "worker" ? "px-2.5 py-1.5" : "px-3.5 py-3";
  return (
    <Link
      href={`/dashboard/agents/${encodeURIComponent(slug)}`}
      title={`${persona.name} — ${persona.role}${subtitle ? ` · ${subtitle}` : ""}`}
      className={`group flex flex-col items-center gap-1.5 rounded-xl border border-zinc-200 bg-white text-center shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/30 ${pad}`}
    >
      <PersonaAvatar persona={persona} size={avatarSize} />
      <span className="flex flex-col items-center">
        <span
          className={`font-semibold text-zinc-900 dark:text-zinc-100 ${
            size === "worker" ? "text-[12px]" : "text-sm"
          }`}
        >
          {persona.name}
        </span>
        <span className={`text-zinc-400 ${size === "worker" ? "text-[10px]" : "text-[11px]"}`}>{persona.role}</span>
      </span>
      {subtitle && <span className="text-[10px] text-zinc-400">{subtitle}</span>}
      {badge}
    </Link>
  );
}

export function OrgTree({ org }: { org: OrgChart }) {
  const goalCount = org.ceo.goals.length;
  const ceoWorkers = org.ceo.workers ?? [];
  return (
    <div className="overflow-x-auto pb-2">
      <div className="mx-auto flex min-w-max flex-col items-center px-2">
        {/* CEO */}
        <Node
          slug="ceo"
          size="ceo"
          subtitle={`${goalCount} active goal${goalCount === 1 ? "" : "s"}`}
        />

        {/* CEO-owned workers rendered ALONGSIDE the goals under the CEO seat — Eve today
            (god-mode-becomes-ceo-executive-assistant-agent Phase 2). Same layout as a
            director's workers column so the tree is symmetric. Deliberately kept off Ada. */}
        {ceoWorkers.length > 0 && (
          <>
            <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-800" />
            <div className="flex flex-col items-stretch gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
              {ceoWorkers.map((w) => (
                <div key={w.kind} className="flex flex-col items-stretch gap-0.5">
                  <Node
                    slug={w.kind}
                    label={w.label}
                    size="worker"
                    subtitle={w.kind}
                    badge={
                      <span className="mt-0.5">
                        <WorkerStatusBadge status={w.status} reason={w.statusReason} />
                      </span>
                    }
                  />
                  <Link
                    href={`/dashboard/agents/${encodeURIComponent(w.kind)}/kpi`}
                    className="rounded-md px-1 py-0.5 text-center text-[10px] font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                    title={`${w.label}'s KPIs`}
                  >
                    KPIs →
                  </Link>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Connector from CEO down to the directors rail */}
        <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-px w-full max-w-5xl bg-zinc-200 dark:bg-zinc-800" />

        {/* Directors row — each over its workers column */}
        <div className="flex flex-wrap items-start justify-center gap-5">
          {org.directors.map((d) => (
            <div key={d.slug} className="flex flex-col items-center">
              {/* stub up to the CEO rail */}
              <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
              <Node
                slug={d.slug}
                label={d.title}
                size="director"
                badge={
                  <span className="mt-0.5">
                    <StatusBadge status={d.status} />
                  </span>
                }
              />

              {/* Workers under the director */}
              {d.workers.length > 0 && (
                <>
                  <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-800" />
                  <div className="flex flex-col items-stretch gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                    {d.workers.map((w) => (
                      <div key={w.kind} className="flex flex-col items-stretch gap-0.5">
                        <Node
                          slug={w.kind}
                          label={w.label}
                          size="worker"
                          subtitle={w.kind}
                          badge={
                            <span className="mt-0.5">
                              <WorkerStatusBadge status={w.status} reason={w.statusReason} />
                            </span>
                          }
                        />
                        {/* agents-sidebar-kpis-and-profile-redesign Phase 3 — a direct KPIs affordance on
                            every worker node so the founder can jump straight to any agent's KPIs from the
                            org chart (not only via the profile). Rendered as a sibling <Link> because nested
                            <a> tags aren't valid HTML — the Node itself is already a <Link> to the profile. */}
                        <Link
                          href={`/dashboard/agents/${encodeURIComponent(w.kind)}/kpi`}
                          className="rounded-md px-1 py-0.5 text-center text-[10px] font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                          title={`${w.label}'s KPIs`}
                        >
                          KPIs →
                        </Link>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
