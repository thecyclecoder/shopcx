/**
 * Org-chart reader (agents-hub-role-inboxes spec, Phase 1).
 *
 * Builds the CEO → Directors → Workers tree the Agents hub renders, read entirely
 * from the brain — NO hand-maintained second copy of the org chart (operational-
 * rules: brain is the source of truth, no drift):
 *   - Directors = the `functions/*.md` cards via brain-roadmap `getFunctions()`.
 *   - Each director's mandates + owned/contributed goals come straight from that card.
 *   - The CEO seat carries the finite `goals/*.md` (via `getGoals()`).
 *   - Workers = the box `agent_jobs` lanes (the `agent-kind` MONITORED_LOOPS in the
 *     Control Tower registry, which already carry an owner function) grouped under
 *     their owning director.
 *
 * Server-only (brain-roadmap reads the bundled fs copy at request time). Surfaced by
 * GET /api/developer/agents → /dashboard/agents. See docs/brain/dashboard/agents.md.
 */
import { getFunctions, getGoals, functionLabel, type GoalStatus } from "@/lib/brain-roadmap";
import { MONITORED_LOOPS } from "@/lib/control-tower/registry";
import { loadAutonomyMap, isAutoApprover, type AutonomyMap } from "@/lib/agents/approval-router";

export interface WorkerLane {
  /** the agent_jobs kind (box lane) */
  kind: string;
  label: string;
  description: string;
}

export interface DirectorMandate {
  name: string;
  metric?: string;
  specCount: number;
}

export interface DirectorNode {
  slug: string;
  title: string;
  summary: string;
  mandates: DirectorMandate[];
  goalSlugs: string[];
  workers: WorkerLane[];
  /**
   * Derived from the per-function `function_autonomy` flags (approval-routing-engine M2):
   * live && autonomous ⇒ "autonomous" (an auto-approver — approvals route HERE, then to history);
   * live only ⇒ "live"; neither ⇒ "offline" (approvals route up to the CEO). Seeded all-off, so
   * today every director is "offline" until the owner toggles it on from the Agents hub.
   */
  status: "offline" | "live" | "autonomous";
  /** The raw flags behind `status` — the owner toggles these from the hub. */
  live: boolean;
  autonomous: boolean;
}

export interface OrgChart {
  ceo: {
    /**
     * The finite company goals (goals/*.md). `status` + `proposedBy` surface the director-proposed-goals
     * lifecycle (Phase 2): a `proposed` goal a director authored that AWAITS the CEO's greenlight vs a
     * `greenlit` one the CEO has activated — so the hub shows what each director is proposing vs what's live.
     * `proposedByLabel` is the proposer function's display name (computed server-side; the hub is a client component).
     */
    goals: { slug: string; title: string; pct: number; status: GoalStatus; proposedBy?: string; proposedByLabel?: string }[];
  };
  directors: DirectorNode[];
}

/** The box agent_jobs lanes that this function owns, derived from the Control Tower registry. */
function workersForFunction(slug: string): WorkerLane[] {
  return MONITORED_LOOPS.filter((l) => l.kind === "agent-kind" && l.owner === slug && l.agentKind).map((l) => ({
    kind: l.agentKind as string,
    label: l.label,
    description: l.description,
  }));
}

/** live && autonomous ⇒ "autonomous"; live only ⇒ "live"; else "offline" (routes to CEO). */
function statusFor(slug: string, autonomy: AutonomyMap): DirectorNode["status"] {
  if (isAutoApprover(slug, autonomy)) return "autonomous";
  return autonomy[slug]?.live ? "live" : "offline";
}

export async function getOrgChart(): Promise<OrgChart> {
  const [functions, goals, autonomy] = await Promise.all([getFunctions(), getGoals(), loadAutonomyMap()]);

  const directors: DirectorNode[] = functions.map((fn) => ({
    slug: fn.slug,
    title: fn.title,
    summary: fn.summary,
    mandates: fn.mandates.map((m) => ({ name: m.name, metric: m.metric, specCount: m.specSlugs.length })),
    goalSlugs: fn.goalSlugs,
    workers: workersForFunction(fn.slug),
    status: statusFor(fn.slug, autonomy),
    live: autonomy[fn.slug]?.live ?? false,
    autonomous: autonomy[fn.slug]?.autonomous ?? false,
  }));

  return {
    ceo: {
      goals: goals.map((g) => ({
        slug: g.slug,
        title: g.title,
        pct: g.pct,
        status: g.status,
        proposedBy: g.proposedBy,
        proposedByLabel: g.proposedBy ? functionLabel(g.proposedBy) : undefined,
      })),
    },
    directors,
  };
}
