/**
 * Approvals activity feed (developer/approvals dashboard) — the ONE unified, enriched view of
 * every approval in the workspace: the live queue the CEO must still decide AND the historical
 * ledger of everything already decided (mostly the autonomous Platform/DevOps director's
 * auto-approvals). North star (operational-rules § supervisable autonomy): the CEO can always
 * audit what a proxy decided + why — this feed is that surface, with the escalated-to-human items
 * carrying the real Approve/Decline affordance inline.
 *
 * Two backing sources, merged newest-first into one feed:
 *   - PENDING  → [[dashboard_notifications]] type='agent_approval_request', not dismissed (the
 *                routed queue; routed_to_function='ceo' ⇒ escalated to the human → actionable).
 *   - DECISION → public.approval_decisions (the supervisable-autonomy ledger; read-only logs).
 *
 * Each item is enriched off its [[agent_jobs]] row with the SPEC (slug+title), the MILESTONE/GOAL
 * it belongs to, the PHASE needing approval, WHO raised it, WHO it routed to, and a human TYPE
 * label — so the card answers "what is this, whose is it, where in the plan" without a click-through.
 *
 * Read-only by construction. The inline decision rides the unchanged POST /api/roadmap/approve
 * path; dismiss rides POST /api/developer/agents/inbox/dismiss. See docs/brain/dashboard/approvals.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getPersona } from "@/lib/agents/personas";
import { CEO } from "@/lib/agents/approval-router";
import { inlineApproveActions, type ApprovalJobRow } from "@/lib/agents/approval-inbox";
// control-tower-canonical-node-registry P2 — the raising tool's owner comes from the canonical node
// registry (single source of truth); the feed no longer imports the local shim.
import { resolveNodeOwner } from "@/lib/control-tower/node-registry";
import type { InboxApprovalAction } from "@/lib/agents/inbox";
import type { DecidedBy, DecisionOutcome } from "@/lib/agents/approval-decisions";

type Admin = ReturnType<typeof createAdminClient>;

/** Human label for the "type of approval" — keyed by agent_jobs.kind. Unknown ⇒ the raw kind. */
const KIND_LABELS: Record<string, string> = {
  build: "Build",
  plan: "Planning",
  fold: "Fold",
  "spec-test": "Verification",
  "spec-review": "Spec review",
  "spec-drift": "Spec drift",
  "pr-resolve": "PR resolve",
  "deploy-guardian": "Deploy guard",
  "security-review": "Security review",
  "coverage-register": "Coverage",
  db_health: "DB health",
  repair: "Repair",
  regression: "Regression",
  "migration-fix": "Migration fix",
  "ticket-improve": "Ticket",
  "triage-escalations": "Escalation triage",
  "product-seed": "Product seed",
  "storefront-optimizer": "Storefront",
  "spec-chat": "Spec chat",
  "dev-ask": "Dev Q&A",
  "proposed-goal": "Goal greenlight",
};

export function kindLabel(kind: string | null | undefined): string {
  if (!kind) return "Approval";
  return KIND_LABELS[kind] ?? kind;
}

/** A persona reference surfaced on a card (who raised / routed / decided). */
export interface FeedPersona {
  slug: string;
  name: string;
  role: string;
}
function persona(slug: string | null | undefined): FeedPersona | null {
  if (!slug) return null;
  const p = getPersona(slug);
  return { slug, name: p.name, role: p.role };
}

export type FeedStatus = "awaiting" | "approved" | "declined" | "escalated";

/** One enriched row of the approvals feed (a pending request OR a recorded decision). */
export interface ApprovalFeedItem {
  id: string;
  source: "pending" | "decision";
  status: FeedStatus;
  /** true for any pending request routed to the CEO seat (Henry) — what's escalated to the CEO. */
  escalated: boolean;
  /** true only for an escalated request that also has an inline decision to make (Approve/Decline). */
  actionable: boolean;
  createdAt: string;

  // type of approval
  kind: string | null;
  typeLabel: string;

  // who
  raisedBy: FeedPersona | null;
  routedTo: FeedPersona | null;
  decidedByLabel: string | null; // "Ada (autonomous)" | "You" | "Henry (CEO)" | null
  autonomous: boolean;

  // spec / milestone / goal / phase
  spec: { slug: string; title: string | null; status: string | null } | null;
  goal: { slug: string; title: string } | null;
  milestone: string | null;
  phase: string | null;

  // content
  title: string;
  summary: string | null; // the reasoning (decision) / escalation reason / investigation (pending)

  // pending affordances (null/[] for decisions)
  jobId: string | null;
  actions: InboxApprovalAction[];
  deepLink: string | null;
  escalatedBy: string | null;
}

// ── DB row shapes (only the columns we read) ────────────────────────────────────

interface NotifRow {
  id: string;
  title: string | null;
  body: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}
interface DecisionRow {
  id: string;
  agent_job_id: string | null;
  pending_action_id: string | null;
  raised_by_function: string;
  routed_to_function: string;
  decided_by: DecidedBy;
  decision: DecisionOutcome;
  reasoning: string | null;
  autonomous: boolean;
  created_at: string;
}
interface JobRow {
  id: string;
  kind: string;
  spec_slug: string | null;
  pending_actions: unknown;
  log_tail: string | null;
}
interface SpecRow {
  slug: string;
  title: string | null;
  status: string | null;
  milestone_id: string | null;
}
interface PhaseRow {
  spec_id: string;
  position: number;
  title: string;
  status: string;
}
interface MilestoneRow {
  id: string;
  goal_id: string;
  title: string;
}
interface GoalRow {
  id: string;
  slug: string;
  title: string;
}

function meta(row: NotifRow, key: string): string | null {
  const v = row.metadata?.[key];
  return typeof v === "string" ? v : null;
}

/** Best human "type of approval" for a pending request: the linked job's kind, else the kind parsed
 * out of the "Parked {kind}: …" title, else the escalation_kind, else a generic label. */
function pendingTypeLabel(jobKind: string | null, title: string | null, escalationKind: string | null): string {
  if (jobKind) return kindLabel(jobKind);
  const parked = title?.match(/^Parked ([\w-]+):/);
  if (parked) return kindLabel(parked[1]);
  if (escalationKind) return escalationKind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return "Escalation";
}

/** Candidate spec slugs a job points at — prefer the real target spec inside the action over the
 * job's (sometimes synthetic, e.g. "vercel:…") spec_slug. Only slugs that match a real spec row link. */
function specCandidates(job: JobRow | undefined, notifSpecSlug: string | null): string[] {
  const out: string[] = [];
  const push = (s: unknown) => {
    if (typeof s === "string" && s && !out.includes(s)) out.push(s);
  };
  if (Array.isArray(job?.pending_actions)) {
    for (const a of job!.pending_actions as Array<Record<string, unknown>>) {
      push(a?.["spec_slug"]);
      const spec = a?.["spec"];
      if (spec && typeof spec === "object") push((spec as Record<string, unknown>)["slug"]);
    }
  }
  push(job?.spec_slug);
  push(notifSpecSlug);
  return out;
}

/** The phase "needing approval": the first in-progress phase, else the first planned, else null. */
function phaseNeedingApproval(phases: PhaseRow[]): string | null {
  const sorted = [...phases].sort((a, b) => a.position - b.position);
  return (
    sorted.find((p) => p.status === "in_progress")?.title ??
    sorted.find((p) => p.status === "planned")?.title ??
    null
  );
}

// ── The feed builder ────────────────────────────────────────────────────────────

export interface ApprovalsFeed {
  items: ApprovalFeedItem[];
  /** pending requests escalated to the human (CEO) — the actionable count for the sidebar badge. */
  escalatedCount: number;
}

/**
 * Build the unified, enriched approvals feed for a workspace: the pending routed queue + the
 * decision ledger, merged newest-first and enriched off each item's agent_jobs row. Best-effort —
 * a missing job/spec degrades the card gracefully (raw slug, no phase) rather than dropping it.
 */
export async function buildApprovalsFeed(admin: Admin, workspaceId: string): Promise<ApprovalsFeed> {
  const [{ data: notifs }, { data: decisions }] = await Promise.all([
    admin
      .from("dashboard_notifications")
      .select("id, title, body, created_at, metadata")
      .eq("workspace_id", workspaceId)
      .eq("type", "agent_approval_request")
      .eq("dismissed", false)
      .order("created_at", { ascending: false })
      .limit(100),
    admin
      .from("approval_decisions")
      .select("id, agent_job_id, pending_action_id, raised_by_function, routed_to_function, decided_by, decision, reasoning, autonomous, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(150),
  ]);

  const notifRows = (notifs ?? []) as NotifRow[];
  const decisionRows = (decisions ?? []) as DecisionRow[];

  // 1) Batch-fetch the linked jobs.
  const jobIds = new Set<string>();
  for (const n of notifRows) {
    const j = meta(n, "agent_job_id");
    if (j) jobIds.add(j);
  }
  for (const d of decisionRows) if (d.agent_job_id) jobIds.add(d.agent_job_id);

  const jobs = new Map<string, JobRow>();
  if (jobIds.size) {
    const { data } = await admin
      .from("agent_jobs")
      .select("id, kind, spec_slug, pending_actions, log_tail")
      .in("id", Array.from(jobIds));
    for (const j of (data ?? []) as JobRow[]) jobs.set(j.id, j);
  }

  // 2) Resolve the target spec / goal per item, then batch-fetch specs + goals by slug.
  const specSlugs = new Set<string>();
  const goalSlugs = new Set<string>();
  const itemSpecCandidates = new Map<string, string[]>(); // feed item id → ordered candidate slugs
  const addCandidates = (id: string, job: JobRow | undefined, notifSpecSlug: string | null) => {
    const cands = specCandidates(job, notifSpecSlug);
    itemSpecCandidates.set(id, cands);
    // `plan` jobs name a GOAL slug; everything else names a SPEC slug.
    if (job?.kind === "plan") cands.forEach((s) => goalSlugs.add(s));
    else cands.forEach((s) => specSlugs.add(s));
  };
  for (const n of notifRows) addCandidates(n.id, jobs.get(meta(n, "agent_job_id") ?? ""), meta(n, "spec_slug"));
  for (const d of decisionRows) addCandidates(d.id, d.agent_job_id ? jobs.get(d.agent_job_id) : undefined, null);

  const specs = new Map<string, SpecRow & { id?: string }>();
  if (specSlugs.size) {
    const { data } = await admin
      .from("specs")
      .select("id, slug, title, status, milestone_id")
      .eq("workspace_id", workspaceId)
      .in("slug", Array.from(specSlugs));
    for (const s of (data ?? []) as Array<SpecRow & { id: string }>) specs.set(s.slug, s);
  }
  const goals = new Map<string, GoalRow>();
  if (goalSlugs.size) {
    const { data } = await admin
      .from("goals")
      .select("id, slug, title")
      .eq("workspace_id", workspaceId)
      .in("slug", Array.from(goalSlugs));
    for (const g of (data ?? []) as GoalRow[]) goals.set(g.slug, g);
  }

  // 3) Phases (for resolved specs) + milestone→goal (for specs with a milestone_id).
  const specIds = Array.from(specs.values()).map((s) => s.id).filter((v): v is string => Boolean(v));
  const phasesBySpec = new Map<string, PhaseRow[]>();
  if (specIds.length) {
    const { data } = await admin
      .from("spec_phases")
      .select("spec_id, position, title, status")
      .in("spec_id", specIds);
    for (const p of (data ?? []) as PhaseRow[]) {
      const list = phasesBySpec.get(p.spec_id) ?? [];
      list.push(p);
      phasesBySpec.set(p.spec_id, list);
    }
  }
  const milestoneIds = Array.from(specs.values())
    .map((s) => s.milestone_id)
    .filter((v): v is string => Boolean(v));
  const milestones = new Map<string, MilestoneRow>();
  if (milestoneIds.length) {
    const { data } = await admin.from("goal_milestones").select("id, goal_id, title").in("id", milestoneIds);
    for (const m of (data ?? []) as MilestoneRow[]) milestones.set(m.id, m);
  }
  const milestoneGoalIds = Array.from(milestones.values()).map((m) => m.goal_id);
  if (milestoneGoalIds.length) {
    const { data } = await admin.from("goals").select("id, slug, title").in("id", milestoneGoalIds);
    for (const g of (data ?? []) as GoalRow[]) if (!goals.has(g.slug)) goals.set(g.slug, g);
  }
  const goalById = new Map<string, GoalRow>();
  for (const g of goals.values()) goalById.set(g.id, g);

  // Resolve the enrichment for one feed item from its candidate slugs.
  const enrich = (itemId: string, kind: string | null) => {
    const cands = itemSpecCandidates.get(itemId) ?? [];
    let spec: ApprovalFeedItem["spec"] = null;
    let goal: ApprovalFeedItem["goal"] = null;
    let milestone: string | null = null;
    let phase: string | null = null;

    if (kind === "plan") {
      const slug = cands.find((s) => goals.has(s));
      const g = slug ? goals.get(slug) : undefined;
      if (g) goal = { slug: g.slug, title: g.title };
      else if (cands[0]) goal = { slug: cands[0], title: cands[0] };
      return { spec, goal, milestone, phase };
    }

    const slug = cands.find((s) => specs.has(s)) ?? cands[0];
    const s = slug ? specs.get(slug) : undefined;
    if (s) {
      spec = { slug: s.slug, title: s.title, status: s.status };
      if (s.id) phase = phaseNeedingApproval(phasesBySpec.get(s.id) ?? []);
      if (s.milestone_id) {
        const m = milestones.get(s.milestone_id);
        if (m) {
          milestone = m.title;
          const g = goalById.get(m.goal_id);
          if (g) goal = { slug: g.slug, title: g.title };
        }
      }
    } else if (slug) {
      spec = { slug, title: null, status: null };
    }
    return { spec, goal, milestone, phase };
  };

  // ── PENDING items ──────────────────────────────────────────────────────────
  const pending: ApprovalFeedItem[] = notifRows.map((n) => {
    const jobId = meta(n, "agent_job_id");
    const job = jobId ? jobs.get(jobId) : undefined;
    const kind = job?.kind ?? null;
    const routedTo = meta(n, "routed_to_function") ?? CEO;
    const escalatedBy = meta(n, "escalated_by_director");
    const actions =
      job &&
      inlineApproveActions({
        spec_slug: job.spec_slug ?? "",
        kind: job.kind,
        pending_actions: job.pending_actions,
        log_tail: job.log_tail,
      } as ApprovalJobRow);
    const inline = actions ?? [];
    const escalatedToHuman = routedTo === CEO;
    const { spec, goal, milestone, phase } = enrich(n.id, kind);

    return {
      id: n.id,
      source: "pending",
      status: "awaiting",
      // Escalated = routed to the CEO seat (Henry) — everything the CEO must look at, parks included.
      escalated: escalatedToHuman,
      // Actionable when escalated AND there's an inline decision to make. A needs_attention park
      // (no inline actions) routes the CEO to the deep-link instead.
      actionable: escalatedToHuman && Boolean(jobId) && inline.length > 0,
      createdAt: n.created_at,
      kind,
      typeLabel: pendingTypeLabel(kind, n.title, meta(n, "escalation_kind")),
      raisedBy: persona(escalatedBy ?? (kind ? resolveNodeOwner(kind) : null)),
      routedTo: persona(routedTo),
      decidedByLabel: null,
      autonomous: false,
      spec,
      goal,
      milestone,
      phase,
      title: n.title ?? "Approval request",
      summary: meta(n, "escalation_reason") ?? n.body ?? null,
      jobId: jobId ?? null,
      actions: inline,
      deepLink: meta(n, "deep_link"),
      escalatedBy,
    };
  });

  // ── DECISION items (the ledger) ─────────────────────────────────────────────
  const decided: ApprovalFeedItem[] = decisionRows.map((d) => {
    const job = d.agent_job_id ? jobs.get(d.agent_job_id) : undefined;
    const kind = job?.kind ?? null;
    const { spec, goal, milestone, phase } = enrich(d.id, kind);
    const decidedByLabel =
      d.decided_by === "director"
        ? `${persona(d.routed_to_function)?.name ?? d.routed_to_function}${d.autonomous ? " (autonomous)" : ""}`
        : d.decided_by === "ceo"
          ? `${persona(CEO)?.name ?? "CEO"} (CEO)`
          : "You";
    const title =
      spec?.title || spec?.slug || goal?.title || (kind ? kindLabel(kind) : null) || "Decision";

    return {
      id: d.id,
      source: "decision",
      status: d.decision as FeedStatus,
      escalated: false,
      actionable: false,
      createdAt: d.created_at,
      kind,
      typeLabel: kindLabel(kind),
      raisedBy: persona(d.raised_by_function),
      routedTo: persona(d.routed_to_function),
      decidedByLabel,
      autonomous: d.autonomous,
      spec,
      goal,
      milestone,
      phase,
      title,
      summary: d.reasoning,
      jobId: d.agent_job_id,
      actions: [],
      deepLink: null,
      escalatedBy: null,
    };
  });

  const items = [...pending, ...decided].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const escalatedCount = pending.filter((p) => p.routedTo?.slug === CEO).length;
  return { items, escalatedCount };
}

/** Lightweight count of pending approvals escalated to the human (CEO) — the sidebar badge. */
export async function countEscalatedApprovals(admin: Admin, workspaceId: string): Promise<number> {
  const { data } = await admin
    .from("dashboard_notifications")
    .select("metadata")
    .eq("workspace_id", workspaceId)
    .eq("type", "agent_approval_request")
    .eq("dismissed", false)
    .limit(200);
  let n = 0;
  for (const row of (data ?? []) as { metadata: Record<string, unknown> | null }[]) {
    const routed = row.metadata?.["routed_to_function"];
    if (routed === CEO || routed == null) n++;
  }
  return n;
}
