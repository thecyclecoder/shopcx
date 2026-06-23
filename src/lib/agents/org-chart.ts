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
import { getFunctions, getGoals } from "@/lib/brain-roadmap";
import { MONITORED_LOOPS } from "@/lib/control-tower/registry";

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
   * M1 reality: no director is automated yet, so every director is "offline" and its
   * approvals route up to the CEO. The per-function live/autonomous flag lands in M2.
   */
  status: "offline" | "live" | "autonomous";
}

export interface OrgChart {
  ceo: {
    goals: { slug: string; title: string; pct: number }[];
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

export async function getOrgChart(): Promise<OrgChart> {
  const [functions, goals] = await Promise.all([getFunctions(), getGoals()]);

  const directors: DirectorNode[] = functions.map((fn) => ({
    slug: fn.slug,
    title: fn.title,
    summary: fn.summary,
    mandates: fn.mandates.map((m) => ({ name: m.name, metric: m.metric, specCount: m.specSlugs.length })),
    goalSlugs: fn.goalSlugs,
    workers: workersForFunction(fn.slug),
    status: "offline",
  }));

  return {
    ceo: {
      goals: goals.map((g) => ({ slug: g.slug, title: g.title, pct: g.pct })),
    },
    directors,
  };
}
